// 意圖：只給「可設定的欄位」會製造錯覺——平台改得了池範圍，改不了 nginx publish 與對外 NAT。
// 故 API 必須同時回傳每個槽的實際狀態（誰在租、宿主綁不綁得起來），讓管理員看得到落差。
const { newDb } = require('pg-mem');
const request = require('supertest');

// isPortFree 會真的去綁宿主的埠；本檔驗的是路由邏輯，不該受執行環境影響（會 flaky）。
jest.mock('../port-alloc', () => {
  const actual = jest.requireActual('../port-alloc');
  return { ...actual, isPortFree: jest.fn().mockResolvedValue(true) };
});

process.env.JWT_SECRET = 'test-port-pool';

let dbModule, app, token, portAlloc;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  portAlloc = require('../port-alloc');
  const { createApp } = require('../index');
  app = createApp();
  const { hashPassword } = require('../password');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('adm',$1,'A','admin')",
    [await hashPassword('pw')]
  );
  const res = await request(app).post('/api/auth/login').send({ username: 'adm', password: 'pw' });
  token = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
  await dbModule.query('DELETE FROM teams_settings');
  portAlloc.isPortFree.mockReset().mockResolvedValue(true);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

test('GET 回傳池範圍與每個槽的狀態', async () => {
  await dbModule.query('INSERT INTO teams_settings (id, port_pool_min, port_pool_max) VALUES (1, 21000, 21002)');
  const res = await request(app).get('/api/admin/port-pool').set(auth());
  expect(res.status).toBe(200);
  expect(res.body.min).toBe(21000);
  expect(res.body.max).toBe(21002);
  expect(res.body.slots.map(s => s.port)).toEqual([21000, 21001, 21002]);
});

test('已租用的槽標 leased 並帶專案名', async () => {
  await dbModule.query('INSERT INTO teams_settings (id, port_pool_min, port_pool_max) VALUES (1, 21000, 21001)');
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('鴻久','17.0') RETURNING id"
  );
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',21000)", [p.id]);
  const res = await request(app).get('/api/admin/port-pool').set(auth());
  const slot = res.body.slots.find(s => s.port === 21000);
  expect(slot.state).toBe('leased');
  expect(slot.project_name).toBe('鴻久');
});

// 意圖：宿主綁不起來的槽要看得見——那通常代表這段埠被別的服務佔了，或根本沒被放行。
test('宿主綁不起來的槽標 blocked', async () => {
  await dbModule.query('INSERT INTO teams_settings (id, port_pool_min, port_pool_max) VALUES (1, 21000, 21001)');
  portAlloc.isPortFree.mockImplementation(async (host, p) => p !== 21001);
  const res = await request(app).get('/api/admin/port-pool').set(auth());
  expect(res.body.slots.find(s => s.port === 21001).state).toBe('blocked');
});

test('PUT 寫入池範圍', async () => {
  const res = await request(app).put('/api/admin/port-pool').set(auth()).send({ min: 21000, max: 21030 });
  expect(res.status).toBe(200);
  const { rows: [s] } = await dbModule.query('SELECT port_pool_min, port_pool_max FROM teams_settings WHERE id=1');
  expect([s.port_pool_min, s.port_pool_max]).toEqual([21000, 21030]);
});

test('min > max → 400，且不寫入', async () => {
  const res = await request(app).put('/api/admin/port-pool').set(auth()).send({ min: 21030, max: 21000 });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT 1 FROM teams_settings WHERE port_pool_min IS NOT NULL');
  expect(rows.length).toBe(0);
});

test('非整數或超出 1-65535 → 400', async () => {
  expect((await request(app).put('/api/admin/port-pool').set(auth()).send({ min: 0, max: 21000 })).status).toBe(400);
  expect((await request(app).put('/api/admin/port-pool').set(auth()).send({ min: 21000, max: 70000 })).status).toBe(400);
  expect((await request(app).put('/api/admin/port-pool').set(auth()).send({ min: 'x', max: 21000 })).status).toBe(400);
});

// 意圖：縮小池範圍會讓已租用但落在新範圍外的環境變成孤兒——擋下來，要求先停掉。
test('縮小範圍會排除到已租用的埠 → 400 並指出是哪個專案', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('CWT','17.0') RETURNING id"
  );
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',21020)", [p.id]);
  const res = await request(app).put('/api/admin/port-pool').set(auth()).send({ min: 21000, max: 21012 });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/CWT/);
});

test('非管理員 → 403', async () => {
  const { hashPassword } = require('../password');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('usr',$1,'U','user')",
    [await hashPassword('pw')]
  );
  const login = await request(app).post('/api/auth/login').send({ username: 'usr', password: 'pw' });
  const res = await request(app).get('/api/admin/port-pool').set({ Authorization: `Bearer ${login.body.token}` });
  expect(res.status).toBe(403);
});
