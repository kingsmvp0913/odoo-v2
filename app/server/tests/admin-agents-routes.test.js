const request = require('supertest');
const { newDb } = require('pg-mem');
const fs = require('fs');
const path = require('path');
const { agentPath } = require('../pipeline/agent-loader');
const CLAUDE_MD = path.join(path.dirname(agentPath('x')), '..', 'CLAUDE.md');

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

process.env.JWT_SECRET = 'test-admin-agents';

let app, dbModule, adminToken, userToken;
let original, originalClaude; // 還原 chat.md / CLAUDE.md，避免測試留下髒檔

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

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, 'Regular', 'user')",
    [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'regular', password: 'pass1234'
  });
  userToken = userRes.body.token;

  original = fs.readFileSync(agentPath('chat'), 'utf8');
  originalClaude = fs.readFileSync(CLAUDE_MD, 'utf8');
}, 30000);

afterAll(() => {
  fs.writeFileSync(agentPath('chat'), original);
  fs.writeFileSync(CLAUDE_MD, originalClaude);
  dbModule._setPoolForTesting(null);
});

test('GET /api/admin/agents → 403 非管理員', async () => {
  const res = await request(app).get('/api/admin/agents')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('GET /api/admin/agents → 管理員取得完整清單', async () => {
  const res = await request(app).get('/api/admin/agents')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const names = res.body.map(a => a.name);
  expect(names).toContain('cs');
  expect(names).toContain('library');
  // 清單不含 prompt body
  expect(res.body[0].prompt).toBeUndefined();
});

test('GET /api/admin/agents/:name → 含 prompt', async () => {
  const res = await request(app).get('/api/admin/agents/cs')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.model).toBe('haiku'); // 健檢 F：cs 降 haiku
  expect(res.body.prompt).toContain('客服');
});

test('PUT /api/admin/agents/:name → 改 model + prompt', async () => {
  const res = await request(app).put('/api/admin/agents/chat')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ model: 'haiku', prompt: '測試提示詞 {{project_name}} {{wiki}} {{history}} {{user_message}}' });
  expect(res.status).toBe(200);
  expect(res.body.model).toBe('haiku');
  expect(res.body.prompt).toContain('測試提示詞');
  // 確認寫回檔案且保留其他 frontmatter
  const raw = fs.readFileSync(agentPath('chat'), 'utf8');
  expect(raw).toContain('label: 對話');
  expect(raw).toContain('測試提示詞');
});

test('PUT 非法 model → 400', async () => {
  const res = await request(app).put('/api/admin/agents/chat')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ model: 'gpt-4' });
  expect(res.status).toBe(400);
});

test('PUT opus / fable → 200（合法 model）', async () => {
  for (const model of ['opus', 'fable']) {
    const res = await request(app).put('/api/admin/agents/chat')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe(model);
  }
});

test('PUT 未知 agent → 404', async () => {
  const res = await request(app).put('/api/admin/agents/nope')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ model: 'sonnet' });
  expect(res.status).toBe(404);
});

test('GET /api/agents/labels → 一般登入即可讀，回中文對照', async () => {
  const res = await request(app).get('/api/agents/labels')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(200);
  expect(res.body.analysis).toBe('分析');
  expect(res.body.wiki).toBe('知識庫');
});

// 意圖：CLAUDE.md 也要能在 Agent 管理列出並編輯（無 model，只有內容）
test('GET /api/admin/agents → 清單置頂含 CLAUDE 全域規則（model 為 null）', async () => {
  const res = await request(app).get('/api/admin/agents')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const claude = res.body.find(a => a.name === 'CLAUDE');
  expect(claude).toBeTruthy();
  expect(claude.model).toBeNull();
});

test('GET /api/admin/agents/CLAUDE → 回 CLAUDE.md 內容', async () => {
  const res = await request(app).get('/api/admin/agents/CLAUDE')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(typeof res.body.prompt).toBe('string');
  expect(res.body.prompt).toContain('CLAUDE.md');
});

test('PUT /api/admin/agents/CLAUDE → 寫入內容', async () => {
  const res = await request(app).put('/api/admin/agents/CLAUDE')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ prompt: '# 測試內容\n改寫規則' });
  expect(res.status).toBe(200);
  expect(res.body.prompt).toContain('測試內容');
  expect(fs.readFileSync(CLAUDE_MD, 'utf8')).toContain('改寫規則');
});
