const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
// runner 全 mock：由測試控制 getInflightInfo（誰真正在飛）與 abortTask（是否被觸發）
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }),
  getInflightTaskIds: jest.fn().mockReturnValue([]),
  getInflightInfo: jest.fn().mockReturnValue([]),
  abortTask: jest.fn(),
  whenIdle: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));

process.env.JWT_SECRET = 'test-admin-pipeline';

const runner = require('../pipeline/runner');

let app, dbModule, adminToken, userToken;
let adminId, userId, projectId, taskA, taskB;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  // 第一位使用者＝admin（auth.js setup 慣例）
  const setup = await request(app).post('/api/auth/setup').send({ username: 'admin1', password: 'pass1234', display_name: 'Admin' });
  adminToken = setup.body.token;
  ({ rows: [{ id: adminId }] } = await dbModule.query("SELECT id FROM users WHERE username='admin1'"));

  // 第二位使用者＝一般（用來驗證 admin-gate 與跨使用者顯示）
  await request(app).post('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'bob', password: 'pass1234', display_name: 'Bob', role: 'user' });
  const login = await request(app).post('/api/auth/login').send({ username: 'bob', password: 'pass1234' });
  userToken = login.body.token;
  ({ rows: [{ id: userId }] } = await dbModule.query("SELECT id FROM users WHERE username='bob'"));

  const proj = await request(app).post('/api/projects').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'ProjA', odoo_version: '17.0', description: 'p' });
  projectId = proj.body.id;

  // 兩位使用者各一個任務（跨使用者）
  ({ rows: [{ id: taskA }] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'A-1','manual','任務A','coding_running',$2) RETURNING id",
    [adminId, projectId]
  ));
  ({ rows: [{ id: taskB }] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'B-1','manual','任務B','qa_running',$2) RETURNING id",
    [userId, projectId]
  ));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  runner.getInflightInfo.mockReset();
  runner.abortTask.mockReset();
});

describe('GET /api/admin/pipeline/active', () => {
  test('401 without token', async () => {
    const res = await request(app).get('/api/admin/pipeline/active');
    expect(res.status).toBe(401);
  });

  test('403 for non-admin', async () => {
    runner.getInflightInfo.mockReturnValue([]);
    const res = await request(app).get('/api/admin/pipeline/active').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  test('回空陣列 when 沒有任何真正在飛的任務（不撈 status）', async () => {
    runner.getInflightInfo.mockReturnValue([]);
    const res = await request(app).get('/api/admin/pipeline/active').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('跨使用者列出在飛任務，含專案/使用者/階段/執行時間，依執行最久在最上排序', async () => {
    const now = Date.now();
    // taskB 開始較早 → elapsed 較大 → 應排在最上（跨到別的使用者）
    runner.getInflightInfo.mockReturnValue([
      { taskId: taskA, userId: adminId, startedAt: now - 60000 },
      { taskId: taskB, userId: userId, startedAt: now - 300000 }
    ]);
    const res = await request(app).get('/api/admin/pipeline/active').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map(r => r.id)).toEqual([taskB, taskA]); // 最久在最上

    const b = res.body[0];
    expect(b.project_name).toBe('ProjA');
    expect(b.username).toBe('bob');
    expect(b.status).toBe('qa_running');
    expect(b.elapsed_ms).toBeGreaterThanOrEqual(300000);
    expect(res.body[1].username).toBe('admin1'); // 確實跨使用者
  });

  test('只回 getInflightInfo 名單內的任務（status=*_running 但不在飛者不出現）', async () => {
    runner.getInflightInfo.mockReturnValue([{ taskId: taskA, userId: adminId, startedAt: Date.now() - 1000 }]);
    const res = await request(app).get('/api/admin/pipeline/active').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.map(r => r.id)).toEqual([taskA]);
  });
});

describe('POST /api/admin/pipeline/tasks/:id/pause', () => {
  test('403 for non-admin（且不觸發 abort）', async () => {
    const res = await request(app).post(`/api/admin/pipeline/tasks/${taskB}/pause`).set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
    expect(runner.abortTask).not.toHaveBeenCalled();
  });

  test('404 for 不存在的 id', async () => {
    const res = await request(app).post('/api/admin/pipeline/tasks/999999/pause').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(runner.abortTask).not.toHaveBeenCalled();
  });

  test('admin 可暫停他人任務：is_paused=true 且確實觸發 abortTask（非只改旗標）', async () => {
    const res = await request(app).post(`/api/admin/pipeline/tasks/${taskB}/pause`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // 關鍵差異：跨 owner（taskB 屬於 bob，操作者是 admin）仍生效
    const { rows: [t] } = await dbModule.query('SELECT is_paused FROM tasks WHERE id = $1', [taskB]);
    expect(t.is_paused).toBe(true);
    // 關鍵差異：真的中止行程，而不是只改 DB 旗標
    expect(runner.abortTask).toHaveBeenCalledWith(String(taskB));
  });
});
