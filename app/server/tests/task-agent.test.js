// 意圖：專案分析前必須先 pull main 讀最新碼；pull 失敗（origin 不通／本地髒）
// 屬環境問題，停下等人工，不得拿舊碼繼續分析。
const { newDb } = require('pg-mem');
const { EventEmitter } = require('events');
const path = require('path');
// 核心 source 供給走 docker 解壓——單測不碰真 docker，回固定守則字串（真行為由 odoo-core-src.test.js 驗）
jest.mock('../lib/odoo-core-src', () => ({ coreSourceGuidance: () => '（測試：核心來源守則）', ensureOdooCoreSrc: () => '', majorOf: (v) => String(v || '').split('.')[0] }));
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
jest.mock('../pipeline/git', () => {
  // revParse 預設每次回不同 SHA＝「本輪有新 commit」，讓既有測試維持原語意；
  // 要測「無新 commit」的案例自行 mockResolvedValue 成固定值。
  let sha = 0;
  return {
    pullBranch: jest.fn(),
    ensureMainBranch: jest.fn().mockResolvedValue('main'),
    ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined),
    getMainBranch: jest.fn().mockResolvedValue('main'),
    AI_BRANCH: 'ai-dev',
    ensureAiBranch: jest.fn().mockResolvedValue('ai-dev'),
    syncMainIntoAi: jest.fn().mockResolvedValue({ hasConflicts: false, conflictFiles: [] }),
    commitResolved: jest.fn().mockResolvedValue(undefined),
    abortMerge: jest.fn().mockResolvedValue(undefined),
    revParse: jest.fn(() => Promise.resolve(`sha-${++sha}`))
  };
});
jest.mock('../pipeline/merge-agent', () => ({
  resolveConflicts: jest.fn().mockResolvedValue({ failed: [], details: {} }),
  SYNC_LABELS: { oursLabel: 'ai-dev（AI 現況）', theirsLabel: 'main（工程師新進）' }
}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

let dbModule, runTaskAnalysis, runTaskCoding, git, mergeAgent;
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
  mergeAgent = require('../pipeline/merge-agent');
  ({ runTaskAnalysis, runTaskCoding } = require('../pipeline/task-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('分析前同步 ai-dev 失敗 → 任務 stopped，不繼續分析', async () => {
  git.syncMainIntoAi.mockRejectedValueOnce(new Error('could not resolve host github.com'));
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_pull','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  const handled = await runTaskAnalysis(t.id, userId);
  expect(handled).toBe(true);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('ai-dev');
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

// 意圖：cs 判 code_change_clear 時查過的初步定因（cs_findings）要帶進分析 prompt，讓分析從此起步、
// 不必從零重查同一根因（省 token）；且必須標明「待驗證、勿直接採信」，避免分析盲信 cs 可能的錯判。
test('cs_findings（客服初步定因）帶進分析 prompt 且標明待驗證', async () => {
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
      end: () => { setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'result', result: '<result>\ncase_id: "x"\nmodule: "idx_x"\n</result>', usage: null, duration_ms: 10 }) + '\n');
        child.emit('close', 0);
      }); }
    };
    return child;
  });

  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, cs_findings) VALUES ($1,'ta_csf','service','指派評估設定','指派評估如何設定','analysis_running',$2,$3) RETURNING id",
    [userId, projectId, '按鈕 groups 漏資材主管群組，idx_maintenance.xml:159，設定無法解決']
  );
  await runTaskAnalysis(t.id, userId).catch(() => {});
  expect(captured).toContain('按鈕 groups 漏資材主管群組');   // cs 定因進 prompt
  expect(captured).toContain('待驗證');                      // 標明勿直接採信
  // {{odoo_core_src}} 漏傳只會 console.warn，資料來源段會整段變空白（連禁止掃碟的警告都沒了）
  expect(captured).toContain('（測試：核心來源守則）');
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
  expect(calls[0].stdin).toContain('（測試：核心來源守則）');   // {{odoo_core_src}} 有傳，不是空白段
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

// 意圖：coding 帶著失敗回饋卻一個 commit 都沒產生 ⇒ 這輪什麼都沒改。放行進 QA 只會讓 QA 判
// 「same diff、已審過」照樣 pass，再部署一次必然重現同一個失敗——白燒整條 pipeline 還多吃一次
// 彈跳計數（實測 task 109）。推進與否由結構決定，不能靠 agent 自律（rules/pipeline.md 60）。
// retry_feedback 刻意不消費：下一輪（或人工續跑）仍要讀得到原始失敗訊息，否則又退回空輸入。
test('B-5 帶失敗回饋卻無新 commit → stopped，不放行進 QA', async () => {
  mockClaude({ onCall: (child) => { emitInit(child, 'sess-nodiff'); emitResult(child); child.emit('close', 0); } });
  git.revParse.mockResolvedValue('sha-unchanged'); // 前後同 SHA＝本輪無 commit
  const id = await insertCodingTask('nodiff1', { retry_feedback: '[部署測試區 asset 檢查失敗]\nbundle 500' });
  await runTaskCoding(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.retry_feedback).toContain('bundle 500');            // 不消費，續跑仍讀得到
  expect(t.blocker_content).toContain('未產生任何程式變更');
});

// 鑑別力對照：同樣帶失敗回饋，但真的改了東西（HEAD 前進）→ 必須照常放行，不得誤擋。
test('B-5 帶失敗回饋且有新 commit → 照常進 QA', async () => {
  mockClaude({ onCall: (child) => { emitInit(child, 'sess-hasdiff'); emitResult(child); child.emit('close', 0); } });
  let n = 0;
  git.revParse.mockImplementation(() => Promise.resolve(`sha-moved-${++n}`));
  const id = await insertCodingTask('hasdiff1', { retry_feedback: '[QA 未通過]\n圖示 class 用錯' });
  await runTaskCoding(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('qa_running');
});

// 不誤傷：分診判 resume 把任務放回 coding（無 retry_feedback）時，本來就可能無事可做。
// 這種情況沒有「必然重現的失敗」在等著，照常放行——守衛只針對「帶著失敗回饋卻沒改東西」。
test('B-5 無失敗回饋且無新 commit → 不誤判，照常進 QA', async () => {
  mockClaude({ onCall: (child) => { emitInit(child, 'sess-noresume'); emitResult(child); child.emit('close', 0); } });
  git.revParse.mockResolvedValue('sha-unchanged');
  const id = await insertCodingTask('nodiff2');
  await runTaskCoding(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('qa_running');
});

// 意圖：HEAD 快照讀不到（worktree 尚未建立／unborn HEAD／git 呼叫失敗）＝無法確認有沒有變更，
// 不是「確認沒有變更」。若把讀不到當成無變更，快照一失敗就會把每一輪修正輪都誤判成空轉而卡死
// ——空物件的 every() 恆為 true，這個坑實測讓 workflow-scenarios 的 S1/S2/S5a/S6 全滅。
// 防呆只在有確證時才動手；沒有證據一律放行。
test('B-5 HEAD 快照讀不到 → 視為無法確認，不得誤擋（照常進 QA）', async () => {
  mockClaude({ onCall: (child) => { emitInit(child, 'sess-nohead'); emitResult(child); child.emit('close', 0); } });
  git.revParse.mockRejectedValue(new Error('not a git repository'));
  const id = await insertCodingTask('nohead1', { retry_feedback: '[部署測試區升級失敗]\nParseError' });
  await runTaskCoding(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
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

  // 建立任務 worktree（branch task/<id>、reset=true、base=ai-dev＝任務切點）；worktree 路徑用 task_id（非拋棄式）
  expect(git.ensureWorktreeAtMain).toHaveBeenCalledWith(
    '/repos/tap/main', expect.stringContaining('ana_iso'), 'task/ana_iso', 'ai-dev', true,
    expect.objectContaining({ GIT_COMMITTER_NAME: expect.any(String) })
  );
  // claude cwd 是任務 worktree 父目錄（coding 之後會沿用同一個）
  expect(calls[0].cwd).toContain(path.join('.worktrees', 'ana_iso'));
});

// ===== 主題 F：agent 契約強化 =====

// 意圖：被下游退回重跑不再升 opus——升更貴的腦袋對 deploy/E2E 這類非邏輯失敗（環境/污染/暫時性）無助益且燒錢；
// 改由總循環上限（MAX_REENTRY）超過即 stopped 交人工。修正輪一律用 coding 預設模型、且無狀態不 resume。
test('F-noescalate：coding 首輪與修正輪都用 sonnet（不升 opus）、皆不 resume', async () => {
  let calls = mockClaude({ onCall: (c) => { emitInit(c, 's1'); emitResult(c); c.emit('close', 0); } });
  const id1 = await insertCodingTask('esc_fresh');
  await runTaskCoding(id1, userId);
  expect(calls[0].args[calls[0].args.indexOf('--model') + 1]).toBe('sonnet'); // 首輪

  calls = mockClaude({ onCall: (c) => { emitInit(c, 's2'); emitResult(c); c.emit('close', 0); } });
  const id2 = await insertCodingTask('esc_retry', { retry_feedback: '[QA 未通過]\n欄位型別錯' });
  await runTaskCoding(id2, userId);
  expect(calls[0].args).not.toContain('--resume');                            // 無狀態，不 resume
  expect(calls[0].args[calls[0].args.indexOf('--model') + 1]).toBe('sonnet');  // 修正輪不再升 opus
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

// ===== 主題 G：切點改 ai-dev、開工前同步 main（Task 6）=====
// 沿用本檔既有的 git mock 樣態（git.<fn>），非 brief 假設的獨立 gitMock/queryMock 變數；
// merge_conflict_data 走真的 pg-mem DB（TEXT 欄位），比照 merge-agent.test.js 的 JSON.parse 慣例讀回。

test('G-1 analysis 開工：worktree 從 ai-dev 切，不從 main 切', async () => {
  mockClaude();
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g1','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);
  expect(git.ensureWorktreeAtMain).toHaveBeenCalledWith(
    '/repos/tap/main', expect.any(String), 'task/ta_g1', 'ai-dev', true,
    // 帶 gitEnv：reset 時若分支已有實作 commit 會走 merge，非 ff 需建 commit ⇒ 沒身分會靜默 abort
    expect.objectContaining({ GIT_COMMITTER_NAME: 'T' })
  );
});

test('G-2 先 ensureAiBranch 再 syncMainIntoAi，順序不可顛倒（ai-dev 不存在時 sync 會 checkout 失敗）', async () => {
  mockClaude();
  // 必須清掉先前測試的呼叫紀錄：invocationCallOrder[0] 取的是整個測試檔第一次呼叫，
  // 不清就算本 run 順序顛倒也照樣拿到舊的正確順序＝這條硬約束的唯一守門測試永遠不會紅。
  git.ensureAiBranch.mockClear();
  git.syncMainIntoAi.mockClear();
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g2','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);
  const ensureOrder = git.ensureAiBranch.mock.invocationCallOrder[0];
  const syncOrder = git.syncMainIntoAi.mock.invocationCallOrder[0];
  expect(ensureOrder).toBeLessThan(syncOrder);
});

test('G-3 sync 衝突且自動解不掉 → 停 merge_conflict，資料帶 sync 旗標與 prior_status，且不 abortMerge（留 MERGE_HEAD 給裁決端點收尾）', async () => {
  git.abortMerge.mockClear();
  git.syncMainIntoAi.mockResolvedValueOnce({ hasConflicts: true, conflictFiles: ['a.py'] });
  mergeAgent.resolveConflicts.mockResolvedValueOnce({ failed: ['a.py'], details: { 'a.py': { recommendation: 'manual' } } });
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g3','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  const handled = await runTaskAnalysis(t.id, userId);
  expect(handled).toBe(true);
  const { rows: [after] } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('merge_conflict');
  const cd = typeof after.merge_conflict_data === 'string' ? JSON.parse(after.merge_conflict_data) : after.merge_conflict_data;
  expect(cd.sync).toBe(true);
  expect(cd.prior_status).toBe('analysis_running'); // 裁決完要能回到分析重跑
  expect(cd.repos[0].files).toEqual(['a.py']);
  expect(git.abortMerge).not.toHaveBeenCalled(); // 裁決端點的 concludeMerge 要靠 MERGE_HEAD 收尾，這裡不可清
  // I-1：sync 的兩側語意與「併入 testing」相反（ours=ai-dev 的 AI 碼、theirs=main 的工程師碼），
  // 不帶標籤時 merge-explain 會把工程師的碼講成「本次任務刻意的升級」、建議系統性偏 take_theirs
  expect(mergeAgent.resolveConflicts).toHaveBeenCalledWith(
    '/repos/tap/main', ['a.py'],
    expect.objectContaining({ oursLabel: 'ai-dev（AI 現況）', theirsLabel: 'main（工程師新進）' }),
    undefined
  );
});

test('G-4 sync 衝突但自動解光了 → commit 後照常繼續分析，不停任務', async () => {
  mockClaude();
  git.syncMainIntoAi.mockResolvedValueOnce({ hasConflicts: true, conflictFiles: ['a.py'] });
  mergeAgent.resolveConflicts.mockResolvedValueOnce({ failed: [], details: {} });
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g4','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);
  expect(git.commitResolved).toHaveBeenCalledWith('/repos/tap/main', ['a.py'], '[sync] main → ai-dev (resolve conflicts)');
  const { rows: [after] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).not.toBe('merge_conflict'); // 解光了就不該卡人
});

test('G-5 sync 期間手動暫停 → 狀態原地不動、不誤標 merge_conflict 也不標 stopped，且先清半套 merge（否則重跑會在 checkout main 撞牆）', async () => {
  git.abortMerge.mockClear();
  git.syncMainIntoAi.mockResolvedValueOnce({ hasConflicts: true, conflictFiles: ['a.py'] });
  mergeAgent.resolveConflicts.mockResolvedValueOnce({ aborted: true, failed: [], details: {} });
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g5','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  const handled = await runTaskAnalysis(t.id, userId);
  expect(handled).toBe(true);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('analysis_running'); // 原地不動，解除暫停後從這一關重跑
  expect(after.blocker_content).toBeNull();
  expect(git.abortMerge).toHaveBeenCalledWith('/repos/tap/main');
});

test('G-6 setupErr（sync 之外的例外，如建 worktree 失敗）→ stopped 前先清半套 merge，避免污染同專案後續任務', async () => {
  git.abortMerge.mockClear();
  git.ensureWorktreeAtMain.mockRejectedValueOnce(new Error('boom worktree'));
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g6','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  const handled = await runTaskAnalysis(t.id, userId);
  expect(handled).toBe(true);
  expect(git.abortMerge).toHaveBeenCalledWith('/repos/tap/main');
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('boom worktree');
});

// 意圖：主 clone 殘留 MERGE_HEAD 時的進場守衛（比照 merge-agent.js doMerge 的同名守衛語意）；
// 用真的暫存目錄＋真的 .git/MERGE_HEAD 檔案，因為 task-agent.js 用真的 fs.existsSync 判斷（未 mock fs）。
test('G-9 進場守衛：主 clone 殘留 MERGE_HEAD 且同專案另一任務卡 merge_conflict 待人工解 → 本輪不動作', async () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-guard-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'abcdef\n');

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TAP-G9', '17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [proj.id, dir]
  );
  // 同專案另一任務正卡在 merge_conflict（人工正在裁決）
  const { rows: [blocker] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g9_other','odoo','T','c','merge_conflict',$2) RETURNING id",
    [userId, proj.id]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g9','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, proj.id]
  );

  const handled = await runTaskAnalysis(t.id, userId);
  expect(handled).toBe(true);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_type, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('analysis_running'); // 本輪不動作，非 stopped（否則失敗代價比 merge 那關更高）
  // I-3 fail loud：狀態不變，但卡住原因必須落地。原本只送一則 socket 事件＝沒開終端面板就永遠看不到，
  // 任務可能「分析中」掛好幾天沒人知道在等誰。
  expect(after.blocker_type).toBe('sync_wait');
  expect(after.blocker_content).toContain(`#${blocker.id}`);
});

// 意圖（I-3 的另一半）：擋住的原因消失後要自己清掉，否則畫面會一直掛著已不成立的等待訊息。
test('G-9b 擋住的衝突任務解決後 → 下一輪同步照常進行，sync_wait 等待訊息清空', async () => {
  const fs = require('fs');
  const os = require('os');
  mockClaude({ onCall: (c) => {
    c.stdout.emit('data', JSON.stringify({ type: 'result',
      result: '<result>\ncase_id: "g9b"\nmodule: idx_x\nodoo_version: "17.0"\nexecution_mode: "MODE_A"\nsummary: "s"\n</result>',
      usage: null, duration_ms: 5 }) + '\n');
    c.emit('close', 0);
  }});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-guard-clear-'));
  fs.mkdirSync(path.join(dir, '.git'));

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TAP-G9B', '17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [proj.id, dir]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, blocker_type, blocker_content) VALUES ($1,'ta_g9b','odoo','T','需求','analysis_running',$2,'sync_wait','等待任務 #999 的同步衝突處理完成') RETURNING id",
    [userId, proj.id]
  );

  await runTaskAnalysis(t.id, userId); // 無 MERGE_HEAD → 守衛不觸發
  const { rows: [after] } = await dbModule.query('SELECT blocker_type, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.blocker_type).toBeNull();
  expect(after.blocker_content).toBeNull();
});

test('G-10 進場守衛：主 clone 殘留 MERGE_HEAD 但無人在裁決（前一輪殘留）→ abortMerge 自癒後照常同步', async () => {
  const fs = require('fs');
  const os = require('os');
  mockClaude();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-guard-heal-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'abcdef\n');
  git.abortMerge.mockClear();

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TAP-G10', '17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [proj.id, dir]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_g10','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, proj.id]
  );

  await runTaskAnalysis(t.id, userId);
  expect(git.abortMerge).toHaveBeenCalledWith(dir); // 自癒
  expect(git.ensureAiBranch).toHaveBeenCalledWith(dir, expect.anything()); // 自癒後照常繼續同步
});

// 意圖：留言的銷帳時點必須是「analysis 真的產出規格」，不能提前。
// assembleTaskContext 不看 applied_at、會把所有留言讀進 original_text，所以只有這一輪跑完並寫出
// analysis_yaml，才代表需求真的進了規格。分診的 respec 分支曾在跳關前就先銷帳，但那一輪可能失敗、
// 被中止或使用者中途插手，第二輪分診改判 fix／advance 時留言已被標成已吸收＝需求永久消失，
// 而且證據（applied_at IS NULL 這個待辦訊號）被自己刪掉，事後查不出來。
function mockAnalysisResult(yamlBody) {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write: () => {},
      end: () => { setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'result', result: `<result>\n${yamlBody}\n</result>`, usage: null, duration_ms: 10 }) + '\n');
        child.emit('close', 0);
      }); }
    };
    return child;
  });
}

test('analysis 成功寫出規格 → 該批留言才銷帳', async () => {
  mockAnalysisResult('case_id: "x"\nmodule: "idx_x"\nexecution_mode: "MODE_A"\nsummary: "s"\nodoo_version: "17.0"');
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_absorb_ok','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me','順便把單價改成可編輯',NOW())", [t.id]
  );
  await runTaskAnalysis(t.id, userId).catch(() => {});
  const { rows: [m] } = await dbModule.query('SELECT applied_at FROM task_messages WHERE task_id=$1', [t.id]);
  expect(m.applied_at).not.toBeNull();
});

// Fix round 1（spec_review session 清除點）：這裡才是「analysis 重產規格」真正落地的地方——
// task-agent.js 的規格寫入必須經 writeAnalysisYaml 清掉 spec_session_id／spec_prompt_ver，
// 否則重跑 analysis 後再進 spec_review，下一場對話會續接到記著舊規格的 claude session。
test('analysis 成功寫出新規格 → 清掉舊的 spec_session_id／spec_prompt_ver', async () => {
  mockAnalysisResult('case_id: "x"\nmodule: "idx_x"\nexecution_mode: "MODE_A"\nsummary: "s"\nodoo_version: "17.0"');
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, spec_session_id, spec_prompt_ver) VALUES ($1,'ta_specclear','odoo','T','需求','analysis_running',$2,'sp-stale','F.R') RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId).catch(() => {});
  const { rows: [after] } = await dbModule.query('SELECT spec_session_id, spec_prompt_ver FROM tasks WHERE id=$1', [t.id]);
  expect(after.spec_session_id).toBeNull();
  expect(after.spec_prompt_ver).toBeNull();
});

test('analysis 沒產出有效規格（停在 stopped）→ 留言不得銷帳，留給下一輪', async () => {
  mockAnalysisResult('這不是有效的規格物件');   // 缺必要欄位 → 走 stopped，不寫 analysis_yaml
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_absorb_fail','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me','順便把單價改成可編輯',NOW())", [t.id]
  );
  await runTaskAnalysis(t.id, userId).catch(() => {});
  const { rows: [after] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).not.toBe('branch_pending');   // 確認真的沒成功產出規格
  const { rows: [m] } = await dbModule.query('SELECT applied_at FROM task_messages WHERE task_id=$1', [t.id]);
  expect(m.applied_at).toBeNull();                   // 需求還在待辦，不會人間蒸發
});

// --- 規格 tour：分析關續寫（session resume）---
// 意圖：現行順序是 coding 完才產 tour，等於先寫答案再出考題——測試會遷就實作。改成分析關趁 session
// 還熱就依剛定稿的 acceptance 續寫 tour，實作之前先定考題。專案層開關，**預設關閉＝行為完全同現況**。
function analysisSpawn(onStdin) {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const calls = [];
  spawn.mockImplementation((bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const call = { args, stdin: '' };
    calls.push(call);
    child.stdin = {
      write: (d) => { call.stdin += d; if (onStdin) onStdin(d); },
      end: () => setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-analysis' }) + '\n');
        child.stdout.emit('data', JSON.stringify({
          // 必要欄位要齊（REQUIRED_FIELDS）：缺一就會在 writeSpecTour 之前被擋成 stopped
          type: 'result',
          result: '<result>\ncase_id: "x"\nmodule: "idx_x"\nodoo_version: "17.0"\nexecution_mode: "direct"\nsummary: "加跳頁"\n</result>',
          usage: null, duration_ms: 10
        }) + '\n');
        child.emit('close', 0);
      })
    };
    return child;
  });
  return calls;
}

test('spec_tour_enabled=false（預設）→ 分析後不產 tour，只跑一次 claude', async () => {
  const calls = analysisSpawn();
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_notour','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);
  expect(calls).toHaveLength(1);                    // 只有 analysis，沒有續寫 tour
  expect(calls[0].args).not.toContain('--resume');
});

test('spec_tour_enabled=true → 分析後用同一 session --resume 續寫 tour', async () => {
  await dbModule.query('UPDATE projects SET spec_tour_enabled=true WHERE id=$1', [projectId]);
  const calls = analysisSpawn();
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_tour','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);

  expect(calls).toHaveLength(2);                        // analysis + 續寫 tour
  const tourCall = calls[1];
  expect(tourCall.args).toContain('--resume');          // 真的續接，不是 fresh
  expect(tourCall.args).toContain('sess-analysis');     // 續的是分析那個 session
  expect(tourCall.stdin).toContain('acceptance');       // 依驗收條件寫
  expect(tourCall.stdin).toContain('實作還不存在');      // 明確告知不要去找還沒寫的欄位
  expect(tourCall.stdin).not.toContain('<result>');     // tour 類 agent 不得有 result 契約
  await dbModule.query('UPDATE projects SET spec_tour_enabled=false WHERE id=$1', [projectId]);
});

// tour 是加值產物：續寫失敗不得讓已經產出的規格或關卡推進跟著壞掉（Rule 12 的例外要明講）。
test('spec tour 續寫失敗 → 規格照樣落地、任務照樣推進', async () => {
  await dbModule.query('UPDATE projects SET spec_tour_enabled=true WHERE id=$1', [projectId]);
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  let n = 0;
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const isTour = ++n > 1;
    child.stdin = {
      write: () => {},
      end: () => setImmediate(() => {
        if (isTour) { child.emit('close', 1); return; }   // 續寫 tour 那次直接失敗
        child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-analysis' }) + '\n');
        child.stdout.emit('data', JSON.stringify({
          type: 'result',
          result: '<result>\ncase_id: "x"\nmodule: "idx_x"\nodoo_version: "17.0"\nexecution_mode: "direct"\nsummary: "加跳頁"\n</result>',
          usage: null, duration_ms: 10
        }) + '\n');
        child.emit('close', 0);
      })
    };
    return child;
  });
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_tourfail','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  await runTaskAnalysis(t.id, userId);

  const { rows: [after] } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).not.toBe('stopped');       // 沒有被 tour 失敗拖垮
  expect(after.analysis_yaml).toContain('idx_x'); // 規格照樣落地
  await dbModule.query('UPDATE projects SET spec_tour_enabled=false WHERE id=$1', [projectId]);
});
