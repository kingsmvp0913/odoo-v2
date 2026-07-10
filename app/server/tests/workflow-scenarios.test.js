/**
 * workflow-scenarios.test.js — 任務自動工作流程端到端情境模擬
 *
 * 意圖（Rule 9）：既有測試多為單關卡驗證；本檔用「真實 runner 狀態機＋真實 agent 提示詞
 * （agent-loader 讀 .claude/agents/*.md）＋真實各關 handler」跑完整旅程，只 mock 最外圍的
 * claude CLI（scripted 回應）、git 副作用與測試環境指令。守住三件事：
 *   1) 穩定：狀態機在成功／失敗／暫停／分診各情境下收斂到正確終點，不落死狀態、不無限循環。
 *   2) 準確：prompt 組裝正確（placeholder 全數替換、CLAUDE.md 規則注入、澄清/回饋確實帶入）。
 *   3) 省 token：resume 短 prompt 顯著小於全量 prompt、退回重跑升級 opus、feedback 蒸餾生效。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

process.env.DEPLOY_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-deploy-'));
process.env.E2E_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e2e-'));

jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn().mockResolvedValue(undefined),
  checkoutDefault: jest.fn().mockResolvedValue(undefined),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  ensureMainBranch: jest.fn().mockResolvedValue('main'),
  pullBranch: jest.fn().mockResolvedValue(undefined),
  ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined),
  mergeInto: jest.fn().mockResolvedValue({ hasConflicts: false, conflictFiles: [] }),
  commitAll: jest.fn().mockResolvedValue(undefined),
  abortMerge: jest.fn().mockResolvedValue(undefined),
  mergeToMain: jest.fn().mockResolvedValue(undefined),
  deleteBranchLocal: jest.fn().mockResolvedValue(undefined),
  removeWorktree: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/env-agent', () => ({
  upgradeModules: jest.fn().mockResolvedValue({ ok: true, log: '' }),
  runTourTests: jest.fn().mockResolvedValue({ ok: true, log: 'tests passed' }),
  ENV_BASE: '/envs',
  runtimeLogPath: dir => dir + '/odoo.log'
}));
jest.mock('../pipeline/ensure-env', () => ({ ensureEnvRunning: jest.fn().mockResolvedValue(true) }));
// 只 mock runClaude 本體；abortError/stopReason 用真品，確保上層錯誤語意與正式碼一致
jest.mock('../pipeline/claude-runner', () => {
  const actual = jest.requireActual('../pipeline/claude-runner');
  return { ...actual, runClaude: jest.fn() };
});

const { runClaude } = require('../pipeline/claude-runner');

// ---- scripted claude：依 agentType 佇列回應；未編排的呼叫直接 fail loud（Rule 12）----
let script;   // Map<agentType, Array<handler>>
let calls;    // 全部呼叫紀錄 [{agentType, model, prompt, opts}]
function scriptAgent(agentType, handler) {
  if (!script.has(agentType)) script.set(agentType, []);
  script.get(agentType).push(handler);
}
function resultJson(obj) { return `<result>\n${JSON.stringify(obj)}\n</result>`; }
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

let dbModule, runner, userId, projectId;
const REPO_PATH = '/repos/p1/main';

async function run() {
  const r = await runner.runPipeline(userId);
  await runner.whenIdle();
  return r;
}

async function insertTask(status, fields = {}) {
  const cols = { user_id: userId, task_id: `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, source: 'odoo', title: '測試任務', original_text: '在報價單加備註欄位', status, project_id: projectId, ...fields };
  const names = Object.keys(cols);
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (${names.join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id, task_id`,
    names.map(n => cols[n])
  );
  return t;
}

async function getTask(id) {
  const { rows: [t] } = await dbModule.query('SELECT * FROM tasks WHERE id=$1', [id]);
  return t;
}

const SD_YAML = 'case_id: "X"\nmodule: idx_demo\nodoo_version: "17.0"\nexecution_mode: "MODE_A"\nsummary: 報價單加備註\nrequirements:\n  - 加備註欄位\nacceptance:\n  - 報價單看得到備註欄位\n';

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  const pool = new Pool();
  // pg-mem 缺陷 shim：pg-mem 把 LIKE 的 '[' 誤當 regex 字元類（真 PostgreSQL 中是字面值），
  // 導致 '[QA 未通過]%' 等前綴查詢永遠 0 列。改寫成 substring 前綴比較以還原真 PG 語意。
  const rawQuery = pool.query.bind(pool);
  pool.query = (sql, ...rest) => {
    if (typeof sql === 'string') {
      sql = sql.replace(/(\w+)\s+LIKE\s+'(\[[^%']*)%'/g, (_, col, prefix) => `substring(${col}, 1, ${prefix.length}) = '${prefix}'`);
    }
    return rawQuery(sql, ...rest);
  };
  dbModule._setPoolForTesting(pool);
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('wf', $1, 'WF', 'user') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('WFP','17.0','wfp') RETURNING id"
  );
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [projectId, REPO_PATH]
  );
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, url, port) VALUES ($1,'running','http://localhost:8069',8069)", [projectId]
  );
  runner = require('../pipeline/runner');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  script = new Map();
  calls = [];
  runClaude.mockReset().mockImplementation(async (prompt, opts = {}) => {
    const rec = { agentType: opts.agentType, model: opts.model, prompt, opts };
    calls.push(rec);
    const q = script.get(opts.agentType);
    if (!q || !q.length) throw new Error(`未編排的 agent 呼叫：${opts.agentType}`);
    const out = await q.shift()(prompt, opts);
    return { text: '', usage: { ...USAGE }, durationMs: 5, sessionId: null, model: opts.model || 'sonnet', ...out };
  });
  const git = require('../pipeline/git');
  git.mergeInto.mockReset().mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  const env = require('../pipeline/env-agent');
  env.upgradeModules.mockReset().mockResolvedValue({ ok: true, log: '' });
  env.runTourTests.mockReset().mockResolvedValue({ ok: true, log: 'tests passed' });
  require('../pipeline/ensure-env').ensureEnvRunning.mockReset().mockResolvedValue(true);
  await dbModule.query('DELETE FROM token_usage');
  await dbModule.query('DELETE FROM task_events');
  await dbModule.query('DELETE FROM task_logs');
  await dbModule.query('DELETE FROM task_rejections');
  await dbModule.query('DELETE FROM tasks');
});

// ---------- S1 全綠 happy path：new → … → review_pending → approve → done ----------
test('S1 全流程順跑：分類→分析→分支→實作→QA→併版→部署→E2E→人工審核→wiki→done', async () => {
  scriptAgent('cs', () => ({ text: resultJson({ type: 'code_change_clear' }) }));
  scriptAgent('analysis', () => ({ text: resultJson({ status: 'branch_pending', analysis_yaml: SD_YAML }) }));
  scriptAgent('coding', () => ({ text: resultJson({ status: 'qa_running' }), sessionId: 'sess-1' }));
  scriptAgent('qa', () => ({ text: resultJson({ verdict: 'pass' }) }));
  scriptAgent('playwright', () => ({ text: '已新增 tour 測試' }));

  const t = await insertTask('new');
  await run();

  let task = await getTask(t.id);
  expect(task.status).toBe('review_pending');
  expect(task.git_branch).toBe(`task/${t.task_id}`);
  expect(task.blocker_content).toBeNull();

  // prompt 組裝正確性：placeholder 全數替換、規則注入、密碼不落 prompt
  for (const c of calls) expect(c.prompt).not.toContain('{{');
  const coding = calls.find(c => c.agentType === 'coding');
  expect(coding.prompt).toContain('Hard Rules');          // CLAUDE.md 注入開發類 agent
  expect(coding.prompt).toContain('module: idx_demo');    // SD 帶入
  const cs = calls.find(c => c.agentType === 'cs');
  expect(cs.prompt).not.toContain('Hard Rules');          // 分類 agent 不注入開發規則
  const pw = calls.find(c => c.agentType === 'playwright');
  expect(pw.prompt).toContain('auto_test_user');
  expect(pw.prompt).not.toContain('E2E 密碼明文');
  expect(pw.opts.env.E2E_PASSWORD).toBeTruthy();          // 密碼走環境變數，不進 prompt
  expect(pw.prompt).not.toContain(pw.opts.env.E2E_PASSWORD + '」');

  // 模擬人工審核通過（pipeline-routes approve 的狀態轉移）→ wiki → done
  scriptAgent('wiki', () => ({ text: resultJson({ slug: 'sale-note', title: '報價單備註', content: '# 說明' }) }));
  await dbModule.query("UPDATE tasks SET status='wiki_updating', approved_at=NOW(), updated_at=NOW() WHERE id=$1", [t.id]);
  await run();
  task = await getTask(t.id);
  expect(task.status).toBe('done');
  const { rows: wiki } = await dbModule.query('SELECT slug FROM wiki_pages WHERE project_id=$1', [projectId]);
  expect(wiki.map(w => w.slug)).toEqual(expect.arrayContaining(['overview', 'module-idx_demo', 'sale-note']));

  // 每個用到 claude 的關卡都有 token 記帳
  const { rows: usage } = await dbModule.query('SELECT DISTINCT agent_type FROM token_usage');
  expect(usage.map(r => r.agent_type).sort()).toEqual(expect.arrayContaining(['analysis', 'coding', 'cs', 'playwright', 'qa', 'wiki']));
});

// ---------- S2 QA 退回 → resume 重跑（省 token 路徑）→ 通過 ----------
test('S2 QA fail → coding resume（--resume＋opus＋蒸餾 feedback，短 prompt）→ QA pass → review_pending', async () => {
  const issues = ['備註欄位未加進 form view', '欄位未設 tracking'];
  scriptAgent('coding', () => ({ text: resultJson({ status: 'qa_running' }), sessionId: 'sess-A' }));
  scriptAgent('qa', () => ({ text: resultJson({ verdict: 'fail', issues, summary: '請補 view 與 tracking' }) }));
  scriptAgent('coding', async (prompt, opts) => {
    // resume 路徑核心斷言：沿用 session、升級 opus、帶入蒸餾後的 QA 回饋
    expect(opts.resumeSessionId).toBe('sess-A');
    expect(opts.model).toBe('opus');
    expect(prompt).toContain('QA 未通過');
    expect(prompt).toContain('備註欄位未加進 form view');
    return { text: resultJson({ status: 'qa_running' }), sessionId: 'sess-A' };
  });
  scriptAgent('qa', (prompt) => {
    // 第二輪 QA 必須收到上一輪未解清單（迴圈收斂機制）
    expect(prompt).toContain('備註欄位未加進 form view');
    return { text: resultJson({ verdict: 'pass' }) };
  });
  scriptAgent('playwright', () => ({ text: 'tour ok' }));

  const t = await insertTask('coding_running', { analysis_yaml: SD_YAML, git_branch: 'task/x' });
  await run();

  const task = await getTask(t.id);
  expect(task.status).toBe('review_pending');
  expect(task.qa_retry_count).toBe(1);
  expect(task.reentry_count).toBe(1);
  expect(task.coding_resume_count).toBe(1);
  expect(task.retry_feedback).toBeNull(); // 成功消費後清空

  // token 效率：resume prompt 小於全量 fresh prompt。
  // 已知待優化（本模擬量化出的發現）：coding-retry 在 CLAUDE_MD_AGENTS 名單內，每次 resume
  // 重複前置整份 CLAUDE.md（約佔 resume prompt 82%），而 --resume 的 session 上下文已含這份
  // 規則（fresh prompt 帶過）。若把 coding-retry 移出名單，resume prompt 可再縮 ~80%。
  const codingCalls = calls.filter(c => c.agentType === 'coding');
  expect(codingCalls[1].prompt.length).toBeLessThan(codingCalls[0].prompt.length);
});

// ---------- S3 部署失敗歸因 ----------
test('S3a 部署失敗（Traceback＝code）→ 退 coding 帶蒸餾 feedback＋計數', async () => {
  const tb = [
    'odoo failed', 'Traceback (most recent call last):',
    '  File "/opt/odoo/odoo/modules/registry.py", line 10, in load', '    framework()',
    '  File "/repos/p1/main/idx_demo/models/sale_order.py", line 5, in <module>',
    '    note = fields.Char(', 'SyntaxError: invalid syntax'
  ].join('\n');
  require('../pipeline/env-agent').upgradeModules.mockRejectedValueOnce(Object.assign(new Error(tb), { exitCode: 1 }));
  scriptAgent('coding', async (prompt, opts) => {
    const cur = await getTask(tId);
    expect(cur.deploy_retry_count).toBe(1);
    expect(opts.model).toBe('opus');
    expect(prompt).toContain('idx_demo/models/sale_order.py'); // 蒸餾保留使用者模組 frame
    expect(prompt).toContain('SyntaxError');
    expect(prompt).not.toContain('registry.py');               // framework frame 被砍
    expect(prompt).toContain('完整 log：');                     // 逃生口：完整 log 路徑
    return { text: resultJson({ status: 'stopped', error: '模擬終止' }) };
  });
  const t = await insertTask('deploy_testing', { analysis_yaml: SD_YAML, git_branch: 'task/x', coding_session_id: 'sess-B' });
  const tId = t.id;
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('stopped');
  expect(task.deploy_retry_count).toBe(1);
});

test('S3b 部署失敗（connection refused＝env）→ stopped(env)，不退 coding、不佔計數', async () => {
  require('../pipeline/env-agent').upgradeModules.mockRejectedValue(new Error('could not connect to server: connection refused'));
  const t = await insertTask('deploy_testing', { analysis_yaml: SD_YAML, git_branch: 'task/x' });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('stopped');
  expect(task.blocker_type).toBe('env');
  expect(task.deploy_retry_count).toBe(0);
  expect(runClaude).not.toHaveBeenCalled(); // regex 先判，零 token
});

test('S3c 部署暫時性失敗（ECONNRESET）→ 自動重試一次即過 → E2E → review_pending', async () => {
  const env = require('../pipeline/env-agent');
  env.upgradeModules
    .mockRejectedValueOnce(new Error('read ECONNRESET'))
    .mockResolvedValueOnce({ ok: true, log: '' });
  scriptAgent('playwright', () => ({ text: 'tour ok' }));
  const t = await insertTask('deploy_testing', { analysis_yaml: SD_YAML, git_branch: 'task/x' });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('review_pending');
  expect(env.upgradeModules).toHaveBeenCalledTimes(2);
  expect(task.deploy_retry_count).toBe(0); // transient 不佔計數
});

// ---------- S4 澄清循環 ----------
test('S4 分析要求澄清 → confirm_pending 停下；使用者作答 → 重分析帶入答案', async () => {
  scriptAgent('analysis', () => ({
    text: resultJson({ status: 'confirm_pending', analysis_yaml: 'clarification_channel:\n  questions:\n    - 備註要放哪個頁籤？\n' })
  }));
  const t = await insertTask('analysis_running');
  await run();
  expect((await getTask(t.id)).status).toBe('confirm_pending'); // 非 runnable，正確停下等人

  // 模擬 /api/tasks/:id/answer：落地答案 → confirm_answered → 自動回分析
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','放在「其他資訊」頁籤')", [t.id]);
  await dbModule.query("UPDATE tasks SET status='confirm_answered', updated_at=NOW() WHERE id=$1", [t.id]);
  scriptAgent('analysis', (prompt) => {
    expect(prompt).toContain('放在「其他資訊」頁籤'); // 澄清答案確實餵回
    return { text: resultJson({ status: 'branch_pending', analysis_yaml: SD_YAML }) };
  });
  scriptAgent('coding', () => ({ text: resultJson({ status: 'stopped', error: '模擬終止' }) }));
  await run();
  expect((await getTask(t.id)).status).toBe('stopped'); // 走到 coding（模擬終止），代表澄清循環已接回主線
});

// ---------- S5 輸出格式韌性 ----------
test('S5a 結果帶 ```json fence 與前導雜訊 → 直接解析成功，不動用補救', async () => {
  scriptAgent('coding', () => ({
    text: '我完成了實作。\n<result>\n```json\n{"status":"qa_running"}\n```\n</result>\n', sessionId: 's5'
  }));
  scriptAgent('qa', () => ({ text: resultJson({ verdict: 'pass' }) }));
  scriptAgent('playwright', () => ({ text: 'ok' }));
  const t = await insertTask('coding_running', { analysis_yaml: SD_YAML, git_branch: 'task/x' });
  await run();
  expect((await getTask(t.id)).status).toBe('review_pending');
  expect(calls.filter(c => c.agentType === 'repair')).toHaveLength(0);
});

test('S5b 輸出漏了 <result> → haiku 補救一次修格式 → 流程照走；併版衝突自動解失敗 → merge_conflict', async () => {
  scriptAgent('qa', () => ({ text: 'PASS，沒有問題' })); // 壞格式
  scriptAgent('repair', (prompt, opts) => {
    expect(opts.model).toBe('haiku'); // 補救用便宜模型
    return { text: resultJson({ verdict: 'pass' }) };
  });
  // 併版：留下一個無法自動解的衝突檔（檔案不存在 → resolveConflict 回 false）
  require('../pipeline/git').mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: ['idx_demo/models/sale_order.py'] });
  const t = await insertTask('qa_running', { analysis_yaml: SD_YAML, git_branch: 'task/x' });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('merge_conflict');
  expect(JSON.parse(task.merge_conflict_data).repos[0].files).toContain('idx_demo/models/sale_order.py');
});

// ---------- S6 手動暫停 ----------
test('S6 執行中 abort（手動暫停）→ 狀態原地不動、無 blocker、失敗記帳 aborted', async () => {
  scriptAgent('coding', () => { throw Object.assign(new Error('手動暫停'), { aborted: true, claudeStatus: 'aborted', durationMs: 12 }); });
  const t = await insertTask('coding_running', { analysis_yaml: SD_YAML, git_branch: 'task/x' });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('coding_running'); // 解除暫停後可從同關續跑
  expect(task.blocker_content).toBeNull();
  const { rows } = await dbModule.query("SELECT status FROM token_usage WHERE agent_type='coding'");
  expect(rows).toEqual([{ status: 'aborted' }]);
});

// ---------- S7 分診（人工退回／卡關修正）----------
test('S7a 人工退回 → 分診判 fix → 回 coding 保留退回原因（resume＋opus）', async () => {
  scriptAgent('reject_triage', () => ({ text: resultJson({ decision: 'fix', summary: '按鈕移到 header' }) }));
  scriptAgent('coding', async (prompt, opts) => {
    expect(opts.model).toBe('opus');
    expect(prompt).toContain('按鈕位置錯誤'); // 退回原因確實帶入重跑
    return { text: resultJson({ status: 'stopped', error: '模擬終止' }) };
  });
  const t = await insertTask('reject_triage', {
    analysis_yaml: SD_YAML, git_branch: 'task/x',
    retry_feedback: '[人工退回] 按鈕位置錯誤', coding_session_id: 'sess-C'
  });
  await dbModule.query("INSERT INTO task_rejections (task_id, project_id, reason) VALUES ($1,$2,'按鈕位置錯誤')", [t.task_id, projectId]);
  await run();
  expect((await getTask(t.id)).status).toBe('stopped'); // 模擬終止＝已進 coding resume
});

test('S7b 卡關分診判 advance（使用者稱已處理）→ 直接放行到 review_pending 並清阻塞', async () => {
  scriptAgent('reject_triage', () => ({ text: resultJson({ decision: 'advance', target: 'review', summary: '實測已通過' }) }));
  const t = await insertTask('resolve_triage', {
    analysis_yaml: SD_YAML, git_branch: 'task/x',
    resume_status: 'playwright_running', blocker_content: 'E2E 失敗', retry_feedback: '[E2E tour 未通過]\nx', pw_retry_count: 2
  });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('review_pending');
  expect(task.blocker_content).toBeNull();
  expect(task.retry_feedback).toBeNull();
});

test('S7c 分診判 respec → 結論當澄清回分析、清 coding session（新世代）', async () => {
  scriptAgent('reject_triage', () => ({ text: resultJson({ decision: 'respec', summary: '規格漏了多幣別情境' }) }));
  scriptAgent('analysis', (prompt) => {
    expect(prompt).toContain('多幣別'); // 分診結論以澄清身分餵回分析
    return { text: resultJson({ status: 'confirm_pending', analysis_yaml: SD_YAML }) };
  });
  const t = await insertTask('resolve_triage', {
    analysis_yaml: SD_YAML, git_branch: 'task/x',
    resume_status: 'coding_running', blocker_content: 'QA 連續未過', coding_session_id: 'sess-D'
  });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('confirm_pending');
  expect(task.coding_session_id).toBeNull();
});

// ---------- S8 迴圈上限兜底 ----------
test('S8a QA 連續 5 次未過 → stopped 需人工', async () => {
  scriptAgent('qa', () => ({ text: resultJson({ verdict: 'fail', issues: ['還是不對'] }) }));
  const t = await insertTask('qa_running', { analysis_yaml: SD_YAML, git_branch: 'task/x', qa_retry_count: 4 });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('stopped');
  expect(task.blocker_content).toContain('QA 連續 5 次未通過');
});

test('S8b 總循環（reentry）達 10 → 各關計數未滿也強制 stopped，杜絕無限循環', async () => {
  scriptAgent('qa', () => ({ text: resultJson({ verdict: 'fail', issues: ['x'] }) }));
  const t = await insertTask('qa_running', { analysis_yaml: SD_YAML, git_branch: 'task/x', qa_retry_count: 0, reentry_count: 9 });
  await run();
  const task = await getTask(t.id);
  expect(task.status).toBe('stopped');
  expect(task.blocker_content).toContain('循環 10 次');
});
