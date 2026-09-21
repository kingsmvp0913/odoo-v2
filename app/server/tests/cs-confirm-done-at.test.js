// 客服結案路徑（/api/tasks/:id/cs-confirm）把任務改成 done 時必須寫 done_at：
// cron.js 的 autoArchiveDone 以 `done_at IS NOT NULL` 為封存條件，
// token-report-routes.js 的專案品質統計母體是 `t.done_at BETWEEN`。
// 漏寫 done_at 的任務會永遠掛在主列表上，且在成本／品質報表裡隱形。
const request = require('supertest');
const { newDb } = require('pg-mem');
process.env.APP_SECRET = 'test-cs-confirm-appsecret';

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(),
  runDeploy: jest.fn(),
  mergeToAiBranch: jest.fn().mockResolvedValue(undefined),
  AiPushConflictError: class AiPushConflictError extends Error {},
  deleteBranchLocal: jest.fn().mockResolvedValue(undefined),
  removeWorktree: jest.fn().mockResolvedValue(undefined),
  concludeMerge: jest.fn().mockResolvedValue(undefined),
  applyConflictChoices: jest.fn().mockResolvedValue([]),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  AI_BRANCH: 'ai-dev',
  diffNameOnly: jest.fn().mockResolvedValue([]),
  refExists: jest.fn().mockResolvedValue(true),
  findAiMergeCommit: jest.fn().mockResolvedValue(null),
  showBlob: jest.fn().mockResolvedValue(Buffer.from(''))
}));
jest.mock('../pipeline/rebuild-testing', () => ({
  rebuildTesting: jest.fn().mockResolvedValue(null),
  INFLIGHT_DEPLOYED: ['deploy_testing', 'playwright_running', 'review_pending'],
}));
jest.mock('../pipeline/merge-agent', () => ({
  clarifyConflict: jest.fn(),
  DEFAULT_LABELS: { oursLabel: 'a', theirsLabel: 'b' },
  SYNC_LABELS: { oursLabel: 'a', theirsLabel: 'b' }
}));

process.env.JWT_SECRET = 'test-cs-confirm-secret';

let app, dbModule, adminToken, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  adminToken = res.body.token;
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  userId = me.body.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('POST /api/tasks/:id/cs-confirm → 結案時寫入 done_at，任務才會被自動封存並進品質報表', async () => {
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_cs_confirm_done_at', 'cs', '客服結案', 'cs_reply_pending') RETURNING id",
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${task.id}/cs-confirm`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);

  const { rows: [updated] } = await dbModule.query('SELECT status, done_at FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  expect(updated.done_at).toBeTruthy();
});
