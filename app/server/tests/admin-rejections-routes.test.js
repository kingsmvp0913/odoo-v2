// 意圖：admin 退回原因管理列表——GET 一列一筆退回（含專案名、條目數），POST delete 批次刪除
// （cascade 清 rejection_items）；非 admin 一律 403，非法 ids 400。
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));

process.env.JWT_SECRET = 'test-admin-rej';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken, projectId, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;
  const { rows: [au] } = await dbModule.query("SELECT id FROM users WHERE username='admin'");
  userId = au.id;

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, 'Regular', 'user')",
    [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({ username: 'regular', password: 'pass1234' });
  userToken = userRes.body.token;

  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('列表測試專案','17.0') RETURNING id");
  projectId = p.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

const admin = () => ({ Authorization: `Bearer ${adminToken}` });
const user = () => ({ Authorization: `Bearer ${userToken}` });

async function makeRejection(reason, itemCount = 0) {
  const { rows: [r] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ($1,$2,$3,$4,'classified') RETURNING id",
    ['biz_' + reason, projectId, userId, reason]
  );
  for (let i = 0; i < itemCount; i++) {
    await dbModule.query(
      "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,$2,'其他')",
      [r.id, `item ${i}`]
    );
  }
  return r.id;
}

test('GET /api/admin/rejections：非 admin → 403', async () => {
  const res = await request(app).get('/api/admin/rejections').set(user());
  expect(res.status).toBe(403);
});

test('GET /api/admin/rejections：admin → 一列一筆退回，含專案名與條目數，created_at DESC', async () => {
  const id1 = await makeRejection('原因A', 2);
  const id2 = await makeRejection('原因B', 0);
  const res = await request(app).get('/api/admin/rejections').set(admin());
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.rows)).toBe(true);
  expect(typeof res.body.total).toBe('number');
  const row = res.body.rows.find(r => r.id === id1);
  expect(row).toBeTruthy();
  expect(row.project_name).toBe('列表測試專案');
  expect(row.item_count).toBe(2);
  expect(res.body.rows.find(r => r.id === id2).item_count).toBe(0);
  // DESC：後建的 id2 應排在 id1 之前
  const idxA = res.body.rows.findIndex(r => r.id === id1);
  const idxB = res.body.rows.findIndex(r => r.id === id2);
  expect(idxB).toBeLessThan(idxA);
});

test('POST /api/admin/rejections/delete：非 admin → 403', async () => {
  const res = await request(app).post('/api/admin/rejections/delete').set(user()).send({ ids: [1] });
  expect(res.status).toBe(403);
});

test('POST /api/admin/rejections/delete：非法 ids → 400', async () => {
  const r1 = await request(app).post('/api/admin/rejections/delete').set(admin()).send({ ids: [] });
  expect(r1.status).toBe(400);
  const r2 = await request(app).post('/api/admin/rejections/delete').set(admin()).send({ ids: ['x', 2] });
  expect(r2.status).toBe(400);
});

test('POST /api/admin/rejections/delete：admin 批次刪除，cascade 清 rejection_items', async () => {
  const id1 = await makeRejection('待刪1', 3);
  const id2 = await makeRejection('待刪2', 1);
  const res = await request(app).post('/api/admin/rejections/delete').set(admin()).send({ ids: [id1, id2] });
  expect(res.status).toBe(200);
  expect(res.body.deleted).toBe(2);
  // 撈全部在 JS 端比對，避開 pg-mem 對 SERIAL 的 ANY(int[]) 假綠陷阱
  const { rows: left } = await dbModule.query('SELECT id FROM task_rejections');
  const leftIds = left.map(r => r.id);
  expect(leftIds).not.toContain(id1);
  expect(leftIds).not.toContain(id2);
  const { rows: items } = await dbModule.query('SELECT rejection_id FROM rejection_items');
  const itemParents = items.map(r => r.rejection_id);
  expect(itemParents).not.toContain(id1);
  expect(itemParents).not.toContain(id2);
});
