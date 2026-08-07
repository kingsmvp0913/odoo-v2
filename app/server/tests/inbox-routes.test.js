// 意圖：收件匣是「發生過什麼」的事件流，用來讓鬼打牆的任務在第二次退回就被看見。
// 這支守兩件事：(1) 預設只回還沒處理的（未讀且未 snooze），否則收件匣會被歷史淹掉失去意義；
// (2) 授權是「只動自己的資料」——別人的項目一律看不到也改不動。
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-inbox-secret';

let app, dbModule, token, myUserId, otherUserId, myTaskId, otherTaskId;

async function mkInbox(userId, taskId, kind, extra = {}) {
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO user_inbox (user_id, task_id, kind, status, summary, read_at, snoozed_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [userId, taskId, kind, extra.status || null, extra.summary || null,
     extra.read_at || null, extra.snoozed_until || null]
  );
  return r.id;
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'inboxadmin', password: 'password123', display_name: '收件匣管理員'
  });
  token = res.body.token;
  const { rows: [me] } = await dbModule.query("SELECT id FROM users WHERE username='inboxadmin'");
  myUserId = me.id;

  // 另一個使用者＋各自的任務（user_inbox 有 users／tasks 兩個 FK，父列要先建）
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('other','h','別人') RETURNING id"
  );
  otherUserId = other.id;
  const { rows: [t1] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'IB-1','odoo','我的任務','review_pending') RETURNING id",
    [myUserId]
  );
  myTaskId = t1.id;
  const { rows: [t2] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'IB-2','odoo','別人的任務','stopped') RETURNING id",
    [otherUserId]
  );
  otherTaskId = t2.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/inbox → 401 without token', async () => {
  const res = await request(app).get('/api/inbox');
  expect(res.status).toBe(401);
});

test('GET /api/inbox → 只回自己的，且帶得出任務標題（點進去要知道是哪張）', async () => {
  await mkInbox(myUserId, myTaskId, 'action', { status: 'review_pending', summary: '我的任務' });
  await mkInbox(otherUserId, otherTaskId, 'action', { status: 'stopped', summary: '別人的任務' });

  const res = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].kind).toBe('action');
  expect(res.body[0].task_ref).toBe('IB-1');
  expect(res.body[0].title).toBe('我的任務');
});

// 預設清單若把已讀與 snooze 的一起回，收件匣會被歷史淹掉——那就退化成另一個任務列表了。
test('GET /api/inbox → 已讀的不出現在預設清單，?all=1 才看得到', async () => {
  const readId = await mkInbox(myUserId, myTaskId, 'bounce', { read_at: new Date().toISOString() });

  const def = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
  expect(def.body.map((r) => r.id)).not.toContain(readId);

  const all = await request(app).get('/api/inbox?all=1').set('Authorization', `Bearer ${token}`);
  expect(all.body.map((r) => r.id)).toContain(readId);
});

test('GET /api/inbox → snooze 到未來的不出現，?all=1 才看得到', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const snoozedId = await mkInbox(myUserId, myTaskId, 'bounce', { snoozed_until: future });

  const def = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
  expect(def.body.map((r) => r.id)).not.toContain(snoozedId);

  const all = await request(app).get('/api/inbox?all=1').set('Authorization', `Bearer ${token}`);
  expect(all.body.map((r) => r.id)).toContain(snoozedId);
});

test('POST /api/inbox/:id/read → 標記已讀，重複點不報錯', async () => {
  const id = await mkInbox(myUserId, myTaskId, 'action');
  const first = await request(app).post(`/api/inbox/${id}/read`).set('Authorization', `Bearer ${token}`);
  expect(first.status).toBe(200);
  // 重複點同一則不該跳錯誤（使用者連點兩下是常態）
  const second = await request(app).post(`/api/inbox/${id}/read`).set('Authorization', `Bearer ${token}`);
  expect(second.status).toBe(200);

  const { rows: [row] } = await dbModule.query('SELECT read_at FROM user_inbox WHERE id=$1', [id]);
  expect(row.read_at).not.toBeNull();
});

test('POST /api/inbox/:id/read → 別人的項目回 404（資料範圍限縮即防護）', async () => {
  const foreign = await mkInbox(otherUserId, otherTaskId, 'action');
  const res = await request(app).post(`/api/inbox/${foreign}/read`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);

  const { rows: [row] } = await dbModule.query('SELECT read_at FROM user_inbox WHERE id=$1', [foreign]);
  expect(row.read_at).toBeNull();   // 沒被動到
});

test('POST /api/inbox/read-all → 自己的全部已讀，別人的不受影響', async () => {
  await mkInbox(myUserId, myTaskId, 'bounce');
  const foreign = await mkInbox(otherUserId, otherTaskId, 'bounce');

  const res = await request(app).post('/api/inbox/read-all').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);

  const mine = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
  expect(mine.body).toEqual([]);
  const { rows: [row] } = await dbModule.query('SELECT read_at FROM user_inbox WHERE id=$1', [foreign]);
  expect(row.read_at).toBeNull();
});

test('POST /api/inbox/:id/snooze → 延後後不出現在預設清單', async () => {
  const id = await mkInbox(myUserId, myTaskId, 'action');
  const until = new Date(Date.now() + 3600_000).toISOString();
  const res = await request(app).post(`/api/inbox/${id}/snooze`)
    .set('Authorization', `Bearer ${token}`).send({ until });
  expect(res.status).toBe(200);

  const list = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
  expect(list.body.map((r) => r.id)).not.toContain(id);
});

test('POST /api/inbox/:id/snooze → until 無效回 400', async () => {
  const id = await mkInbox(myUserId, myTaskId, 'action');
  const res = await request(app).post(`/api/inbox/${id}/snooze`)
    .set('Authorization', `Bearer ${token}`).send({ until: '不是時間' });
  expect(res.status).toBe(400);
});

test('POST /api/inbox/:id/snooze → 別人的項目回 404', async () => {
  const foreign = await mkInbox(otherUserId, otherTaskId, 'action');
  const res = await request(app).post(`/api/inbox/${foreign}/snooze`)
    .set('Authorization', `Bearer ${token}`).send({ until: new Date(Date.now() + 1000).toISOString() });
  expect(res.status).toBe(404);
});
