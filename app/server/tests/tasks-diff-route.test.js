const request = require('supertest');
const { newDb } = require('pg-mem');

// diff 端點只依賴 getProjectInfo 與 git 的三個函式；其餘保持真實，不影響 app 啟動
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, getProjectInfo: jest.fn() };
});
jest.mock('../pipeline/git', () => {
  const actual = jest.requireActual('../pipeline/git');
  return {
    ...actual,
    refExists: jest.fn(),
    getMainBranch: jest.fn().mockResolvedValue('main'),
    diffBranch: jest.fn()
  };
});

process.env.JWT_SECRET = 'test-diff-secret';

const taskAgent = require('../pipeline/task-agent');
const gitMock = require('../pipeline/git');

let app, dbModule, token, userId;

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
  token = res.body.token;
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  userId = me.body.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  taskAgent.getProjectInfo.mockReset();
  gitMock.refExists.mockReset();
  gitMock.diffBranch.mockReset();
});

async function makeTask({ withProject = false, branch = null } = {}) {
  let projectId = null;
  if (withProject) {
    const { rows: [p] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version) VALUES ('diff 專案" + Date.now() + Math.random() + "', '17.0') RETURNING id"
    );
    projectId = p.id;
  }
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, git_branch)
     VALUES ($1, $2, 'odoo', 'T', 'c', 'review_pending', $3, $4) RETURNING id`,
    [userId, `task_diff_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, projectId, branch]
  );
  return t.id;
}

// 意圖：審核者必須能在 UI 看到本次任務的程式變更，才有審核依據——端點要逐 repo 回 diff
test('有專案分支 → 200 回逐 repo diff', async () => {
  const id = await makeTask({ withProject: true, branch: 'task/x' });
  taskAgent.getProjectInfo.mockResolvedValue({ repos: [{ label: 'main', local_path: '/repos/p/main' }] });
  gitMock.refExists.mockResolvedValue(true);
  gitMock.diffBranch.mockResolvedValue('diff --git a/a.py b/a.py\n+x = 1');

  const res = await request(app).get(`/api/tasks/${id}/diff`).set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.branch).toBe('task/x');
  expect(res.body.repos).toEqual([{ label: 'main', diff: 'diff --git a/a.py b/a.py\n+x = 1', truncated: false }]);
  expect(gitMock.diffBranch).toHaveBeenCalledWith('/repos/p/main', 'main', 'task/x');
});

// 意圖：分支已清理（已核准）的 repo 要標 missing 而非 500，審核歷史頁不因此炸掉
test('分支不存在的 repo → missing 標記', async () => {
  const id = await makeTask({ withProject: true, branch: 'task/gone' });
  taskAgent.getProjectInfo.mockResolvedValue({ repos: [{ label: 'main', local_path: '/repos/p/main' }] });
  gitMock.refExists.mockResolvedValue(false);

  const res = await request(app).get(`/api/tasks/${id}/diff`).set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.repos[0].missing).toBe(true);
  expect(gitMock.diffBranch).not.toHaveBeenCalled();
});

test('無專案分支的任務 → 400', async () => {
  const id = await makeTask();
  const res = await request(app).get(`/api/tasks/${id}/diff`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(400);
});

test('未登入 → 401', async () => {
  const res = await request(app).get('/api/tasks/1/diff');
  expect(res.status).toBe(401);
});
