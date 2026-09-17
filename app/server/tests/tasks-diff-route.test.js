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

// D2：任務物件庫與容器獨占。預設「沒有物件庫」＝跟開關 off 時一樣，完全不動
jest.mock('../lib/agent-objects', () => ({
  objectDirFor: jest.fn(() => '/nonexistent/.agent-objects/x'),
  importTaskObjects: jest.fn(),
  removeTaskObjectDir: jest.fn(async () => {}),
}));
jest.mock('../pipeline/sandbox-run', () => {
  const actual = jest.requireActual('../pipeline/sandbox-run');
  return { ...actual, waitForWorktreeIdle: jest.fn() };
});

process.env.JWT_SECRET = 'test-diff-secret';

const taskAgent = require('../pipeline/task-agent');
const gitMock = require('../pipeline/git');
const objects = require('../lib/agent-objects');
const sandboxRun = require('../pipeline/sandbox-run');
const fsReal = require('fs');
const osReal = require('os');
const pathReal = require('path');

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
  objects.objectDirFor.mockReset().mockReturnValue('/nonexistent/.agent-objects/x');
  objects.importTaskObjects.mockReset();
  sandboxRun.waitForWorktreeIdle.mockReset();
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
  // C-1：diff 基底＝任務切點 ai-dev。用 main 會讓審核者看到其他已核准、尚未回流 main 的任務改動
  // 一起夾在本任務的 diff 裡（第 N 張任務會看到前 N-1 張的全部程式碼）。
  expect(gitMock.diffBranch).toHaveBeenCalledWith('/repos/p/main', 'ai-dev', 'task/x');
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

// 意圖（D2）：AI 在容器裡 commit 的物件要等搬進共用庫，宿主才讀得到任務分支。審核頁不能因此把
// 「AI 還在改」誤報成「分支已清理」——容器還在跑就說在跑；容器已停就先搬再讀；搬不進來（被竄改）要講出來。
describe('D2：任務物件庫', () => {
  let objDir;
  beforeEach(() => {
    objDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'diff-objs-'));
    objects.objectDirFor.mockReturnValue(objDir);
  });
  afterEach(() => fsReal.rmSync(objDir, { recursive: true, force: true }));
  const info = { root: '/repos/p', repos: [{ label: 'main', local_path: '/repos/p/main' }] };

  test('容器還在跑 → 不搬、標 pending=running（不是 missing）', async () => {
    const id = await makeTask({ withProject: true, branch: 'task/x' });
    taskAgent.getProjectInfo.mockResolvedValue(info);
    sandboxRun.waitForWorktreeIdle.mockRejectedValue(Object.assign(new Error('busy'), { code: 'WORKTREE_BUSY' }));
    gitMock.refExists.mockResolvedValue(false);
    const res = await request(app).get(`/api/tasks/${id}/diff`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([{ label: 'main', pending: 'running', diff: '' }]);
    expect(objects.importTaskObjects).not.toHaveBeenCalled();
    expect(sandboxRun.waitForWorktreeIdle.mock.calls[0][1]).toEqual({ timeoutMs: 0 });
  });

  test('容器已停 → 先搬（全部 repo）再照常讀 diff', async () => {
    const id = await makeTask({ withProject: true, branch: 'task/x' });
    taskAgent.getProjectInfo.mockResolvedValue(info);
    sandboxRun.waitForWorktreeIdle.mockResolvedValue();
    const order = [];
    objects.importTaskObjects.mockImplementation(async () => { order.push('import'); });
    gitMock.refExists.mockImplementation(async () => { order.push('ref'); return true; });
    gitMock.diffBranch.mockResolvedValue('+y');
    const res = await request(app).get(`/api/tasks/${id}/diff`).set('Authorization', `Bearer ${token}`);
    expect(res.body.repos).toEqual([{ label: 'main', diff: '+y', truncated: false }]);
    expect(order).toEqual(['import', 'ref']);
    expect(objects.importTaskObjects).toHaveBeenCalledWith({ repoPaths: ['/repos/p/main'], branch: 'task/x' });
  });

  test('搬移失敗（被竄改）→ 標 pending=error，不讀 diff', async () => {
    const id = await makeTask({ withProject: true, branch: 'task/x' });
    taskAgent.getProjectInfo.mockResolvedValue(info);
    sandboxRun.waitForWorktreeIdle.mockResolvedValue();
    objects.importTaskObjects.mockRejectedValue(Object.assign(new Error('壞物件'), { code: 'OBJECTS_TAMPERED' }));
    gitMock.refExists.mockResolvedValue(false);
    const res = await request(app).get(`/api/tasks/${id}/diff`).set('Authorization', `Bearer ${token}`);
    expect(res.body.repos).toEqual([{ label: 'main', pending: 'error', diff: '' }]);
    expect(gitMock.diffBranch).not.toHaveBeenCalled();
  });

  test('分支名不是 task/<id>（舊任務）→ 當作沒有物件庫，照舊', async () => {
    const id = await makeTask({ withProject: true, branch: 'feature/old' });
    taskAgent.getProjectInfo.mockResolvedValue(info);
    objects.objectDirFor.mockImplementation(() => { throw new Error('任務分支名不合法'); });
    gitMock.refExists.mockResolvedValue(false);
    const res = await request(app).get(`/api/tasks/${id}/diff`).set('Authorization', `Bearer ${token}`);
    expect(res.body.repos[0].missing).toBe(true);
    expect(sandboxRun.waitForWorktreeIdle).not.toHaveBeenCalled();
  });
});
