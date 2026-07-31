const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn().mockResolvedValue(''), stopProjectVpns: jest.fn().mockResolvedValue(undefined) }));

process.env.JWT_SECRET = 'test-mapping';

let app, dbModule, adminToken, userToken, projectId, otherId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  // 第一位＝admin（auth.js setup 慣例）
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin1', password: 'pass1234', display_name: 'Admin' });
  adminToken = setup.body.token;

  // 第二位＝一般使用者，本測試的主角
  await request(app).post('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'bob', password: 'pass1234', display_name: 'Bob', role: 'user' });
  const login = await request(app).post('/api/auth/login').send({ username: 'bob', password: 'pass1234' });
  userToken = login.body.token;

  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${userToken}`)
    .send({ name: 'MapMain', odoo_version: '17.0', description: '原描述' });
  projectId = p.body.id;
  const o = await request(app).post('/api/projects').set('Authorization', `Bearer ${userToken}`)
    .send({ name: 'MapOther', odoo_version: '17.0' });
  otherId = o.body.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('未帶 token → 401', async () => {
  const res = await request(app).patch(`/api/projects/${projectId}/mapping`)
    .send({ odoo_project_name: 'X' });
  expect(res.status).toBe(401);
});

// 這是本端點存在的理由：舊的 PATCH /api/projects/:id 對一般使用者回 403，
// 專案建得起來卻永遠收不到任務。
test('一般使用者可儲存對應 → 200 且值真的寫進去', async () => {
  const res = await request(app).patch(`/api/projects/${projectId}/mapping`)
    .set('Authorization', `Bearer ${userToken}`)
    .send({ odoo_project_name: '甲專案', service_respondent_name: '客服甲' });
  expect(res.status).toBe(200);
  const { rows: [row] } = await dbModule.query(
    'SELECT odoo_project_name, service_respondent_name FROM projects WHERE id = $1', [projectId]);
  expect(row.odoo_project_name).toBe('甲專案');
  expect(row.service_respondent_name).toBe('客服甲');
});

test('來源名稱已被別的專案綁走 → 409，且原值不被覆寫', async () => {
  const res = await request(app).patch(`/api/projects/${otherId}/mapping`)
    .set('Authorization', `Bearer ${userToken}`)
    .send({ odoo_project_name: '甲專案' });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('甲專案');
  const { rows: [row] } = await dbModule.query(
    'SELECT odoo_project_name FROM projects WHERE id = $1', [otherId]);
  expect(row.odoo_project_name).toBeNull();
});

// 安全核心：本端點刻意不掛 requireAdmin，因此絕不能成為改其他欄位的旁門。
test('夾帶其他欄位一律忽略（name／folder_name／e2e_disabled 不得被改）', async () => {
  const { rows: [before] } = await dbModule.query(
    'SELECT name, folder_name, e2e_disabled FROM projects WHERE id = $1', [projectId]);
  const res = await request(app).patch(`/api/projects/${projectId}/mapping`)
    .set('Authorization', `Bearer ${userToken}`)
    .send({ odoo_project_name: '甲專案2', name: '被竄改', folder_name: 'hacked', e2e_disabled: false });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT name, folder_name, e2e_disabled, odoo_project_name FROM projects WHERE id = $1', [projectId]);
  expect(after.name).toBe(before.name);
  expect(after.folder_name).toBe(before.folder_name);
  expect(after.e2e_disabled).toBe(before.e2e_disabled);
  expect(after.odoo_project_name).toBe('甲專案2');
});

// 沿用既有語意：body 帶此鍵才動，允許用空字串明確清空；未帶的鍵整欄不動。
test('只帶一個鍵時另一個欄位不動；空字串可清空', async () => {
  await request(app).patch(`/api/projects/${projectId}/mapping`)
    .set('Authorization', `Bearer ${userToken}`)
    .send({ odoo_project_name: '' });
  const { rows: [row] } = await dbModule.query(
    'SELECT odoo_project_name, service_respondent_name FROM projects WHERE id = $1', [projectId]);
  expect(row.odoo_project_name).toBeNull();
  expect(row.service_respondent_name).toBe('客服甲');
});

test('專案不存在 → 404', async () => {
  const res = await request(app).patch('/api/projects/999999/mapping')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ odoo_project_name: 'X' });
  expect(res.status).toBe(404);
});
