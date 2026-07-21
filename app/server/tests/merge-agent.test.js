const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/git', () => ({
  mergeInto: jest.fn(),
  commitResolved: jest.fn().mockResolvedValue(undefined),
  abortMerge: jest.fn().mockResolvedValue(undefined),
  restoreConflictMarkers: jest.fn().mockResolvedValue(undefined)
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
  gitMock.commitResolved.mockReset().mockResolvedValue(undefined);
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

test('解衝突後 commitResolved 失敗 → abortMerge 清理再 stopped', async () => {
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: [] });
  gitMock.commitResolved.mockRejectedValue(new Error('commit failed'));
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

// 意圖：本次事故真因——merge agent 沒回乾淨程式碼，而是回「中文說明＋夾在中段的 ``` fence」。
// stripFence 只處理「整段以 ``` 開頭」，這種「散文開頭、中段才有 fence」原封通過舊守衛被寫進 .py。
// 守衛須加擋「殘留 fence」：判失敗、回 false，且因 writeFileSync 在迴圈之後 → 檔案原始衝突標記原封不動。
test('resolveConflict AI 回散文＋中段 fence → false 且不覆寫檔案（守住本次事故）', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-prose-'));
  const original = '<<<<<<< HEAD\n=======\nx = 2\n>>>>>>> task\n';
  fs.writeFileSync(path.join(dir, 'a.py'), original);
  // 比照事故現場：AI 以中文說明開頭，正確程式碼夾在中段的 code fence 裡
  mockRunClaude.mockResolvedValueOnce({
    text: '這是單邊新增，非真衝突，應保留該分支內容。正確的最終內容：\n\n```\nx = 2\n```',
    usage: null, durationMs: null
  });

  const ok = await mergeMod.resolveConflict(dir, 'a.py');

  expect(ok).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'a.py'), 'utf8')).toBe(original); // 未被寫壞
});

// 意圖：AI 解衝突常把縮排解爛（本次事故真因：idx_repair_bom.py 有一行掉了縮排 → IndentationError）。
// 這種檔沒有衝突標記卻壞掉，須在 commit 進 testing 前被 py_compile 擋下。此閘門失效＝壞碼進部署。
test('verifyResolvedSyntax 抓出縮排壞掉的 py、放行正常檔', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-syntax-'));
  fs.writeFileSync(path.join(dir, 'good.py'), 'def f():\n    x = 1\n    return x\n');
  // 第二行多一格縮排 → unexpected indent（比照事故現場）
  fs.writeFileSync(path.join(dir, 'bad.py'), 'x = 1\n    y = 2\n');

  const bad = await mergeMod.verifyResolvedSyntax(dir, ['good.py', 'bad.py']);

  expect(bad).toEqual(['bad.py']);
});

// 意圖：AI 解出的檔即使無衝突標記，只要語法壞掉就不得 commit 進 testing——改列 merge_conflict 交人工。
// 沒有這道閘門，壞碼進 testing → deploy 才爆 IndentationError 並被誤歸因為程式問題（本次事故）。
test('AI 解出的檔語法壞掉 → 不 commit、改 merge_conflict', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-e2e-'));
  fs.writeFileSync(path.join(dir, 'bad.py'), '<<<<<<< HEAD\nx = 1\n=======\nx = 2\n>>>>>>> task\n');
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: ['bad.py'] });
  // AI 回傳「無衝突標記但縮排壞掉」的內容
  mockRunClaude.mockResolvedValueOnce({ text: 'x = 2\n    y = 3\n', usage: null, durationMs: null });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('E','17.0','e') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [proj.id, dir]
  );
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, git_branch)
     VALUES ($1,'task_odoo_e1','odoo','T','c','merge_running',$2,'task/task_odoo_e1') RETURNING id`,
    [userId, proj.id]
  );

  await mergeMod.runMergeAgent(t.id, userId, undefined);

  expect(gitMock.commitResolved).not.toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [t.id]);
  expect(rows[0].status).toBe('merge_conflict');
  const data = typeof rows[0].merge_conflict_data === 'string'
    ? JSON.parse(rows[0].merge_conflict_data) : rows[0].merge_conflict_data;
  expect(data.repos[0].files).toContain('bad.py');
});

// 意圖：使用者按暫停時 resolveConflict 內 runClaude 拋 aborted，被逐檔 catch 吞成 failed。
// 沒有 abort 守衛就會把「暫停」誤標成 merge_conflict（假衝突）。暫停＝狀態原地不動（留 merge_running）。
test('暫停中止（signal.aborted）→ 不誤標 merge_conflict、狀態留 merge_running', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-abort-'));
  fs.writeFileSync(path.join(dir, 'a.py'), '<<<<<<< HEAD\nx = 1\n=======\nx = 2\n>>>>>>> task\n');
  gitMock.mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: ['a.py'] });
  // 比照 runClaude 被暫停時的行為：拋出帶 aborted 旗標的 error
  const aborted = new Error('aborted'); aborted.aborted = true;
  mockRunClaude.mockRejectedValueOnce(aborted);

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P','17.0','p') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [proj.id, dir]
  );
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, git_branch)
     VALUES ($1,'task_odoo_p1','odoo','T','c','merge_running',$2,'task/task_odoo_p1') RETURNING id`,
    [userId, proj.id]
  );

  await mergeMod.runMergeAgent(t.id, userId, { aborted: true });

  expect(gitMock.commitResolved).not.toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
  expect(rows[0].status).toBe('merge_running'); // 非 merge_conflict
});

// 意圖：二進位／modify-delete 類衝突以 utf8 讀不到 <<<<<<< 標記，但 git 仍視為 unmerged。
// 無條件 return true 會把「完全沒決策」的檔當已解決 commit 進 testing → 須改查 git 是否仍 unmerged。
test('無文字標記但 git 仍 unmerged（modify-delete）→ resolveConflict 回 false 交人工', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-md-'));
  const g = (args) => execFileSync('git', args, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.py'), 'x = 1\n');
  g(['add', 'f.py']); g(['commit', '-q', '-m', 'init']);
  g(['checkout', '-q', '-b', 'feat']);
  fs.writeFileSync(path.join(dir, 'f.py'), 'x = 2\n');
  g(['add', 'f.py']); g(['commit', '-q', '-m', 'mod']);
  g(['checkout', '-q', 'main']);
  g(['rm', '-q', 'f.py']); g(['commit', '-q', '-m', 'del']);
  try { g(['merge', 'feat']); } catch { /* modify/delete 衝突 → 非 0 離開 */ }
  // f.py 此時是 feat 版（x = 2，無衝突標記），但 index 仍 unmerged
  expect(fs.readFileSync(path.join(dir, 'f.py'), 'utf8')).not.toContain('<<<<<<<');
  expect(execFileSync('git', ['ls-files', '-u', '--', 'f.py'], { cwd: dir }).toString().trim()).not.toBe('');

  const ok = await mergeMod.resolveConflict(dir, 'f.py');

  expect(ok).toBe(false); // 修正前：無標記即 return true（靜默假解決）
  expect(mockRunClaude).not.toHaveBeenCalled();
});

// 意圖：退回人工前，對每個失敗檔產生「結構化原因＋建議」（塊 B）。both-added 衝突時
// 要能讀到 index 兩側（ours=stage2 / theirs=stage3），並把 AI 回的 JSON 解析成裁決卡片資料。
function bothAddedRepo() {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-explain-'));
  const g = (args) => execFileSync('git', args, { cwd: dir });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  g(['commit', '-q', '--allow-empty', '-m', 'base']);
  g(['checkout', '-q', '-b', 'feat']);
  fs.writeFileSync(path.join(dir, 'f.py'), 'x = 1\ny = 2\n'); // theirs（新版）
  g(['add', 'f.py']); g(['commit', '-q', '-m', 'feat add']);
  g(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'f.py'), 'x = 1\n');        // ours（舊版）
  g(['add', 'f.py']); g(['commit', '-q', '-m', 'main add']);
  try { g(['merge', 'feat']); } catch { /* both-added 衝突 */ }
  return dir;
}

test('explainConflict：AI 回合法 JSON → 結構化建議（含兩側內容）', async () => {
  const dir = bothAddedRepo();
  mockRunClaude.mockResolvedValueOnce({
    text: '<result>{"classification":"both-added","reason":"兩邊各自新增","recommendation":"take_theirs","rationale":"新版為舊版超集"}</result>',
    usage: null, durationMs: null
  });

  const d = await mergeMod.explainConflict(dir, 'f.py', undefined, {});

  expect(d).toEqual({
    classification: 'both-added', reason: '兩邊各自新增',
    recommendation: 'take_theirs', rationale: '新版為舊版超集'
  });
  // 兩側內容有進 prompt（ours=舊版、theirs=新版）
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('x = 1');
  expect(prompt).toContain('y = 2');
});

test('explainConflict：AI 回無法解析（含修復也失敗）→ null（退回純檔名）', async () => {
  const dir = bothAddedRepo();
  mockRunClaude.mockResolvedValue({ text: '我覺得應該取新版', usage: null, durationMs: null });

  const d = await mergeMod.explainConflict(dir, 'f.py', undefined, {});

  expect(d).toBeNull();
});

// 意圖：Linux 主機常無 python（只有 python3）。修正前 interpreter 硬寫 'python'、PYTHON_BIN 完全被忽略，
// 導致無法跨平台選 interpreter。此測試證明 PYTHON_BIN 已被採用（不再硬寫 python）——用一個「存在但不是 python」
// 的 interpreter（git）驗一個好檔：因 interpreter 被真正採用，good.py 會被判為壞（git 不吃 -m py_compile）。
// 修正前 PYTHON_BIN 被忽略、走真 python → good.py 通過 → []，故此測試會 fail-then-pass。
test('PYTHON_BIN 指定的 interpreter 被採用（非硬寫 python）', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-pybin-'));
  fs.writeFileSync(path.join(dir, 'good.py'), 'def f():\n    return 1\n');

  const origPyBin = process.env.PYTHON_BIN;
  try {
    process.env.PYTHON_BIN = 'git'; // 存在但非 python：`git -m py_compile ...` 非 0 離開（非 ENOENT）
    const bad = await mergeMod.verifyResolvedSyntax(dir, ['good.py']);
    expect(bad).toEqual(['good.py']); // interpreter 真被採用；修正前忽略 PYTHON_BIN 走真 python → []
  } finally {
    if (origPyBin === undefined) delete process.env.PYTHON_BIN; else process.env.PYTHON_BIN = origPyBin;
  }
});
