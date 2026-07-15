const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

// git 層 mock（比照 merge-agent.test）；衝突檔不存在於磁碟時 resolveConflict 會自然回 false。
jest.mock('../pipeline/git', () => ({
  revParse: jest.fn().mockResolvedValue('oldsha'),
  resetTestingToMain: jest.fn().mockResolvedValue(undefined),
  resetTestingTo: jest.fn().mockResolvedValue(undefined),
  mergeInto: jest.fn(),
  commitAll: jest.fn().mockResolvedValue(undefined),
  abortMerge: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));

let dbModule, rebuildMod, gitMock, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('r','h','R','user') RETURNING id"
  );
  userId = rows[0].id;
  gitMock = require('../pipeline/git');
  rebuildMod = require('../pipeline/rebuild-testing');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  for (const k of ['revParse', 'resetTestingToMain', 'resetTestingTo', 'mergeInto', 'commitAll', 'abortMerge']) {
    gitMock[k].mockReset();
  }
  gitMock.revParse.mockResolvedValue('oldsha');
  gitMock.resetTestingToMain.mockResolvedValue(undefined);
  gitMock.resetTestingTo.mockResolvedValue(undefined);
  gitMock.commitAll.mockResolvedValue(undefined);
  gitMock.abortMerge.mockResolvedValue(undefined);
  require('../notify').emitToUser.mockReset();
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM project_repos');
  await dbModule.query('DELETE FROM projects');
});

async function makeProject(repoLabels = ['main'], repoBase = '/repos/mp') {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('MP','17.0','mp') RETURNING id"
  );
  for (const label of repoLabels) {
    await dbModule.query(
      "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,$2,'u',$3,$4,'done')",
      [proj.id, label, `${repoBase}/${label}`, label === repoLabels[0]]
    );
  }
  return proj.id;
}

async function addTask(projectId, { status, branch = null, approved = false, hidden = false, resolutions = null, taskId }) {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, approved_at, is_hidden, merge_resolutions)
     VALUES ($1,$2,'odoo','T',$3,$4,$5,$6,$7,$8) RETURNING id`,
    [userId, taskId, status, projectId, branch, approved ? new Date() : null, hidden, resolutions]
  );
  return t.id;
}

// 意圖：reset 到 main 後，把「未 approved、在飛、已部署」任務逐一重併回 testing；無衝突則不暫停
test('重建 → 每 repo reset 到 main，並重併在飛任務，無衝突不暫停', async () => {
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  const projectId = await makeProject(['main', 'hr']);
  await addTask(projectId, { status: 'review_pending', branch: 'task/a', taskId: 'a' });
  await addTask(projectId, { status: 'deploy_testing', branch: 'task/b', taskId: 'b' });

  const warning = await rebuildMod.rebuildTesting(projectId, userId, undefined);

  expect(gitMock.resetTestingToMain).toHaveBeenCalledTimes(2); // 每 repo 一次
  expect(gitMock.mergeInto).toHaveBeenCalledTimes(4);          // 2 repo × 2 task
  for (const c of gitMock.mergeInto.mock.calls) expect(c[1]).toBe('testing');
  expect(warning).toBeNull();
});

// 意圖：approved（碼已在 main）、非在飛、隱藏、無分支的任務都不該被重併，避免把不該上的碼推回 testing
test('重建 → 排除 approved / 非在飛 / 隱藏 / 無分支 的任務', async () => {
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  const projectId = await makeProject(['main']);
  const inflight = await addTask(projectId, { status: 'review_pending', branch: 'task/keep', taskId: 'keep' });
  await addTask(projectId, { status: 'review_pending', branch: 'task/appr', approved: true, taskId: 'appr' });
  await addTask(projectId, { status: 'coding_running', branch: 'task/cod', taskId: 'cod' });
  await addTask(projectId, { status: 'review_pending', branch: 'task/hid', hidden: true, taskId: 'hid' });
  await addTask(projectId, { status: 'deploy_testing', branch: null, taskId: 'nobranch' });

  await rebuildMod.rebuildTesting(projectId, userId, undefined);

  expect(gitMock.mergeInto).toHaveBeenCalledTimes(1);
  expect(gitMock.mergeInto.mock.calls[0][2]).toBe('task/keep');
});

// 意圖：重併撞衝突且無記錄解法、agent 也解不掉 → 該任務置 merge_conflict 且標記 rebuild 來源與原狀態，停下
test('重建 → 衝突且無解法時該任務置 merge_conflict(rebuild=true,prior_status)，停止並回警告', async () => {
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: ['models/x.py'] });
  const projectId = await makeProject(['main']);
  const taskId = await addTask(projectId, { status: 'review_pending', branch: 'task/c', taskId: 'c' });

  const warning = await rebuildMod.rebuildTesting(projectId, userId, undefined);

  expect(warning).toMatch(/人工/);
  const { rows } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('merge_conflict');
  const data = typeof rows[0].merge_conflict_data === 'string'
    ? JSON.parse(rows[0].merge_conflict_data) : rows[0].merge_conflict_data;
  expect(data.rebuild).toBe(true);
  expect(data.prior_status).toBe('review_pending');
  expect(data.repos[0].files).toContain('models/x.py');
});

// 意圖：非衝突類 git 錯（reset 失敗）→ 還原 testing 到備份 SHA、回警告，且不動任何任務（fail-open）
test('重建 → reset 失敗時還原 testing 備份 SHA、回警告、不擋刪除', async () => {
  gitMock.revParse.mockResolvedValue('backup123');
  gitMock.resetTestingToMain.mockRejectedValue(new Error('reset boom'));
  const projectId = await makeProject(['main']);
  const taskId = await addTask(projectId, { status: 'review_pending', branch: 'task/d', taskId: 'd' });

  const warning = await rebuildMod.rebuildTesting(projectId, userId, undefined);

  expect(warning).toMatch(/還原|重建失敗/);
  expect(gitMock.resetTestingTo).toHaveBeenCalledWith('/repos/mp/main', 'backup123');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('review_pending'); // 任務不受影響
});

// 意圖：rebuildTestingWithinLock（無鎖版）存在的唯一理由＝可在「已持有 withProjectLock」的呼叫端
// （如「更新 repo」端點 triggerClone 已在鎖內）內呼叫而不死鎖。若有人改回持鎖的 rebuildTesting，
// 在此已持鎖處再持鎖會排在鏈尾等外層、而外層又在等它 → 死鎖，被 timeout 抓出。
test('rebuildTestingWithinLock：已持有 project lock 內呼叫不死鎖，且照樣 reset+重併', async () => {
  const { withProjectLock } = require('../pipeline/project-lock');
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  const projectId = await makeProject(['main']);
  await addTask(projectId, { status: 'deploy_testing', branch: 'task/w', taskId: 'w' });

  const result = await withProjectLock(projectId, () =>
    Promise.race([
      rebuildMod.rebuildTestingWithinLock(projectId, userId, undefined),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock：疑似改用持鎖版')), 1000))
    ])
  );

  expect(result).toBeNull();                                    // 乾淨完成，非死鎖
  expect(gitMock.resetTestingToMain).toHaveBeenCalledTimes(1);
  expect(gitMock.mergeInto).toHaveBeenCalledWith('/repos/mp/main', 'testing', 'task/w');
});

// 意圖：衝突檔有記錄解法時，重演直接套用（寫回工作樹）→ 不暫停、自動 commit 續併（衝突記憶真的省掉人工）
test('重建 → 衝突檔有記錄解法時自動套用、不暫停', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-'));
  fs.mkdirSync(path.join(tmp, 'main'), { recursive: true }); // 真實 repo 工作樹目錄本就存在
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: ['x.py'] });
  const projectId = await makeProject(['main'], tmp);
  const resolutions = JSON.stringify({ main: { 'x.py': 'RESOLVED CONTENT' } });
  const taskId = await addTask(projectId, { status: 'review_pending', branch: 'task/e', taskId: 'e', resolutions });

  const warning = await rebuildMod.rebuildTesting(projectId, userId, undefined);

  expect(warning).toBeNull();
  expect(gitMock.commitAll).toHaveBeenCalled();
  expect(fs.readFileSync(path.join(tmp, 'main', 'x.py'), 'utf8')).toBe('RESOLVED CONTENT');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('review_pending'); // 未暫停
  fs.rmSync(tmp, { recursive: true, force: true });
});
