const request = require('supertest');
const { newDb } = require('pg-mem');

// runClaude 全域 mock：用來證明提交這條路徑一個 agent 都不會叫
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));

process.env.JWT_SECRET = 'test-feedback';

let app, dbModule, userToken, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  // admin：走 /api/auth/setup 拿 token（不要自己簽 token——會繞過真實授權路徑）
  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;

  // 一般使用者：INSERT 後走 /api/auth/login
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
});

beforeEach(() => mockRunClaude.mockClear());

afterAll(() => {
  dbModule._setPoolForTesting(null);
});

test('任何登入使用者都能提意見', async () => {
  const res = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`)
    .field('content', '任務頂欄的按鈕上下沒留白');
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT status, content FROM feedback WHERE id=$1', [res.body.id]);
  expect(rows[0]).toMatchObject({ status: 'new', content: '任務頂欄的按鈕上下沒留白' });
});

test('提交時一個 agent 都不會被呼叫', async () => {
  await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`)
    .field('content', '另一件事');
  // ⚠ 這條是成本洞的迴歸測試：triage 一旦被搬回提交時機，任何登入使用者
  //   都能單方面觸發無上限的 opus 成本。看到這裡紅了不要放寬它，去看是誰把 AI 搬回來了。
  expect(mockRunClaude).not.toHaveBeenCalled();
});

test('空內容退 400', async () => {
  const res = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '   ');
  expect(res.status).toBe(400);
});

test('一般使用者打管理端點回 403', async () => {
  const res = await request(app).get('/api/admin/feedback')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('管理員核准會記下是誰、什麼時候', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '要核准的');
  const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'approved' });
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query(
    'SELECT status, decided_by, decided_at FROM feedback WHERE id=$1', [body.id]);
  expect(rows[0].status).toBe('approved');
  expect(rows[0].decided_by).not.toBeNull();
  expect(rows[0].decided_at).not.toBeNull();
});

test('不認得的 status 退 400', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', 'x');
  const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'done' });
  expect(res.status).toBe(400);   // done 只能由夜間批次寫，不開放人工設
});
