// 意圖：「審核通過 → 併入 ai-dev」原本是 approve 路由裡的一段同步 git 操作，撞衝突就回 500——
// 任務留在 review_pending、主 clone 留著半殘 merge、既不自動解也進不了裁決畫面（task 132 實況）。
// 本檔守的是把它做成 pipeline 一關之後的行為：衝突先交 merge agent 自動解，解不掉才轉人工裁決閘門。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/git', () => ({
  AI_BRANCH: 'ai-dev',
  mergeToAiBranch: jest.fn().mockResolvedValue(undefined),
  concludeAiMerge: jest.fn().mockResolvedValue(undefined),
  deleteBranchLocal: jest.fn().mockResolvedValue(undefined),
  removeWorktree: jest.fn().mockResolvedValue(undefined),
  refExists: jest.fn().mockResolvedValue(true),
  AiPushConflictError: class AiPushConflictError extends Error {
    constructor(files) { super('push conflict'); this.name = 'AiPushConflictError'; this.conflictFiles = files; }
  },
  AiMergeConflictError: class AiMergeConflictError extends Error {
    constructor(files) { super('merge conflict'); this.name = 'AiMergeConflictError'; this.conflictFiles = files; }
  },
}));
jest.mock('../pipeline/merge-agent', () => ({
  resolveConflicts: jest.fn(),
  DEFAULT_LABELS: { oursLabel: 'testing 現況', theirsLabel: '任務分支（新版）' },
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: jest.fn() }));

let dbModule, pushAi, gitMock, mergeMock, identMock, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('p','h','P','user') RETURNING id"
  );
  userId = rows[0].id;
  gitMock = require('../pipeline/git');
  mergeMock = require('../pipeline/merge-agent');
  identMock = require('../lib/git-identity');
  pushAi = require('../pipeline/push-ai');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  gitMock.mergeToAiBranch.mockReset().mockResolvedValue(undefined);
  gitMock.concludeAiMerge.mockReset().mockResolvedValue(undefined);
  gitMock.deleteBranchLocal.mockReset().mockResolvedValue(undefined);
  gitMock.removeWorktree.mockReset().mockResolvedValue(undefined);
  gitMock.refExists.mockReset().mockResolvedValue(true);
  mergeMock.resolveConflicts.mockReset();
  identMock.buildGitEnv.mockReset().mockResolvedValue({ GIT_PAT: 'pat' });
  require('../notify').emitToUser.mockReset();
  await dbModule.query('DELETE FROM task_logs');
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM project_repos');
  await dbModule.query('DELETE FROM projects');
});

async function setupTask(repoLabels = ['main']) {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('PA','19.0','pa') RETURNING id"
  );
  for (const label of repoLabels) {
    await dbModule.query(
      "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,$2,'u',$3,$4,'done')",
      [proj.id, label, `/repos/pa/${label}`, label === repoLabels[0]]
    );
  }
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, git_branch)
     VALUES ($1,'task_pa_1','odoo','T','c','push_ai_running',$2,'task/task_pa_1') RETURNING id`,
    [userId, proj.id]
  );
  return t.id;
}

const statusOf = async (id) => (await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id])).rows[0].status;
const conflictOf = async (id) => {
  const { rows: [r] } = await dbModule.query('SELECT merge_conflict_data FROM tasks WHERE id=$1', [id]);
  return r.merge_conflict_data ? JSON.parse(r.merge_conflict_data) : null;
};

// 意圖：一路順的情況要走完——每個 repo 都併、清掉 worktree 與任務分支、記下核准時間、轉去更新 wiki。
test('無衝突 → 逐 repo 併入 ai-dev、清理分支、轉 wiki_updating 並記 approved_at', async () => {
  const taskId = await setupTask(['main', 'hr']);

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(gitMock.mergeToAiBranch).toHaveBeenCalledTimes(2);
  expect(gitMock.mergeToAiBranch).toHaveBeenCalledWith('/repos/pa/main', 'task/task_pa_1', { GIT_PAT: 'pat' });
  expect(gitMock.deleteBranchLocal).toHaveBeenCalled();
  expect(await statusOf(taskId)).toBe('wiki_updating');
  const { rows: [t] } = await dbModule.query('SELECT approved_at FROM tasks WHERE id=$1', [taskId]);
  expect(t.approved_at).not.toBeNull();
});

// 意圖：repo 清單是核准當下才查的，任務開跑後才被加進專案的 repo 也在裡面——它沒有任務分支，
// 硬併會拿到「not something we can merge」這種不帶 conflictFiles 的錯，整張已核准的任務就卡死在
// 最後一關（實測萊峰19 加入第二個 repo 後 task 186 即如此）。沒有任務分支＝沒參與這張任務，跳過。
test('任務開跑後才加入的 repo（無任務分支）→ 跳過該 repo，其餘照常完成', async () => {
  const taskId = await setupTask(['main', 'late']);
  gitMock.refExists.mockImplementation(async (repoPath) => repoPath !== '/repos/pa/late');

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(gitMock.mergeToAiBranch).toHaveBeenCalledTimes(1);
  expect(gitMock.mergeToAiBranch).toHaveBeenCalledWith('/repos/pa/main', 'task/task_pa_1', { GIT_PAT: 'pat' });
  expect(await statusOf(taskId)).toBe('wiki_updating'); // 不得因此 stopped
});

// 意圖：本次事故的正題——本機併 ai-dev 撞衝突不是死路，先交 merge agent 自動解，解掉就照常完成合併。
test('本機 merge 衝突 → merge agent 自動解成功 → 了結 merge 續推、轉 wiki_updating', async () => {
  const taskId = await setupTask();
  gitMock.mergeToAiBranch.mockRejectedValueOnce(new gitMock.AiMergeConflictError(['idx_ciyun/__manifest__.py']));
  mergeMock.resolveConflicts.mockResolvedValue({ failed: [], details: {} });

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(mergeMock.resolveConflicts).toHaveBeenCalledWith(
    '/repos/pa/main', ['idx_ciyun/__manifest__.py'], expect.anything(), undefined
  );
  expect(gitMock.concludeAiMerge).toHaveBeenCalledWith(
    '/repos/pa/main', ['idx_ciyun/__manifest__.py'], expect.any(String), { GIT_PAT: 'pat' }
  );
  expect(await statusOf(taskId)).toBe('wiki_updating');
});

// 意圖：AI 解不掉才交人工，且必須進得了裁決畫面——push_ai 變體＋prior_status 指回本關，
// 解完才有辦法自動續推（而不是叫使用者再按一次審核通過）。details 要一起帶，否則卡片沒有 AI 說明。
test('AI 解不掉 → 轉 merge_conflict（push_ai 變體、prior_status 指回本關、帶 details）', async () => {
  const taskId = await setupTask();
  gitMock.mergeToAiBranch.mockRejectedValueOnce(new gitMock.AiMergeConflictError(['a.py', 'b.xml']));
  mergeMock.resolveConflicts.mockResolvedValue({
    failed: ['b.xml'],
    details: { 'b.xml': { classification: '兩邊都改', recommendation: 'manual' } },
  });

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(await statusOf(taskId)).toBe('merge_conflict');
  const cd = await conflictOf(taskId);
  expect(cd.push_ai).toBe(true);
  expect(cd.prior_status).toBe('push_ai_running');
  expect(cd.repos[0]).toMatchObject({ repo: 'main', files: ['b.xml'] });
  expect(cd.repos[0].details['b.xml'].classification).toBe('兩邊都改');
  expect(gitMock.concludeAiMerge).not.toHaveBeenCalled(); // 沒解完不得了結 merge
});

// 意圖：push 階段撞遠端競態走同一條處理路徑——原本它是唯一進得了裁決閘門的衝突，
// 現在同樣先讓 AI 試解，避免「另一實例推了不相干的碼」也要人工介入。
test('push 階段撞遠端 ai-dev（AiPushConflictError）→ 一樣先交 AI 解', async () => {
  const taskId = await setupTask();
  gitMock.mergeToAiBranch.mockRejectedValueOnce(new gitMock.AiPushConflictError(['shared.txt']));
  mergeMock.resolveConflicts.mockResolvedValue({ failed: [], details: {} });

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(mergeMock.resolveConflicts).toHaveBeenCalled();
  expect(await statusOf(taskId)).toBe('wiki_updating');
});

// 意圖：手動暫停（signal abort）時 resolveConflicts 回 { aborted:true }，此時任何狀態變更都是錯的——
// 使用者按暫停卻看到任務自己走完，或被標成衝突待裁決，都會讓現場對不上。
test('解衝突途中被暫停 → 狀態原地不動，不轉 wiki_updating 也不轉 merge_conflict', async () => {
  const taskId = await setupTask();
  gitMock.mergeToAiBranch.mockRejectedValueOnce(new gitMock.AiMergeConflictError(['a.py']));
  mergeMock.resolveConflicts.mockResolvedValue({ aborted: true, failed: [], details: {} });

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(await statusOf(taskId)).toBe('push_ai_running');
  expect(gitMock.concludeAiMerge).not.toHaveBeenCalled();
});

// 意圖：git 的其他錯（權限、網路、分支不見）不是衝突，不能被當成「待裁決」丟進閘門——
// 那會讓使用者看到一張沒有衝突內容的空卡片。要 fail loud 停下並留原因。
test('非衝突的 git 失敗 → stopped 並留下原因', async () => {
  const taskId = await setupTask();
  gitMock.mergeToAiBranch.mockRejectedValueOnce(new Error('remote: Permission denied'));

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(await statusOf(taskId)).toBe('stopped');
  const { rows: [t] } = await dbModule.query('SELECT blocker_content FROM tasks WHERE id=$1', [taskId]);
  expect(t.blocker_content).toMatch(/Permission denied/);
});

// 意圖：push 要歸屬到「按下審核通過的人」而非任務發起人——approved_by 是那個人的紀錄。
test('gitEnv 取的是核准者（approved_by），不是任務發起人', async () => {
  const taskId = await setupTask();
  const { rows: [approver] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('approver','h','A') RETURNING id"
  );
  await dbModule.query('UPDATE tasks SET approved_by=$2 WHERE id=$1', [taskId, approver.id]);

  await pushAi.runPushAi(taskId, userId, undefined);

  expect(identMock.buildGitEnv).toHaveBeenCalledWith(approver.id);
});
