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
  expect(mockChatReply).toHaveBeenCalledWith(String(projectId), String(chat.id), '你好', userId);
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
