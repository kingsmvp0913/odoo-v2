// 意圖：專案分析前必須先 pull main 讀最新碼；pull 失敗（origin 不通／本地髒）
// 屬環境問題，停下等人工，不得拿舊碼繼續分析。
const { newDb } = require('pg-mem');
const { EventEmitter } = require('events');
const path = require('path');
process.env.APP_SECRET = 'test-app-secret';
const { encrypt } = require('../lib/crypto');

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
  child.stdout.emit('data', JSON.stringify({ type: 'result', result: `<result>\n{"status":"${status}"}\n</result>`, usage: null, duration_ms: 10 }) + '\n');
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
    "INSERT INTO users (username, password_hash, display_name, github_pat_enc, github_login, git_name, git_email) VALUES ('ta', $1, 'T', $2, 'ta', 'T', 'ta@users.noreply.github.com') RETURNING id",
    [hash, encrypt('test-pat-token')]
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

test('任務發起人未設 PAT → 停任務、blocker=git_cred', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('ta_nopat', $1, 'NoPat') RETURNING id", [hash]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_nopat','odoo','T','需求','analysis_running',$2) RETURNING id",
    [u.id, projectId]
  );
  const handled = await runTaskAnalysis(t.id, u.id);
  expect(handled).toBe(true);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_type, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_type).toBe('git_cred');
  expect(after.blocker_content).toMatch(/PAT/);
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
          child.stdout.emit('data', JSON.stringify({ type: 'result', result: '<result>\n{"status":"qa_running"}\n</result>', usage: null, duration_ms: 10 }) + '\n');
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

// （B-1 runner 的 session_id 捕捉／--resume 測試已隨 runner 合併移至 claude-runner.test.js）

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

// 意圖：QA 的 issues 是「當下完整未解清單」，截斷會讓 coding 看不到部分問題→白跑一輪
// （QA gate 沒有 deploy/E2E 的「完整 log」逃生口，截掉就真的丟了）
test('B-3 distillFeedback：QA 未解清單不截斷（跳過 400 字上限）', () => {
  const { distillFeedback } = require('../pipeline/task-agent');
  const issues = Array.from({ length: 12 }, (_, i) => `問題 ${i + 1}：欄位 f${i} 未依規格實作（規格要求 Text 型別且需 tracking，實作用了 Char 也漏了 tracking），請修正後以存檔重載驗證`).join('\n');
  const { gate, body } = distillFeedback(`[QA 未通過]\n${issues}`);
  expect(gate).toBe('QA 未通過');
  expect(body.length).toBeGreaterThan(400);
  expect(body).toContain('問題 12');   // 清單尾端不得被截掉
  expect(body).not.toContain('…');
});

test('B-3 distillFeedback：人工退回原因不截斷（跳過 400 字上限）', () => {
  const { distillFeedback } = require('../pipeline/task-agent');
  const longReason = '問題一：備註欄位型別錯，應為 Text；'.repeat(30); // 遠超過 400 字
  const raw = `[人工退回]\n${longReason}`;
  const { gate, body } = distillFeedback(raw);
  expect(gate).toBe('人工退回');
  expect(body.length).toBeGreaterThan(400);
  expect(body).not.toContain('…');
  expect(body).toBe(longReason.trim());
});

// ---- B-5 runTaskCoding（無狀態：一律 fresh 統一 prompt，不 --resume）----
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

test('B-5 首次 coding → fresh 全量、存 session_id marker、進 QA', async () => {
  const calls = mockClaude({ onCall: (child) => { emitInit(child, 'sess-fresh-1'); emitResult(child); child.emit('close', 0); } });
  const id = await insertCodingTask('fresh1');
  await runTaskCoding(id, userId);

  expect(calls[0].args).not.toContain('--resume');           // 無狀態，永不 resume
  expect(calls[0].stdin).toContain('加欄位 note_t');          // 全量規格有帶
  const { rows: [t] } = await dbModule.query('SELECT coding_session_id, status FROM tasks WHERE id=$1', [id]);
  expect(t.coding_session_id).toBe('sess-fresh-1');          // 記 marker（供 respec 判「已開工」）
  expect(t.status).toBe('qa_running');
});

// 意圖（核心）：無狀態——即使任務已有前一輪 session id 與 retry_feedback，也一律 fresh、不 --resume，
// 且送「全量規格＋retry_feedback」讓 coding 讀 worktree 既有碼做增量修（不重寫）。
test('B-5 有 session＋feedback 的修正輪 → 仍 fresh（不 --resume）、送全量＋feedback、消費 feedback', async () => {
  const calls = mockClaude({ onCall: (child) => { emitInit(child, 'sess-2'); emitResult(child); child.emit('close', 0); } });
  const id = await insertCodingTask('retry1', {
    coding_session_id: 'sess-prev',
    retry_feedback: '[QA 未通過]\n欄位 note_t 型別錯誤'
  });
  await runTaskCoding(id, userId);

  expect(calls[0].args).not.toContain('--resume');            // 關鍵：修正輪也不 resume
  expect(calls[0].stdin).toContain('requirements:');           // 送全量規格（讓它讀 spec）
  expect(calls[0].stdin).toContain('note_t 型別錯誤');         // 帶 retry_feedback
  const { rows: [t] } = await dbModule.query('SELECT retry_feedback, status FROM tasks WHERE id=$1', [id]);
  expect(t.retry_feedback).toBeNull();                         // 成功推進即消費
  expect(t.status).toBe('qa_running');
});

test('B-5 coding 遇手動暫停（aborted）→ 狀態原地不動、不列入 blocker', async () => {
  const { spawn } = require('child_process');
  const ctrl = new AbortController();
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { write: () => {}, end: () => setImmediate(() => ctrl.abort()) }; // 觸發 abort → runClaude 以 aborted reject
    return child;
  });
  const id = await insertCodingTask('abort1', { retry_feedback: '[QA 未通過]\n修這個' });
  await runTaskCoding(id, userId, ctrl.signal);

  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running'); // 手動暫停非失敗，留在原關卡，解除暫停後續跑
  expect(t.blocker_content).toBeNull();
});


// ===== 主題 C：一個任務一個 worktree，analysis 建、coding 沿用、併 main 後才刪（U7）=====

test('C-3 analysis 在「任務 worktree」讀最新 main（reset=true），且讀完不移除（留給 coding 沿用）', async () => {
  const git = require('../pipeline/git');
  git.pullBranch.mockReset().mockResolvedValue(undefined);
  git.ensureMainBranch.mockReset().mockResolvedValue('main');
  git.ensureWorktreeAtMain.mockReset().mockResolvedValue(undefined);

  const calls = mockClaude({ onCall: (child) => {
    child.stdout.emit('data', JSON.stringify({ type: 'result',
      result: '<result>\ncase_id: "ana_iso"\nmodule: idx_x\nodoo_version: "17.0"\nexecution_mode: "MODE_A"\nsummary: "s"\n</result>',
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

// ===== 主題 F：agent 契約強化 =====

// 意圖：被下游退回重跑時「同樣的腦袋再猜一次」收斂率低；有 retry_feedback 即升級 opus，省 token 又提高收斂。
test('F-escalate：coding 首輪用 sonnet；有 retry_feedback 的修正輪升級 opus（皆不 resume）', async () => {
  let calls = mockClaude({ onCall: (c) => { emitInit(c, 's1'); emitResult(c); c.emit('close', 0); } });
  const id1 = await insertCodingTask('esc_fresh');
  await runTaskCoding(id1, userId);
  expect(calls[0].args[calls[0].args.indexOf('--model') + 1]).toBe('sonnet'); // 首輪不升級

  calls = mockClaude({ onCall: (c) => { emitInit(c, 's2'); emitResult(c); c.emit('close', 0); } });
  const id2 = await insertCodingTask('esc_retry', { retry_feedback: '[QA 未通過]\n欄位型別錯' });
  await runTaskCoding(id2, userId);
  expect(calls[0].args).not.toContain('--resume');                            // 無狀態，不 resume
  expect(calls[0].args[calls[0].args.indexOf('--model') + 1]).toBe('opus');    // 修正輪升級
});

// 意圖（Rule 12 fail-loud）：殘缺 SD 不得靜默放行成 branch_pending——缺必要欄位的規格進 coding
// 只會拿垃圾規格燒 token。新契約（裸 YAML＋server 端推導 status）下的等價防線是必要欄位驗證。
test('F-failloud：analysis YAML 缺必要欄位 → stopped（不靜默放行 branch_pending）', async () => {
  const g = require('../pipeline/git');
  g.pullBranch.mockReset().mockResolvedValue(undefined);
  g.ensureMainBranch.mockReset().mockResolvedValue('main');
  g.ensureWorktreeAtMain.mockReset().mockResolvedValue(undefined);
  mockClaude({ onCall: (c) => {
    c.stdout.emit('data', JSON.stringify({ type: 'result',
      result: '<result>\nmodule: idx_x\n</result>',  // 缺 case_id/odoo_version/execution_mode/summary
      usage: null, duration_ms: 5 }) + '\n');
    c.emit('close', 0);
  }});
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_unknown','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('必要欄位');
});

// 新契約：agent 判定完全無法分析時只回 stopped_reason 欄位 → stopped 且原因給使用者看
test('F-failloud：analysis 回 stopped_reason → stopped 帶原因', async () => {
  const g = require('../pipeline/git');
  g.pullBranch.mockReset().mockResolvedValue(undefined);
  g.ensureMainBranch.mockReset().mockResolvedValue('main');
  g.ensureWorktreeAtMain.mockReset().mockResolvedValue(undefined);
  mockClaude({ onCall: (c) => {
    c.stdout.emit('data', JSON.stringify({ type: 'result',
      result: '<result>\nstopped_reason: "需求描述空白，無法分析"\n</result>',
      usage: null, duration_ms: 5 }) + '\n');
    c.emit('close', 0);
  }});
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_stopped','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('無法分析');
});
