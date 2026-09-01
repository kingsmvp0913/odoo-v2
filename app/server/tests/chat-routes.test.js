const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

const mockChatReply = jest.fn();
jest.mock('../pipeline/chat-agent', () => ({ chatReply: mockChatReply }));

const mockDraftTask = jest.fn();
jest.mock('../pipeline/chat-to-task', () => ({ draftTaskFromChat: (...a) => mockDraftTask(...a) }));

const mockEmitToUser = jest.fn();
jest.mock('../notify', () => ({
  emitToUser: (...a) => mockEmitToUser(...a),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));

let dbModule, app;
let userId, projectId, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('chatuser', $1, 'Chat') RETURNING id",
    [hash]
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('ChatProj', '17.0') RETURNING id"
  );
  projectId = proj.id;

  const expressApp = express();
  expressApp.use(express.json());
  const { registerRoutes } = require('../chat-routes');
  registerRoutes(expressApp);
  app = expressApp;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { mockChatReply.mockReset(); mockEmitToUser.mockReset(); mockDraftTask.mockReset(); });

const auth = () => ({ Authorization: `Bearer ${token}` });

test('GET chats → empty list initially', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('GET chats/sidebar-projects → 只回傳有訊息的 Chat metadata，不回傳內容', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '有訊息', $2) RETURNING id",
    [projectId, userId]
  );
  await dbModule.query(
    "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, 'user', '不能外洩')",
    [chat.id]
  );
  const res = await request(app).get('/api/chats/sidebar-projects').set(auth());
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining({ project_id: projectId, chat_id: chat.id, title: '有訊息' })]));
  expect(res.body[0]).not.toHaveProperty('content');
});

test('POST chats → creates with title', async () => {
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats`)
    .set(auth()).send({ title: '測試對話' });
  expect(res.status).toBe(201);
  expect(res.body.title).toBe('測試對話');
  expect(res.body.id).toBeTruthy();
});

test('POST chats → defaults title to 新對話', async () => {
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats`)
    .set(auth()).send({});
  expect(res.status).toBe(201);
  expect(res.body.title).toBe('新對話');
});

test('GET chats → lists created chats', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(res.body.length).toBeGreaterThanOrEqual(2);
});

// #3：GET chats 帶 reply_pending，前端據此顯示持續動畫（離開再回來仍在）。預設 false；設 true 要能反映。
test('GET chats → 每筆帶 reply_pending，反映後端旗標', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id, reply_pending) VALUES ($1, '進行中', $2, true) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  const row = res.body.find(c => c.id === chat.id);
  expect(row).toBeTruthy();
  expect(row.reply_pending).toBe(true);
  // 其他既有對話預設 false
  expect(res.body.some(c => c.reply_pending === false)).toBe(true);
});

test('GET messages → empty for new chat', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '空對話', $2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .get(`/api/projects/${projectId}/chats/${chat.id}/messages`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

test('POST messages → calls chatReply and returns reply', async () => {
  mockChatReply.mockResolvedValueOnce('AI 的回覆');
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '問答', $2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '你好' });
  expect(res.status).toBe(200);
  expect(res.body.reply).toBe('AI 的回覆');
  // 第 6 個參數是中止句柄：沒有它「停止回覆」就砍不到正在跑的 agent 行程，
  // 停止鈕只會關掉前端動畫、token 照燒。
  expect(mockChatReply).toHaveBeenCalledWith(String(projectId), String(chat.id), '你好', userId, [], expect.any(AbortSignal));
});

test('POST messages → emits chat:reply socket event to owner', async () => {
  mockChatReply.mockResolvedValueOnce('reply');
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '通知測試', $2) RETURNING id",
    [projectId, userId]
  );
  await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '測試通知' });
  expect(mockEmitToUser).toHaveBeenCalledWith(userId, 'chat:reply', {
    projectId: Number(projectId),
    chatId: Number(chat.id)
  });
});

test('POST messages → 400 if content empty', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '空', $2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '   ' });
  expect(res.status).toBe(400);
});

test('PUT chat → 改標題', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '舊標題', $2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .put(`/api/projects/${projectId}/chats/${chat.id}`).set(auth()).send({ title: '  新標題  ' });
  expect(res.status).toBe(200);
  expect(res.body.title).toBe('新標題');
  const { rows } = await dbModule.query('SELECT title FROM project_chats WHERE id = $1', [chat.id]);
  expect(rows[0].title).toBe('新標題');
});

// 空白不能悄悄變成「新對話」：那樣使用者以為改名成功，回頭看到的卻是另一個字。
test('PUT chat → 標題空白回 400 且不動到原標題', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '原標題', $2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .put(`/api/projects/${projectId}/chats/${chat.id}`).set(auth()).send({ title: '   ' });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT title FROM project_chats WHERE id = $1', [chat.id]);
  expect(rows[0].title).toBe('原標題');
});

// 授權要比照 delete：能改別人的對話等於誰都能竄改別人的紀錄。
test('PUT chat → 改不到別人的對話', async () => {
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('renamer','x','Other') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'別人的標題',$2) RETURNING id",
    [projectId, other.id]
  );
  const res = await request(app)
    .put(`/api/projects/${projectId}/chats/${chat.id}`).set(auth()).send({ title: '我改的' });
  expect(res.status).toBe(404);
  const { rows } = await dbModule.query('SELECT title FROM project_chats WHERE id = $1', [chat.id]);
  expect(rows[0].title).toBe('別人的標題');
});

test('DELETE chat → removes it', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '要刪', $2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .delete(`/api/projects/${projectId}/chats/${chat.id}`).set(auth());
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT id FROM project_chats WHERE id = $1', [chat.id]);
  expect(rows.length).toBe(0);
});

test('401 without token', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/chats`);
  expect(res.status).toBe(401);
});

test('GET chats → 只回自己的 chat', async () => {
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('other','x','Other') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'別人的',$2)",
    [projectId, other.id]
  );
  const res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.every(c => c.title !== '別人的')).toBe(true);
});

test('GET messages → 他人 chat 回 404', async () => {
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('other2','x','Other2') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'X',$2) RETURNING id",
    [projectId, other.id]
  );
  const res = await request(app)
    .get(`/api/projects/${projectId}/chats/${chat.id}/messages`).set(auth());
  expect(res.status).toBe(404);
});

test('POST draft-task → 回摘要草稿（不建任務）', async () => {
  mockDraftTask.mockResolvedValueOnce({ title: '金額算錯', original_text: '正式區某單金額算錯' });
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'轉任務',$2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/draft-task`).set(auth()).send({});
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ title: '金額算錯', original_text: '正式區某單金額算錯' });
  expect(mockDraftTask).toHaveBeenCalledWith(String(projectId), String(chat.id), userId);
});

test('POST draft-task → 他人 chat 回 404 且不呼叫摘要', async () => {
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('other3','x','O3') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'別人的轉任務',$2) RETURNING id",
    [projectId, other.id]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/draft-task`).set(auth()).send({});
  expect(res.status).toBe(404);
  expect(mockDraftTask).not.toHaveBeenCalled();
});

test('POST draft-task → 摘要層丟 status 錯誤時照該 status 回', async () => {
  const err = new Error('對話沒有內容可摘要'); err.status = 400;
  mockDraftTask.mockRejectedValueOnce(err);
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'空轉',$2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/draft-task`).set(auth()).send({});
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('對話沒有內容可摘要');
});

test('POST draft-task → 401 無 token', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/chats/1/draft-task`).send({});
  expect(res.status).toBe(401);
});

test('GET /api/chats/unread → 回本人跨專案未讀 map', async () => {
  // 另建專案避開其他測試在 projectId 留下的殘留未讀（rule 17：表不清空）
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('UnreadAgg', '17.0') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'A',$2) RETURNING id",
    [proj.id, userId]
  );
  await dbModule.query(
    "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'user','q'),($1,'ai','a1'),($1,'ai','a2')",
    [chat.id]
  );
  const res = await request(app).get('/api/chats/unread').set(auth());
  expect(res.status).toBe(200);
  expect(res.body.byProject[String(proj.id)]).toBe(2);
});

test('GET /api/chats/unread → 不計入他人 chat 的未讀', async () => {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('UnreadAggOther', '17.0') RETURNING id"
  );
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('unreadother','x','UO') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'B',$2) RETURNING id",
    [proj.id, other.id]
  );
  await dbModule.query(
    "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'ai','x')",
    [chat.id]
  );
  const res = await request(app).get('/api/chats/unread').set(auth());
  expect(res.status).toBe(200);
  expect(res.body.byProject[String(proj.id)]).toBeUndefined();
});

test('GET /api/chats/unread → 401 無 token', async () => {
  const res = await request(app).get('/api/chats/unread');
  expect(res.status).toBe(401);
});

test('unread：AI 訊息未讀計入，read 後歸零', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'U',$2) RETURNING id",
    [projectId, userId]
  );
  await dbModule.query(
    "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'user','hi'),($1,'ai','yo')",
    [chat.id]
  );
  let res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  const found = res.body.find(c => c.id === chat.id);
  expect(Number(found.unread)).toBe(1);

  res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/read`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.projectUnread).toBe(0);

  res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(Number(res.body.find(c => c.id === chat.id).unread)).toBe(0);
});

// 「停止回覆」的價值全在於它真的砍得到跑在 agent 那頭的行程。只清 reply_pending 而不 abort，
// 畫面會回到可輸入狀態、被取消的那輪卻繼續跑到底照燒 token，而且沒有任何徵狀。
test('POST stop → aborts the in-flight reply signal', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'可取消',$2) RETURNING id",
    [projectId, userId]
  );
  let captured = null;
  mockChatReply.mockImplementationOnce((...args) => {
    captured = args[5];
    return new Promise((resolve) => captured.addEventListener('abort', () => resolve('已中止')));
  });

  // ⚠ 一定要接 .then() 才會真的發出去——supertest 的 Test 是 lazy 的，只 build 不 await
  // 會讓下面等 captured 的迴圈永遠轉不出來（整支測試 timeout，而且錯誤完全不指向這裡）。
  const inFlight = request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '會被取消的提問' }).then((r) => r);
  for (let i = 0; i < 200 && !captured; i++) await new Promise((r) => setTimeout(r, 5));
  expect(captured).toBeTruthy();

  const stop = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/stop`).set(auth());
  expect(stop.status).toBe(200);
  expect(stop.body.stopped).toBe(true);
  expect(captured.aborted).toBe(true);
  await inFlight;
});

// 沒有正在跑的回覆時不能假裝成功——前端據此判斷要不要把畫面切回可輸入。
test('POST stop → stopped:false when nothing is running', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'閒置',$2) RETURNING id",
    [projectId, userId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/stop`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.stopped).toBe(false);
});

// 別人的對話不得停：chats 是 per-user 資料，端點一律用 getOwnedChat 限縮。
test('POST stop → 404 for a chat owned by someone else', async () => {
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('chatstopper', 'x', 'Other') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'別人的',$2) RETURNING id",
    [projectId, other.id]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/stop`).set(auth());
  expect(res.status).toBe(404);
});
