const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

const mockChatReply = jest.fn();
jest.mock('../pipeline/chat-agent', () => ({ chatReply: mockChatReply }));

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
beforeEach(() => { mockChatReply.mockReset(); });

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
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '空對話') RETURNING id", [projectId]
  );
  const res = await request(app)
    .get(`/api/projects/${projectId}/chats/${chat.id}/messages`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

test('POST messages → calls chatReply and returns reply', async () => {
  mockChatReply.mockResolvedValueOnce('AI 的回覆');
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '問答') RETURNING id", [projectId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '你好' });
  expect(res.status).toBe(200);
  expect(res.body.reply).toBe('AI 的回覆');
  expect(mockChatReply).toHaveBeenCalledWith(String(projectId), String(chat.id), '你好');
});

test('POST messages → 400 if content empty', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '空') RETURNING id", [projectId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '   ' });
  expect(res.status).toBe(400);
});

test('DELETE chat → removes it', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '要刪') RETURNING id", [projectId]
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
