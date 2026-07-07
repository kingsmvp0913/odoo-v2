const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));

process.env.JWT_SECRET = 'test-token-report';

let app, dbModule, adminToken, userToken, adminUserId, regularUserId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  // Create admin via setup endpoint
  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin_tr', password: 'admin1234', display_name: 'Admin TR'
  });
  adminToken = adminRes.body.token;
  const { rows: [admin] } = await dbModule.query("SELECT id FROM users WHERE username='admin_tr'");
  adminUserId = admin.id;

  // Create regular user
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  const { rows: [regular] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular_tr', $1, 'Regular TR', 'user') RETURNING id",
    [hash]
  );
  regularUserId = regular.id;
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'regular_tr', password: 'pass1234'
  });
  userToken = userRes.body.token;

  // Insert token_usage records
  // Record for admin
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ('task_odoo_1', $1, 'coding', 100, 50, 10, 5, 'server')`,
    [adminUserId]
  );
  // Record for regular user
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ('task_odoo_2', $1, 'qa', 200, 80, 20, 0, 'server')`,
    [regularUserId]
  );
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/token-report → 401 without token', async () => {
  const res = await request(app).get('/api/token-report');
  expect(res.status).toBe(401);
});

test('GET /api/token-report → 200 for regular user (own data only)', async () => {
  const res = await request(app)
    .get('/api/token-report')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('summary');
  expect(res.body).toHaveProperty('by_agent');
  expect(res.body).toHaveProperty('by_project');
  expect(res.body).toHaveProperty('daily');
  expect(res.body).toHaveProperty('tasks');
  // Regular user sees only their own record: task_odoo_2 has 200+80+20+0=300 tokens
  expect(res.body.summary.total_tokens).toBe(300);
  expect(Array.isArray(res.body.by_agent)).toBe(true);
  expect(Array.isArray(res.body.tasks)).toBe(true);
});

test('GET /api/token-report → 200 for admin (own data only without ?all=true)', async () => {
  const res = await request(app)
    .get('/api/token-report')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  // Admin without ?all=true sees only own data: task_odoo_1 has 100+50+10+5=165 tokens
  expect(res.body.summary.total_tokens).toBe(165);
});

test('GET /api/token-report?all=true → 200 for admin (all users data)', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  // Both records: 165 + 300 = 465 tokens
  expect(res.body.summary.total_tokens).toBe(465);
  expect(res.body.tasks.length).toBe(2);
});

test('GET /api/token-report?all=true → regular user cannot see all (ignored)', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(200);
  // Non-admin: ?all=true is ignored; sees only own 300 tokens
  expect(res.body.summary.total_tokens).toBe(300);
});

test('GET /api/token-report → summary shape is correct', async () => {
  const res = await request(app)
    .get('/api/token-report')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const { summary, by_agent, by_project, daily, tasks } = res.body;
  expect(typeof summary.total_tokens).toBe('number');
  expect(typeof summary.total_tasks).toBe('number');
  expect(typeof summary.avg_tokens_per_task).toBe('number');
  expect(Array.isArray(by_agent)).toBe(true);
  expect(Array.isArray(by_project)).toBe(true);
  expect(Array.isArray(daily)).toBe(true);
  expect(Array.isArray(tasks)).toBe(true);
});

test('GET /api/token-report?task_id=task_odoo_1 → filters by task_id', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true&task_id=task_odoo_1')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.summary.total_tokens).toBe(165);
  expect(res.body.tasks.length).toBe(1);
  expect(res.body.tasks[0].task_id).toBe('task_odoo_1');
});

test('GET /api/token-report → by_agent has correct shape', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.by_agent.length).toBeGreaterThan(0);
  for (const entry of res.body.by_agent) {
    expect(typeof entry.agent_type).toBe('string');
    expect(typeof entry.tokens).toBe('number');
  }
});

test('chat token_usage groups per chat_id with chat title; orphan task/chat marked deleted', async () => {
  // 建一個專案與對話，chat token 記錄帶 chat_id → 應以對話標題呈現、可連結
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TR 專案', '17.0') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '報價單問題') RETURNING id",
    [proj.id]
  );
  await dbModule.query(
    `INSERT INTO token_usage (project_id, chat_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ($1, $2, $3, 'chat', 10, 10, 0, 0, 'server')`,
    [proj.id, chat.id, adminUserId]
  );
  // 孤兒任務：task_id 有值但 tasks 無此列（模擬任務被刪除後殘留的 token 記錄）
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ('manual_deleted_1', $1, 'coding', 5, 5, 0, 0, 'server')`,
    [adminUserId]
  );
  // 孤兒對話：chat_id 指向不存在的 project_chats（模擬對話被刪除）
  await dbModule.query(
    `INSERT INTO token_usage (project_id, chat_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ($1, 999999, $2, 'chat', 7, 7, 0, 0, 'server')`,
    [proj.id, adminUserId]
  );

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);

  const chatRow = res.body.tasks.find(t => t.kind === 'chat' && t.chat_id === chat.id);
  expect(chatRow).toBeTruthy();
  expect(chatRow.title).toBe('報價單問題');
  expect(chatRow.deleted).toBe(false);
  expect(chatRow.linkable).toBe(true);

  // 對話被刪除 → 標示 deleted、不可連結
  const deletedChat = res.body.tasks.find(t => t.kind === 'chat' && t.chat_id === 999999);
  expect(deletedChat).toBeTruthy();
  expect(deletedChat.deleted).toBe(true);
  expect(deletedChat.linkable).toBe(false);

  const orphan = res.body.tasks.find(t => t.task_id === 'manual_deleted_1');
  expect(orphan).toBeTruthy();
  expect(orphan.kind).toBe('task');
  expect(orphan.deleted).toBe(true);
  expect(orphan.linkable).toBe(false);
});

test('GET /api/token-report → tasks have agents array', async () => {
  const res = await request(app)
    .get('/api/token-report')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(200);
  expect(res.body.tasks.length).toBe(1);
  const task = res.body.tasks[0];
  expect(Array.isArray(task.agents)).toBe(true);
  expect(task.agents[0].agent_type).toBe('qa');
  expect(task.agents[0].tokens).toBe(300);
});
