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

// id 沒收斂就直接進 SQL：Postgres 拋型別錯 → catch 包成 500 並把 DB 的英文錯誤原樣回前端。
// 使用者看到看不懂的訊息，內部細節也跟著外流。
describe.each(['read', 'snooze'])('POST /api/inbox/:id/%s → 非數字 id', (action) => {
  test('回 404 而非 500，且不得回傳 DB 錯誤訊息', async () => {
    const res = await request(app).post(`/api/inbox/abc/${action}`)
      .set('Authorization', `Bearer ${token}`).send({ until: new Date(Date.now() + 1000).toISOString() });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/invalid input syntax|integer/i);
  });
});

// 意圖：'action' 是「現在輪到你動手」的召喚，任務一離開等人的狀態就過期了。使用者直接在任務列表
// 把 review_pending 審掉（不經收件匣）是正常工作流，而全 repo 對 user_inbox 沒有任何 DELETE、
// 也沒有 TTL → 沒有這條消解，那筆事件永遠未讀，未讀數只增不減。
describe('任務離開「等人」狀態後，action 事件自動消解', () => {
  let taskId;
  beforeAll(async () => {
    const { rows: [t] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'IB-4','odoo','審核中的任務','review_pending') RETURNING id",
      [myUserId]
    );
    taskId = t.id;
  });

  test('還停在等人的狀態時，事件留在未讀清單（沒有這條，下面那條可能是誤綠）', async () => {
    await mkInbox(myUserId, taskId, 'action', { status: 'review_pending' });
    const res = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
    expect(res.body.filter((r) => r.task_id === taskId)).toHaveLength(1);
  });

  test('任務被審掉（→ done）之後，那筆 action 不再是未讀', async () => {
    const before = await request(app).get('/api/inbox/unread-count').set('Authorization', `Bearer ${token}`);
    await dbModule.query("UPDATE tasks SET status='done' WHERE id=$1", [taskId]);

    const res = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
    expect(res.body.filter((r) => r.task_id === taskId)).toHaveLength(0);

    const after = await request(app).get('/api/inbox/unread-count').set('Authorization', `Bearer ${token}`);
    expect(after.body.count).toBe(before.body.count - 1);   // 未讀數要真的減下來，不只是清單不顯示
  });

  test('bounce 不受影響：它是「發生過什麼」的紀錄，不因狀態改變而失效', async () => {
    const id = await mkInbox(myUserId, taskId, 'bounce', { status: 'coding_running' });
    const res = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
    expect(res.body.map((r) => r.id)).toContain(id);
  });
});

// badge 原本是「取回清單算 length」，而清單有 LIMIT 100 → 未讀破百後數字靜默封頂。
test('GET /api/inbox/unread-count → 未讀破百不被 LIMIT 100 封頂', async () => {
  const before = await request(app).get('/api/inbox/unread-count').set('Authorization', `Bearer ${token}`);
  for (let i = 0; i < 105; i++) await mkInbox(myUserId, myTaskId, 'bounce');

  const list = await request(app).get('/api/inbox').set('Authorization', `Bearer ${token}`);
  expect(list.body).toHaveLength(100);          // 清單本來就封頂，所以不能拿它算數量

  const after = await request(app).get('/api/inbox/unread-count').set('Authorization', `Bearer ${token}`);
  expect(after.body.count).toBe(before.body.count + 105);
  expect(after.body.count).toBeGreaterThan(100);
});

test('GET /api/inbox/unread-count → 401 without token', async () => {
  const res = await request(app).get('/api/inbox/unread-count');
  expect(res.status).toBe(401);
});

// 意圖：不是每個人都經收件匣進任務——從任務列表、從通知、從別人給的連結進來都是常態。
// 那些路徑上原本沒有任何東西會清收件匣：resolveInboxActions 只管 kind='action'，而且只在任務
// 已經離開等人狀態時才消解，'bounce' 完全不在射程內 → 同一張任務永遠掛在未讀清單上。
describe('POST /api/inbox/task/:taskId/read → 進到任務頁就清掉該任務的未讀', () => {
  let taskId, otherTaskOfMine;
  beforeAll(async () => {
    const { rows: [t] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'IB-5','odoo','直接點進去的任務','stopped') RETURNING id",
      [myUserId]
    );
    taskId = t.id;
    const { rows: [t2] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'IB-6','odoo','沒被打開的任務','stopped') RETURNING id",
      [myUserId]
    );
    otherTaskOfMine = t2.id;
  });

  test('該任務的 action 與 bounce 一併已讀（bounce 沒有別的機制會清它）', async () => {
    const a = await mkInbox(myUserId, taskId, 'action', { status: 'stopped' });
    const b1 = await mkInbox(myUserId, taskId, 'bounce');
    const b2 = await mkInbox(myUserId, taskId, 'bounce');

    const res = await request(app).post(`/api/inbox/task/${taskId}/read`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    // 逐筆問而不是 `id = ANY($1::int[])`：pg-mem 對有索引的欄位會靜默回 0 列（testing 規則 12），
    // 那樣的空結果會讓下面的迴圈一次都沒跑到，變成永遠綠的假測試。
    for (const id of [a, b1, b2]) {
      const { rows: [r] } = await dbModule.query('SELECT read_at FROM user_inbox WHERE id=$1', [id]);
      expect(r.read_at).not.toBeNull();
    }
  });

  test('只清這一張任務的，別張任務的未讀不受影響', async () => {
    const untouched = await mkInbox(myUserId, otherTaskOfMine, 'bounce');
    await request(app).post(`/api/inbox/task/${taskId}/read`).set('Authorization', `Bearer ${token}`);

    const { rows: [row] } = await dbModule.query('SELECT read_at FROM user_inbox WHERE id=$1', [untouched]);
    expect(row.read_at).toBeNull();
  });

  // 鑑別力：故意用「同一張任務、但屬於別人」的列——只比對 task_id 而漏掉 user_id 的實作
  // 會把別人的收件匣一起標掉，而那種寫法在上面那些案例裡全都是綠的。
  test('別人在同一張任務上的未讀不得被動到', async () => {
    const foreign = await mkInbox(otherUserId, taskId, 'action');
    await request(app).post(`/api/inbox/task/${taskId}/read`).set('Authorization', `Bearer ${token}`);

    const { rows: [row] } = await dbModule.query('SELECT read_at FROM user_inbox WHERE id=$1', [foreign]);
    expect(row.read_at).toBeNull();
  });

  // 任務頁每次載入都會打這支，沒東西可清是常態而不是錯誤——回 404 會讓前端天天吞例外。
  test('沒有未讀列也回 200', async () => {
    const res = await request(app).post(`/api/inbox/task/${otherTaskOfMine}/read`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const again = await request(app).post(`/api/inbox/task/${otherTaskOfMine}/read`).set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(200);
  });

  test('非數字 taskId 回 404 而非 500，且不得回傳 DB 錯誤訊息（教程的假任務 id 會走到這裡）', async () => {
    const res = await request(app).post('/api/inbox/task/demo/read').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/invalid input syntax|integer/i);
  });

  test('401 without token', async () => {
    const res = await request(app).post(`/api/inbox/task/${taskId}/read`);
    expect(res.status).toBe(401);
  });
});
