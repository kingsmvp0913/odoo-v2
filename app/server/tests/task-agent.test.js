// 意圖：專案分析前必須先 pull main 讀最新碼；pull 失敗（origin 不通／本地髒）
// 屬環境問題，停下等人工，不得拿舊碼繼續分析。
const { newDb } = require('pg-mem');
const { EventEmitter } = require('events');
const path = require('path');

// 可控 spawn mock：記錄每次呼叫的 args 與 stdin，並依腳本 emit 事件（session_id、result、exit code）
function mockClaude({ onCall } = {}) {
  const { spawn } = require('child_process');
  const calls = [];
  spawn.mockImplementation((bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const call = { args, stdin: '', cwd: opts && opts.cwd };
    calls.push(call);
    child.stdin = {
      write: (d) => { call.stdin += d; },
      end: () => setImmediate(() => (onCall || defaultScript)(child, call, calls.length - 1))
    };
    return child;
  });
  return calls;
}
function emitInit(child, sessionId) {
  child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
}
function emitResult(child, status = 'qa_running') {
  child.stdout.emit('data', JSON.stringify({ type: 'result', result: `---RESULT-JSON---\n{"status":"${status}"}\n---END-RESULT---`, usage: null, duration_ms: 10 }) + '\n');
}
function defaultScript(child) { emitResult(child); child.emit('close', 0); }

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  pullBranch: jest.fn(),
  ensureMainBranch: jest.fn().mockResolvedValue('main'),
  ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

let dbModule, runTaskAnalysis, runTaskCoding, git;
let userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('ta', $1, 'T') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TAP', '17.0') RETURNING id"
  );
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/tap/main',true,'done')",
    [projectId]
  );

  git = require('../pipeline/git');
  ({ runTaskAnalysis, runTaskCoding } = require('../pipeline/task-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('分析前 pull main 失敗 → 任務 stopped，不繼續分析', async () => {
  git.pullBranch.mockRejectedValueOnce(new Error('could not resolve host github.com'));
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_pull','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  const handled = await runTaskAnalysis(t.id, userId);
  expect(handled).toBe(true);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('main');
});

test('coding retry：retry_feedback（上一輪失敗訊息）確實帶進 claude prompt，且用完清空', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  let captured = '';
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write: (d) => { captured += d; },
      end: () => {
        setImmediate(() => {
          child.stdout.emit('data', JSON.stringify({ type: 'result', result: '---RESULT-JSON---\n{"status":"qa_running"}\n---END-RESULT---', usage: null, duration_ms: 10 }) + '\n');
          child.emit('close', 0);
        });
      }
    };
    return child;
  });

  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, analysis_yaml, git_branch, status, project_id, retry_feedback) VALUES ($1,'ta_code','odoo','T','module: idx_x','task/ta_code','coding_running',$2,$3) RETURNING id",
    [userId, projectId, '[部署測試區升級失敗]\nParseError: bad view line 5']
  );
  const handled = await runTaskCoding(t.id, userId);
  expect(handled).toBe(true);
  // 意圖：上一輪失敗訊息必須出現在餵給 claude 的 prompt，否則 AI 修不到
  expect(captured).toContain('ParseError: bad view line 5');
  // 用完即清 + 進入 QA
  const { rows: [after] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('qa_running');
  expect(after.retry_feedback).toBeNull();
});

// 健檢 agents 層 P2：feedback 在 spawn 前就清空，失敗/逾時後回饋永久遺失。
// 意圖：只有「成功執行」才算消費掉回饋；失敗要保留給下一次重試。
test('coding spawn 失敗 → retry_feedback 保留，下次重試不致盲改', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { write: () => {}, end: () => { setImmediate(() => child.emit('close', 1)); } };
    return child;
  });

  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, analysis_yaml, git_branch, status, project_id, retry_feedback) VALUES ($1,'ta_code_fail','odoo','T','module: idx_x','task/ta_code_fail','coding_running',$2,$3) RETURNING id",
    [userId, projectId, '[QA 未通過]\n欄位漏了 tracking']
  );
  await runTaskCoding(t.id, userId);

  const { rows: [after] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.retry_feedback).toContain('欄位漏了 tracking'); // 未成功執行＝未消費
});

// ===== 主題 B：coding 重跑 session resume =====

test('B-1 spawnClaude：從 init 事件抓到 session_id 並回傳', async () => {
  mockClaude({ onCall: (child) => { emitInit(child, 'sess-abc-123'); emitResult(child); child.emit('close', 0); } });
  const { spawnClaude } = require('../pipeline/task-agent');
  const r = await spawnClaude('p', { cwd: '/tmp' });
  expect(r.sessionId).toBe('sess-abc-123');
});

test('B-1 spawnClaude：給 resumeSessionId → args 含 --resume；不給 → 不含', async () => {
  const calls = mockClaude();
  const { spawnClaude } = require('../pipeline/task-agent');
  await spawnClaude('p', { cwd: '/tmp', resumeSessionId: 'sess-xyz' });
  await spawnClaude('p', { cwd: '/tmp' });
  expect(calls[0].args).toContain('--resume');
  expect(calls[0].args).toContain('sess-xyz');
  expect(calls[1].args).not.toContain('--resume');
});

test('B-3 distillFeedback：Odoo traceback → 只留 idx_ frame＋例外行、附 log 路徑', () => {
  const { distillFeedback } = require('../pipeline/task-agent');
  const raw = [
    '[部署測試區升級失敗]',
    'Traceback (most recent call last)',
    '  File "/odoo/addons/base/models/ir_ui_view.py", line 400, in _validate',
    '    raise ValidationError(msg)',
    '  File "/repos/tap/main/idx_sale_note_t/views/sale_order_views.xml", line 5, in _apply',
    '    <field name="note_t"/>',
    'odoo.tools.convert.ParseError: Invalid view: field "note_t" does not exist',
    '完整 log：C:\odoo-v2\data\logs\deploy-task52-3.log'
  ].join('\n');
  const { gate, body } = distillFeedback(raw);
  expect(gate).toBe('部署測試區升級失敗');
  expect(body).toContain('idx_sale_note_t');           // 模組 frame 留下
  expect(body).toContain('ParseError');                // 例外行留下
  expect(body).not.toContain('ir_ui_view.py');         // framework frame 砍掉
  expect(body).toContain('完整 log：');                 // 逃生口保留
});

test('B-3 distillFeedback：QA 自然語言 → 去標籤後近原樣', () => {
  const { distillFeedback } = require('../pipeline/task-agent');
  const { gate, body } = distillFeedback('[QA 未通過]\n欄位 note_t 應為 Text 型別，實作用了 Char');
  expect(gate).toBe('QA 未通過');
  expect(body).toContain('note_t 應為 Text 型別');
});

// ---- B-5 runTaskCoding resume/fresh 分流 ----
async function insertCodingTask(suffix, extra = {}) {
  const cols = ['user_id','task_id','source','title','analysis_yaml','git_branch','status','project_id'];
  const vals = [userId, `ta_${suffix}`, 'odoo', 'T', 'module: idx_x\nrequirements:\n  - 加欄位 note_t', `task/ta_${suffix}`, 'coding_running', projectId];
  for (const [k, v] of Object.entries(extra)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals
  );
  return t.id;
}

test('B-5 首次 coding（無 session）→ fresh 全量、存 session_id、count=0', async () => {
  const calls = mockClaude({ onCall: (child) => { emitInit(child, 'sess-fresh-1'); emitResult(child); child.emit('close', 0); } });
  const id = await insertCodingTask('fresh1');
  await runTaskCoding(id, userId);

  expect(calls[0].args).not.toContain('--resume');           // 走 fresh
  expect(calls[0].stdin).toContain('加欄位 note_t');          // 全量規格有帶
  const { rows: [t] } = await dbModule.query('SELECT coding_session_id, coding_resume_count, status FROM tasks WHERE id=$1', [id]);
  expect(t.coding_session_id).toBe('sess-fresh-1');
  expect(t.coding_resume_count).toBe(0);
  expect(t.status).toBe('qa_running');
});

test('B-5 重跑（有 session、count<2）→ resume 短 prompt（不含全量規格）、count+1', async () => {
  const calls = mockClaude({ onCall: (child) => { emitInit(child, 'sess-keep'); emitResult(child); child.emit('close', 0); } });
  const id = await insertCodingTask('resume1', {
    coding_session_id: 'sess-keep', coding_resume_count: 0,
    retry_feedback: '[QA 未通過]\n欄位 note_t 型別錯誤'
  });
  await runTaskCoding(id, userId);

  expect(calls[0].args).toContain('--resume');
  expect(calls[0].args).toContain('sess-keep');
  expect(calls[0].stdin).toContain('note_t 型別錯誤');         // 蒸餾 feedback 有帶
  expect(calls[0].stdin).not.toContain('requirements:');       // 關鍵：不再送全量規格 → 省 token
  const { rows: [t] } = await dbModule.query('SELECT coding_resume_count, retry_feedback, status FROM tasks WHERE id=$1', [id]);
  expect(t.coding_resume_count).toBe(1);
  expect(t.retry_feedback).toBeNull();
  expect(t.status).toBe('qa_running');
});

test('B-5 重跑達上限（count=2）→ 強制 fresh 全量、session 更新、count 歸 0', async () => {
  const calls = mockClaude({ onCall: (child) => { emitInit(child, 'sess-new-gen'); emitResult(child); child.emit('close', 0); } });
  const id = await insertCodingTask('exhaust', {
    coding_session_id: 'sess-old', coding_resume_count: 2,
    retry_feedback: '[QA 未通過]\n又錯了'
  });
  await runTaskCoding(id, userId);

  expect(calls[0].args).not.toContain('--resume');             // 強制 fresh
  expect(calls[0].stdin).toContain('requirements:');           // 全量規格回來了
  const { rows: [t] } = await dbModule.query('SELECT coding_session_id, coding_resume_count FROM tasks WHERE id=$1', [id]);
  expect(t.coding_session_id).toBe('sess-new-gen');            // 換新 session
  expect(t.coding_resume_count).toBe(0);                       // 歸零
});

test('B-5 resume 快速失敗（error）→ 同次 fallback fresh、session 清空、最終成功', async () => {
  let n = 0;
  const calls = mockClaude({ onCall: (child) => {
    n++;
    if (n === 1) { child.emit('close', 1); }                  // resume：session 不存在，秒退非零
    else { emitInit(child, 'sess-refresh'); emitResult(child); child.emit('close', 0); } // fallback fresh 成功
  }});
  const id = await insertCodingTask('fb', {
    coding_session_id: 'sess-gone', coding_resume_count: 0,
    retry_feedback: '[QA 未通過]\n修這個'
  });
  await runTaskCoding(id, userId);

  expect(calls.length).toBe(2);                                // resume + fallback fresh
  expect(calls[0].args).toContain('--resume');
  expect(calls[1].args).not.toContain('--resume');
  expect(calls[1].stdin).toContain('requirements:');           // fallback 用全量
  const { rows: [t] } = await dbModule.query('SELECT coding_session_id, coding_resume_count, status FROM tasks WHERE id=$1', [id]);
  expect(t.coding_session_id).toBe('sess-refresh');
  expect(t.status).toBe('qa_running');
});

// 逾時/暫停不 fallback 的分類（純函式，避免測試真的等 600s timer）
test('B-5 shouldResumeFallback：只有 error 值得 fallback，timeout/aborted 不', () => {
  const { shouldResumeFallback } = require('../pipeline/task-agent');
  expect(shouldResumeFallback({ claudeStatus: 'error' })).toBe(true);
  expect(shouldResumeFallback({ claudeStatus: 'timeout' })).toBe(false);
  expect(shouldResumeFallback({ claudeStatus: 'aborted' })).toBe(false);
});

test('B-5 resume 遇中止類失敗（aborted，同 timeout 分類）→ stopped，不 fallback（只呼叫一次）', async () => {
  const { spawn } = require('child_process');
  const ctrl = new AbortController();
  let count = 0;
  spawn.mockImplementation(() => {
    count++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { write: () => {}, end: () => setImmediate(() => ctrl.abort()) }; // 觸發 abort → spawnClaude 以 aborted reject
    return child;
  });
  const id = await insertCodingTask('to', {
    coding_session_id: 'sess-slow', coding_resume_count: 0,
    retry_feedback: '[QA 未通過]\n修這個'
  });
  await runTaskCoding(id, userId, ctrl.signal);

  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(count).toBe(1); // aborted/timeout 類不得 fallback 再燒一次
});


// ===== 主題 C：一個任務一個 worktree，analysis 建、coding 沿用、併 main 後才刪（U7）=====

test('C-3 analysis 在「任務 worktree」讀最新 main（reset=true），且讀完不移除（留給 coding 沿用）', async () => {
  const git = require('../pipeline/git');
  git.pullBranch.mockReset().mockResolvedValue(undefined);
  git.ensureMainBranch.mockReset().mockResolvedValue('main');
  git.ensureWorktreeAtMain.mockReset().mockResolvedValue(undefined);

  const calls = mockClaude({ onCall: (child) => {
    child.stdout.emit('data', JSON.stringify({ type: 'result',
      result: '---RESULT-JSON---\n{"status":"branch_pending","analysis_yaml":"module: idx_x"}\n---END-RESULT---',
      usage: null, duration_ms: 5 }) + '\n');
    child.emit('close', 0);
  }});

  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ana_iso','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);

  // 建立任務 worktree（branch task/<id>、reset=true 讀最新 main）；worktree 路徑用 task_id（非拋棄式）
  expect(git.ensureWorktreeAtMain).toHaveBeenCalledWith(
    '/repos/tap/main', expect.stringContaining('ana_iso'), 'task/ana_iso', 'main', true
  );
  // claude cwd 是任務 worktree 父目錄（coding 之後會沿用同一個）
  expect(calls[0].cwd).toContain(path.join('.worktrees', 'ana_iso'));
});
