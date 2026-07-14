const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/git', () => ({
  mergeInto: jest.fn(),
  commitAll: jest.fn().mockResolvedValue(undefined),
  abortMerge: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));

let dbModule, mergeMod, gitMock, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('m','h','M','user') RETURNING id"
  );
  userId = rows[0].id;
  gitMock = require('../pipeline/git');
  mergeMod = require('../pipeline/merge-agent');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  mockRunClaude.mockReset();
  gitMock.mergeInto.mockReset();
  gitMock.commitAll.mockReset().mockResolvedValue(undefined);
  gitMock.abortMerge.mockReset().mockResolvedValue(undefined);
  require('../notify').emitToUser.mockReset();
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM project_repos');
  await dbModule.query('DELETE FROM projects');
});

async function setupProjectTask(repoLabels) {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('MP','17.0','mp') RETURNING id"
  );
  for (const label of repoLabels) {
    await dbModule.query(
      "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,$2,'u',$3,$4,'done')",
      [proj.id, label, `/repos/mp/${label}`, label === repoLabels[0]]
    );
  }
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, git_branch)
     VALUES ($1,'task_odoo_m1','odoo','T','c','merge_running',$2,'task/task_odoo_m1') RETURNING id`,
    [userId, proj.id]
  );
  return t.id;
}

// 意圖：task 分支要併進「testing」（非 main），且每個 repo 都要處理
test('merges task branch into testing for every repo, then deploy_testing', async () => {
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  const taskId = await setupProjectTask(['main', 'hr']);

  await mergeMod.runMergeAgent(taskId, userId, undefined);

  expect(gitMock.mergeInto).toHaveBeenCalledTimes(2);
  for (const c of gitMock.mergeInto.mock.calls) {
    expect(c[1]).toBe('testing');              // target
    expect(c[2]).toBe('task/task_odoo_m1');    // source（task 分支）
  }
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('deploy_testing');
});

// 意圖：某個 repo 有無法自動解決的衝突時，要卡在 merge_conflict 且記錄「是哪個 repo」
test('unresolved conflict in one repo → merge_conflict records that repo', async () => {
  gitMock.mergeInto
    .mockResolvedValueOnce({ hasConflicts: false, conflictFiles: [] })              // main：乾淨
    .mockResolvedValueOnce({ hasConflicts: true, conflictFiles: ['models/x.py'] }); // hr：衝突（檔案不在磁碟 → 無法自動解）
  const taskId = await setupProjectTask(['main', 'hr']);

  await mergeMod.runMergeAgent(taskId, userId, undefined);

  const { rows } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('merge_conflict');
  const data = typeof rows[0].merge_conflict_data === 'string'
    ? JSON.parse(rows[0].merge_conflict_data) : rows[0].merge_conflict_data;
  expect(data.repos[0].repo).toBe('hr');
  expect(data.repos[0].files).toContain('models/x.py');
});

// --- 健檢 U6：merge 失敗出口要清掉半套 merge ---
// 意圖：主 clone（testing 常駐樹）殘留 MERGE_HEAD／衝突標記會污染同專案後續任務的
// merge 與 deploy，且部署錯誤會被誤歸因為本任務的程式問題。

test('mergeInto 拋錯 → 先 abortMerge 清理再 stopped', async () => {
  gitMock.mergeInto.mockRejectedValue(new Error('You have not concluded your merge'));
  const taskId = await setupProjectTask(['main']);

  await mergeMod.runMergeAgent(taskId, userId, undefined);

  expect(gitMock.abortMerge).toHaveBeenCalledWith('/repos/mp/main');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('stopped');
});

test('解衝突後 commitAll 失敗 → abortMerge 清理再 stopped', async () => {
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: [] });
  gitMock.commitAll.mockRejectedValue(new Error('commit failed'));
  const taskId = await setupProjectTask(['main']);

  await mergeMod.runMergeAgent(taskId, userId, undefined);

  expect(gitMock.abortMerge).toHaveBeenCalledWith('/repos/mp/main');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('stopped');
});

// 意圖：merge agent 被要求「直接輸出檔案內容」，但 model 對純內容輸出加 ``` fence 是高頻行為；
// 不剝掉就把 fence 原封寫進檔案並 commit 進 testing → 語法壞檔。此防線若默默失效要立即翻紅。
test('resolveConflict 剝除 code fence 後才寫檔', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-agent-'));
  fs.writeFileSync(path.join(dir, 'a.py'), '<<<<<<< HEAD\nx = 1\n=======\nx = 2\n>>>>>>> task\n');
  mockRunClaude.mockResolvedValueOnce({ text: '```python\nx = 2\n```', usage: null, durationMs: null });

  const ok = await mergeMod.resolveConflict(dir, 'a.py');

  expect(ok).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'a.py'), 'utf8')).toBe('x = 2\n');
});

// 意圖：改逐 hunk 解衝突後，多個衝突區塊要各自解、非衝突行原樣保留——
// 這是「不再整份檔案進 prompt」的正確性底線（大檔省 token 不得以改壞無衝突內容為代價）。
test('resolveConflict 多個 hunk：逐塊解、非衝突行原樣保留', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-agent-'));
  fs.writeFileSync(path.join(dir, 'a.py'),
    'keep_top = True\n' +
    '<<<<<<< HEAD\na = 1\n=======\na = 2\n>>>>>>> task\n' +
    'keep_mid = True\n' +
    '<<<<<<< HEAD\nb = 1\n=======\nb = 2\n>>>>>>> task\n' +
    'keep_bottom = True\n');
  // 由後往前解：第一次呼叫收到 b 的 hunk、第二次收到 a 的 hunk
  mockRunClaude
    .mockResolvedValueOnce({ text: 'b = 2', usage: null, durationMs: null })
    .mockResolvedValueOnce({ text: 'a = 2', usage: null, durationMs: null });

  const ok = await mergeMod.resolveConflict(dir, 'a.py');

  expect(ok).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'a.py'), 'utf8'))
    .toBe('keep_top = True\na = 2\nkeep_mid = True\nb = 2\nkeep_bottom = True\n');
  // 每個 hunk 一次呼叫，且【衝突區塊】段只含該 hunk（前後文允許包含鄰近內容）
  expect(mockRunClaude).toHaveBeenCalledTimes(2);
  const block0 = mockRunClaude.mock.calls[0][0].split('【衝突區塊】')[1].split('【後文脈絡】')[0];
  expect(block0).toContain('b = 1');
  expect(block0).not.toContain('a = 1');
});

test('resolveConflict 輸出仍含衝突標記 → false 且不覆寫檔案', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-agent-'));
  const original = '<<<<<<< HEAD\nx = 1\n=======\nx = 2\n>>>>>>> task\n';
  fs.writeFileSync(path.join(dir, 'a.py'), original);
  mockRunClaude.mockResolvedValueOnce({ text: '<<<<<<< HEAD\nx = 1\n=======\nx = 2\n>>>>>>> task', usage: null, durationMs: null });

  const ok = await mergeMod.resolveConflict(dir, 'a.py');

  expect(ok).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'a.py'), 'utf8')).toBe(original);
});
