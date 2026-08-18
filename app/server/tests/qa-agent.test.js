// 意圖：QA 對照 SD 判定 diff。pass 往下 merge、fail 退 coding 並依關卡計數，
// 連續失敗達上限改為 stopped（人工介入），無有效結果視為失敗停止。
const { newDb } = require('pg-mem');

// 核心 source 供給走 docker 解壓——單測不碰真 docker，回固定守則字串（真行為由 odoo-core-src.test.js 驗）
jest.mock('../lib/odoo-core-src', () => ({ coreSourceGuidance: () => '（測試：核心來源守則）', ensureOdooCoreSrc: () => '', majorOf: (v) => String(v || '').split('.')[0] }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, getProjectInfo: jest.fn() };
});
// 死結熔斷（P6）用 revParse 取任務分支 HEAD；AI_BRANCH 是 attempt() 取 diff 基底用的常數
// （getMainBranch 留著只為證明它已不再被 QA 呼叫）。
jest.mock('../pipeline/git', () => ({ getMainBranch: jest.fn().mockResolvedValue('main'), revParse: jest.fn(), AI_BRANCH: 'ai-dev' }));

let dbModule, runQaAgent, taskAgent, runClaude;
let userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  const pool = new Pool();
  // pg-mem 缺陷 shim（同 workflow-scenarios）：pg-mem 把 LIKE 的 '[' 誤當 regex 字元類，
  // '[QA 未通過]%' 前綴查詢永遠 0 列；改寫成 substring 前綴比較以還原真 PG 語意。
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
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('qa', $1, 'Q') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('QP', '17.0') RETURNING id"
  );
  projectId = p.id;

  taskAgent = require('../pipeline/task-agent');
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ runQaAgent } = require('../pipeline/qa-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  runClaude.mockReset();
  taskAgent.getProjectInfo.mockReset();
  taskAgent.getProjectInfo.mockResolvedValue({
    name: 'QP', odoo_version: '17.0', root: '/repos/qp',
    repos: [{ subdir: 'main', local_path: '/repos/qp/main' }]
  });
  const git = require('../pipeline/git');
  git.getMainBranch.mockReset().mockResolvedValue('main');
  git.revParse.mockReset(); // 預設回 undefined → headSha null → 不觸發死結（既有測試不受影響）
});

let seq = 0;
async function makeTask(qaCount = 0) {
  seq++;
  const { promptVersion } = require('../pipeline/agent-loader');
  // 預設帶「當前 qa 版本」，讓有 qa_session 的 resume 測試通過版本閘門；指定 STALE 的由測試自行 UPDATE 覆蓋。
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, analysis_yaml, qa_retry_count, qa_prompt_ver)
     VALUES ($1,$2,'odoo','T','qa_running',$3,'task/x','module: sale',$4,$5) RETURNING id`,
    [userId, `qa_${seq}`, projectId, qaCount, promptVersion('qa')]
  );
  return t.id;
}

function claudeReturns(json) {
  runClaude.mockResolvedValue({
    text: `前置輸出\n<result>\n${JSON.stringify(json)}\n</result>`, usage: null, durationMs: null
  });
}

// P6 死結熔斷：自上輪 QA 後任務分支 HEAD 未變（coding 未提交修正）＋已退過一次 → 提早停下轉人工裁決，
// 不再燒 QA、不再退 coding（避免像 104 那樣 QA 幻覺誤判時一路空轉到 QA_LIMIT）。
test('P6 死結：HEAD 未變＋已有前輪 fail → stopped(code) 轉裁決，不跑 QA、不退 coding', async () => {
  const git = require('../pipeline/git');
  git.revParse.mockResolvedValue('sha-frozen');
  const id = await makeTask(1); // qa_retry_count=1（已退過一次）
  await dbModule.query("UPDATE tasks SET qa_reviewed_commit='sha-frozen' WHERE id=$1", [id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\nxmlid 不存在')", [id]);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, blocker_content, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('code');
  expect(t.blocker_content).toContain('僵局');
  expect(t.blocker_content).toContain('xmlid 不存在'); // 帶上 QA 未解清單供人工裁決
  expect(t.qa_retry_count).toBe(1);                     // 不再累加、不再退 coding
  expect(runClaude).not.toHaveBeenCalled();             // 提早熔斷，不燒 QA
});

// 反向：HEAD 有變（coding 真的提交了修正）→ 照常審查，並記下本輪審過的新 commit。
// 用 fail 情境驗「記下 commit」才有鑑別力——供下輪比對的前提是還有下輪 QA，而 pass 之後沒有。
test('P6 非死結：HEAD 有變 → 照常審查、記錄新 reviewed_commit', async () => {
  const git = require('../pipeline/git');
  git.revParse.mockResolvedValue('sha-new');
  claudeReturns({ verdict: 'fail', issues: ['x'], summary: 's' });
  const id = await makeTask(1);
  await dbModule.query("UPDATE tasks SET qa_reviewed_commit='sha-old' WHERE id=$1", [id]);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_reviewed_commit FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_reviewed_commit).toBe('sha-new'); // 記下本輪審過的 commit，供下輪比對
  expect(runClaude).toHaveBeenCalled();
});

// pass＝離開 QA↔coding 迴圈 → 清掉 reviewed_commit，否則往後從別關回流時會被誤判成死結。
test('P6 pass → 清掉 qa_reviewed_commit', async () => {
  const git = require('../pipeline/git');
  git.revParse.mockResolvedValue('sha-new');
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(1);
  await dbModule.query("UPDATE tasks SET qa_reviewed_commit='sha-old' WHERE id=$1", [id]);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_reviewed_commit FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
  expect(t.qa_reviewed_commit).toBeNull();
});

// 現場（task 109）的誤判路徑：QA pass → merge → deploy 失敗 → 退回 coding → coding 判定「程式沒錯、
// 錯在 deploy 的 view 衝突」不提交任何 commit → 回 QA 時 HEAD 仍等於上次 pass 的 sha。這不是 QA 僵局
// （上輪 QA 是 pass），不得熔斷——否則貼出的是好幾輪前早已修掉的舊 QA 清單，與真因完全對不上。
test('P6 非死結：pass 後從別關回流、HEAD 未變 → 不熔斷、照常審查', async () => {
  const git = require('../pipeline/git');
  git.revParse.mockResolvedValue('sha-passed');
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(1); // qa_retry_count=1：歷史上曾退過一次，但那輪之後已 pass
  // 上一輪 QA 判 pass 時清掉了 reviewed_commit；deploy 失敗把任務踢回 coding，coding 未提交修正
  await dbModule.query("UPDATE tasks SET qa_reviewed_commit=NULL WHERE id=$1", [id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n早就修掉的舊問題')", [id]);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(runClaude).toHaveBeenCalled();          // 真的跑了 QA，不是 11ms 就熔斷
  expect(t.status).toBe('merge_running');
  expect(t.blocker_content || '').not.toContain('僵局'); // 不得貼出陳年 QA 清單
});

// 首輪（qa_retry_count=0）不得誤判死結（即使 reviewed_commit 恰等於 HEAD）。
test('P6 首輪 qa_retry_count=0 → 不熔斷、照常審查', async () => {
  const git = require('../pipeline/git');
  git.revParse.mockResolvedValue('sha-x');
  claudeReturns({ verdict: 'fail', issues: ['x'], summary: 's' });
  const id = await makeTask(0);
  await dbModule.query("UPDATE tasks SET qa_reviewed_commit='sha-x' WHERE id=$1", [id]);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(runClaude).toHaveBeenCalled();
});

// 觸頂那一擊最容易把資訊弄丟：bumpReentryOrStop 一標 stopped 就提早 return。
// 現場（task 157）就是這樣——使用者只看到「循環 4 次仍未通過」，看不到 QA 說了什麼；
// retry_feedback 停在 NULL，事後人工推回 coding 時開發空手重跑、被同一個問題再退一輪。
test('reentry 觸頂 → QA 本輪的問題要同時留在 blocker_content 與 retry_feedback', async () => {
  claudeReturns({ verdict: 'fail', issues: ['恢復按鈕在維修單已確認時實際無效'], summary: '改這裡' });
  const id = await makeTask(0);
  // 已用掉全部總循環額度（MAX_REENTRY 預設 2）→ 本輪必定觸頂
  await dbModule.query('UPDATE tasks SET reentry_count=$2 WHERE id=$1', [id, 2]);
  await runQaAgent(id, userId);

  const { rows: [t] } = await dbModule.query(
    'SELECT status, blocker_content, retry_feedback, qa_retry_count FROM tasks WHERE id=$1', [id]
  );
  expect(t.status).toBe('stopped');
  // 使用者在畫面上看得到真正的問題，不只是「循環 N 次」
  expect(t.blocker_content).toContain('循環');
  expect(t.blocker_content).toContain('恢復按鈕在維修單已確認時實際無效');
  // 人工事後推回 coding 時，開發拿得到退回原因（含修正指引）
  expect(t.retry_feedback).toContain('恢復按鈕在維修單已確認時實際無效');
  expect(t.retry_feedback).toContain('修正指引：改這裡');
  expect(t.qa_retry_count).toBe(1);
});

test('verdict pass → merge_running', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
});

test('verdict fail 未達上限 → coding_running、計數+1、issues 進 log', async () => {
  claudeReturns({ verdict: 'fail', issues: ['第1條未實作'], summary: '修這個' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, reentry_count, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
  expect(t.reentry_count).toBe(1); // C-5：退回 coding 累加總循環次數
  // summary（給實作 Agent 的修正指引）要進 retry_feedback，不能因 issues 存在被丟棄
  expect(t.retry_feedback).toContain('修正指引：修這個');
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('第1條未實作'))).toBe(true);
  // [QA 未通過] log 是下一輪 QA 的未解清單，修正指引不得混入被當成待驗項
  expect(logs.some(l => l.content.includes('修正指引'))).toBe(false);
});

test('verdict fail 第 5 次 → stopped', async () => {
  claudeReturns({ verdict: 'fail', issues: ['又錯'] });
  const id = await makeTask(4); // 已 4 次，本次是第 5 次（QA_LIMIT=5）
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.qa_retry_count).toBe(5);
});

// 收斂關鍵：QA 每輪必須看到上一輪的未解清單，才能逐項重驗、不重新發散。
// 這條意圖若默默失效，迴圈會退回「每輪各抓不同子集」的打轉，故明確鎖住。
test('上一輪 [QA 未通過] 會帶入本輪 QA 的 prompt', async () => {
  claudeReturns({ verdict: 'fail', issues: ['沿用問題'] });
  const id = await makeTask(0);
  // 正式格式為「[QA 未通過]\n<清單>」，但 pg-mem 的 LIKE '%' 不跨換行（正式 Postgres 會），
  // 故 seed 用標頭+空白；查詢前綴比對與 strip 的 \s* 對空白/換行行為一致，僅 pg-mem 換行處理不同。
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [id, '[QA 未通過] 按鈕位置未緊鄰新增按鈕']
  );
  await runQaAgent(id, userId);
  const sentPrompt = runClaude.mock.calls[0][0];
  expect(sentPrompt).toContain('按鈕位置未緊鄰新增按鈕');
  expect(sentPrompt).not.toContain('[QA 未通過]'); // 標頭已剝除，只留清單本體
});

// 意圖（C-1）：QA 的 diff 基底必須是任務切點 ai-dev，不是實體 main。任務分支從 ai-dev 切、
// ai-dev 又含 main 全部歷史 → 以 main 當基底時 `git diff main...task/X` 的 merge-base 落在 main 的 tip，
// 會把其他已核准但尚未回流 main 的任務變更一併算成本任務的成果；QA 拿別人的碼對照本任務規格審查，
// 會誤判「做了規格沒要求的東西」而退回，或反過來把別人的碼當本任務成果放行。
test('C-1 QA prompt 的 diff 基底是 ai-dev（任務切點），不是實體 main', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const sentPrompt = runClaude.mock.calls[0][0];
  expect(sentPrompt).toContain('diff ai-dev...task/x');
  expect(sentPrompt).not.toContain('diff main...task/x');
  const git = require('../pipeline/git');
  expect(git.getMainBranch).not.toHaveBeenCalled(); // 基底不再取決於 repo 實際主分支名
});

test('首輪無上一輪清單 → prompt 帶入佔位字串', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const sentPrompt = runClaude.mock.calls[0][0];
  expect(sentPrompt).toContain('（首輪，無上輪清單）');
});

test('無 RESULT-JSON → stopped', async () => {
  runClaude.mockResolvedValue({ text: '亂七八糟沒有標記', usage: null, durationMs: null });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});

// 意圖（比照 coding 健檢 U3）：QA 重驗走 --resume 續用上輪 session（已含規格＋規則＋diff 探索），
// 只送短增量 prompt；fresh 才送全量規格。省 token 且讓重驗聚焦在未解清單。
test('QA resume：有 qa_session_id＋上輪未解清單 → --resume 短 prompt、count+1', async () => {
  // 用 fail 而非 pass：resume 記帳與 verdict 無關，但 pass 分支會刻意把整組計數器歸零
  //（任務就此離開 QA↔coding 迴圈），拿 pass 驗 count+1 等於驗到被清空後的值。
  claudeReturns({ verdict: 'fail', issues: ['x'], summary: 's' });
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-1', qa_resume_count=0 WHERE id=$1", [id]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n備註欄位未加進 form view')", [id]
  );
  await runQaAgent(id, userId);

  const opts = runClaude.mock.calls[0][1];
  expect(opts.resumeSessionId).toBe('qs-1');                       // 續用上輪 session
  expect(runClaude.mock.calls[0][0]).toContain('備註欄位未加進 form view'); // 未解清單有帶
  expect(runClaude.mock.calls[0][0]).not.toContain('module: sale');  // 不重送全量規格
  // {{odoo_core_src}} 漏傳只會 console.warn，資料來源段會整段變空白（連禁止掃碟的警告都沒了）
  expect(runClaude.mock.calls[0][0]).toContain('（測試：核心來源守則）');
  const { rows: [t] } = await dbModule.query('SELECT qa_resume_count FROM tasks WHERE id=$1', [id]);
  expect(t.qa_resume_count).toBe(1);
});

test('QA fresh：首輪（無 session）→ 全量 prompt、存 qa_session_id', async () => {
  runClaude.mockResolvedValue({
    text: '<result>{"verdict":"fail","issues":["x"],"summary":"s"}</result>', usage: null, durationMs: null, sessionId: 'qs-new'
  });
  const id = await makeTask();
  await runQaAgent(id, userId);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined();
  expect(runClaude.mock.calls[0][0]).toContain('module: sale');      // fresh 帶全量規格
  expect(runClaude.mock.calls[0][0]).toContain('（測試：核心來源守則）'); // {{odoo_core_src}} 有傳，不是空白段
  const { rows: [t] } = await dbModule.query('SELECT qa_session_id FROM tasks WHERE id=$1', [id]);
  expect(t.qa_session_id).toBe('qs-new');
});

test('QA resume 額度用完（count=2）→ 強制 fresh 全量', async () => {
  runClaude.mockResolvedValue({
    text: '<result>{"verdict":"fail","issues":["x"],"summary":"s"}</result>', usage: null, durationMs: null, sessionId: 'qs-gen2'
  });
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-old', qa_resume_count=2 WHERE id=$1", [id]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n還是不對')", [id]
  );
  await runQaAgent(id, userId);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined(); // 不 resume
  const { rows: [t] } = await dbModule.query('SELECT qa_session_id, qa_resume_count FROM tasks WHERE id=$1', [id]);
  expect(t.qa_session_id).toBe('qs-gen2'); // 換新世代
  expect(t.qa_resume_count).toBe(0);
});

// 意圖：改過 qa prompt 後，帶舊 qa_session 的任務不可 resume（吃不到新審查規則）→ 走 fresh 全量。
test('QA prompt 版本不符 → 不 resume、走 fresh 全量、存新版本', async () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  runClaude.mockResolvedValue({ text: '<result>{"verdict":"pass"}</result>', usage: null, durationMs: null, sessionId: 'qs-newver' });
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-old', qa_resume_count=0, qa_prompt_ver='STALE' WHERE id=$1", [id]);
  await dbModule.query("INSERT INTO task_logs (task_id,role,content) VALUES ($1,'ai','[QA 未通過]\n舊問題')", [id]);
  await runQaAgent(id, userId);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined();  // 版本不符 → fresh
  expect(runClaude.mock.calls[0][0]).toContain('module: sale');         // 全量規格
  const { rows: [t] } = await dbModule.query('SELECT qa_prompt_ver FROM tasks WHERE id=$1', [id]);
  expect(t.qa_prompt_ver).toBe(promptVersion('qa'));                    // fresh 存現版本
});

test('QA prompt 版本相符 → 照常 resume', async () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  runClaude.mockResolvedValue({ text: '<result>{"verdict":"pass"}</result>', usage: null, durationMs: null });
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-keep', qa_resume_count=0, qa_prompt_ver=$2 WHERE id=$1", [id, promptVersion('qa')]);
  await dbModule.query("INSERT INTO task_logs (task_id,role,content) VALUES ($1,'ai','[QA 未通過]\n備註欄位')", [id]);
  await runQaAgent(id, userId);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBe('qs-keep');   // 版本相符 → resume
});

// 意圖：fresh 與 resume 的成本差 12 倍（實測 $3 vs $0.27），但「哪一輪是哪種」事後查不到——
// 記帳時就標，否則放寬 resume 之後準確率是升是降都無從判讀。落地由 token-logger.test.js 顧。
test('記帳帶 resumed 旗標：fresh 記 false、resume 記 true', async () => {
  const { logTokenUsage } = require('../pipeline/token-logger');
  claudeReturns({ verdict: 'fail', issues: ['x'], summary: 's' });

  logTokenUsage.mockClear();
  await runQaAgent(await makeTask(), userId);
  expect(logTokenUsage.mock.calls[0][6]).toBe(false);

  logTokenUsage.mockClear();
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-a' WHERE id=$1", [id]);
  await dbModule.query("INSERT INTO task_logs (task_id,role,content) VALUES ($1,'ai','[QA 未通過]\n舊項')", [id]);
  await runQaAgent(id, userId);
  expect(logTokenUsage.mock.calls[0][6]).toBe(true);
});

// 意圖：pass 之後任務可能因 deploy／E2E／merge 失敗回流再進 QA。那條路上要驗的是「載入錯誤的修正」，
// 不是推翻自己上一輪的結論，而舊 session 裡的規格與 repo 探索仍然有效——清掉等於每次回流都重跑一輪
// 全量探索。注意 pass 會寫下未解清單的分界，故此時 prev 必為空：光靠 `!!prev` 當條件就會擋掉 resume，
// 兩道門要一起拆才有效果。
test('pass 後回流（有 session、無未解清單）→ 仍走 resume，不重跑全量', async () => {
  claudeReturns({ verdict: 'fail', issues: ['x'], summary: 's' });
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-passed', qa_resume_count=0 WHERE id=$1", [id]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id,role,content) VALUES ($1,'ai','[QA 通過] 本輪審查通過，先前的未解清單就此作廢')", [id]
  );
  await runQaAgent(id, userId);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBe('qs-passed');
  expect(runClaude.mock.calls[0][0]).not.toContain('module: sale'); // 沒重送全量規格＝真的走了短 prompt
});

// 意圖：這是放寬 resume 唯一真正的準確率風險——同一段對話裡它剛說過 pass，要它推翻自己比讓白紙判斷難。
// 用 prompt 明講來對沖，比清掉整個 session 便宜得多。兩個方向都斷言：只驗「有出現」的話，把警語寫死
// 在 body 裡（每輪都印）也會綠，那等於在 fail 重驗輪謊稱上輪判過。
test('pass 後回流的 resume prompt 明講上輪判過；一般 fail 重驗輪不得出現該警語', async () => {
  claudeReturns({ verdict: 'fail', issues: ['x'], summary: 's' });

  const afterPass = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-p' WHERE id=$1", [afterPass]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id,role,content) VALUES ($1,'ai','[QA 通過] 本輪審查通過，先前的未解清單就此作廢')", [afterPass]
  );
  await runQaAgent(afterPass, userId);
  expect(runClaude.mock.calls[0][0]).toContain('上一輪你判定通過');

  runClaude.mockReset();
  claudeReturns({ verdict: 'fail', issues: ['x'], summary: 's' });
  const inLoop = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-l' WHERE id=$1", [inLoop]);
  await dbModule.query("INSERT INTO task_logs (task_id,role,content) VALUES ($1,'ai','[QA 未通過]\n欄位沒加')", [inLoop]);
  await runQaAgent(inLoop, userId);
  expect(runClaude.mock.calls[0][0]).not.toContain('上一輪你判定通過');
  expect(runClaude.mock.calls[0][0]).toContain('欄位沒加'); // 未解清單照常帶＝重驗輪本身正常
});

// F11 意圖：QA 執行失敗不再一律 status=stopped/blocker_type=null 黑箱；比照 deploy 接 failure-classifier——
// transient 自動重試一次（不佔計數），非 transient 把分類寫進 blocker_type，判不出才留 null 交人工。
test('F11 transient 失敗 → 自動重試一次（不計數），成功後照常判定', async () => {
  const id = await makeTask();
  runClaude
    .mockRejectedValueOnce(new Error('socket hang up'))
    .mockResolvedValueOnce({ text: '<result>{"verdict":"pass"}</result>', usage: null, durationMs: null, sessionId: 'qs' });
  await runQaAgent(id, userId);
  expect(runClaude).toHaveBeenCalledTimes(2); // 原一次＋自動重試一次
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
  expect(t.qa_retry_count).toBe(0); // 重試不佔 QA 失敗計數
});

test('F11 transient 重試後仍失敗 → stopped、blocker_type=transient', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('ECONNRESET'));
  await runQaAgent(id, userId);
  expect(runClaude).toHaveBeenCalledTimes(2);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('transient');
});

test('F11 環境問題 → stopped、blocker_type=env（不重試）', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('could not connect to server: connection refused'));
  await runQaAgent(id, userId);
  expect(runClaude).toHaveBeenCalledTimes(1); // 非 transient 不重試
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
});

test('F11 程式錯誤 → blocker_type=code', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('SyntaxError: invalid syntax'));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.blocker_type).toBe('code');
});

test('F11 判不出的失敗 → stopped、blocker_type 留 null（交人工）', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('某種說不清的錯'));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBeNull();
});

// F12 意圖：resume 逾時若不清 stale session，人工每次解鎖都拿同一 session 重演同一 timeout、
// counter 也永不推進、永遠碰不到 QA_RESUME_LIMIT。故 timeout 要清 qa_session_id／歸零 count 讓下次降 fresh。
test('F12 resume timeout → 清 qa_session_id／歸零 qa_resume_count 後 stopped', async () => {
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-stale', qa_resume_count=1 WHERE id=$1", [id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n舊問題')", [id]);
  runClaude.mockRejectedValue(Object.assign(new Error('claude 執行逾時（600s）'), { claudeStatus: 'timeout' }));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_session_id, qa_resume_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.qa_session_id).toBeNull(); // stale session 已清，下次解鎖降 fresh 讀新脈絡
  expect(t.qa_resume_count).toBe(0);
});

// F13 意圖：verdict 用嚴格 === 比對時，大小寫／空白變體會整包落到「無效結果」stopped，
// 最痛的是 FAIL＋完整 issues 被丟棄、不退 coding、log 不寫。正規化後各變體要落到既有 handler。
test('F13 verdict 大寫 FAIL → 退 coding（不被當無效結果丟棄）', async () => {
  claudeReturns({ verdict: 'FAIL', issues: ['大寫也要退 coding'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('大寫也要退 coding'))).toBe(true);
});

test('F13 verdict 前後空白＋大寫 " PASS " → merge_running', async () => {
  claudeReturns({ verdict: ' PASS ' });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
});

// R1 意圖：QA agent 掛在 API 過載（529/500）時應比照網路抖動自動重試一次，
// 不可停等人工再燒一次分診才得出「重跑就好」的結論。
test('R1 QA 遇 529 overloaded → 自動重試一次成功 → merge_running', async () => {
  const id = await makeTask();
  runClaude
    .mockRejectedValueOnce(Object.assign(new Error('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { claudeStatus: 'error' }))
    .mockResolvedValueOnce({ text: '<result>\n{"verdict":"pass"}\n</result>', usage: null, durationMs: null });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
  expect(t.qa_retry_count).toBe(0); // infra 重試不佔 QA 計數
  expect(runClaude).toHaveBeenCalledTimes(2);
});

// R2 意圖：verdict 詞形變體（passed/failed）語意完全明確，不可被當「未回傳有效結果」丟棄整輪審查。
test('R2 verdict "passed" → merge_running', async () => {
  claudeReturns({ verdict: 'passed' });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
});

test('R2 verdict "failed"＋issues → 退 coding', async () => {
  claudeReturns({ verdict: 'failed', issues: ['詞形變體也要退 coding'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
});

// R3 意圖：fail 卻沒任何可行動細節（issues/summary 皆空）＝無效審查。退 coding 只會讓實作
// Agent 拿「未提供細節」瞎改一輪、還污染下一輪 QA 的未解清單。應重問一次，仍無細節才停等人工。
test('R3 fail 無細節 → 重問一次拿到細節 → 退 coding、log 無「未提供細節」', async () => {
  const id = await makeTask(0);
  runClaude
    .mockResolvedValueOnce({ text: '<result>\n{"verdict":"fail","issues":[]}\n</result>', usage: null, durationMs: null })
    .mockResolvedValueOnce({ text: '<result>\n{"verdict":"fail","issues":["真正的問題"]}\n</result>', usage: null, durationMs: null });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1); // 無效那輪不計數，有效 fail 才計
  expect(runClaude).toHaveBeenCalledTimes(2);
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('真正的問題'))).toBe(true);
  expect(logs.some(l => l.content.includes('未提供細節'))).toBe(false); // 污染源不得進未解清單
});

test('R3 連兩輪 fail 皆無細節 → stopped、不退 coding、不寫 [QA 未通過] log', async () => {
  const id = await makeTask(0);
  runClaude.mockResolvedValue({ text: '<result>\n{"verdict":"fail","issues":[],"summary":""}\n</result>', usage: null, durationMs: null });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.qa_retry_count).toBe(0);
  expect(t.blocker_content).toContain('連兩輪');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND content LIKE '[QA 未通過]%'", [id]);
  expect(logs.length).toBe(0);
});

// R4 意圖：timeout 是 infra 而非程式問題，停下時要標 blocker_type='env'（比照 deploy 關），
// 人工/分診一眼識別，不必讀 blocker 文字猜。
test('R4 fresh QA timeout → stopped、blocker_type=env', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(Object.assign(new Error('claude 執行逾時（600s）'), { claudeStatus: 'timeout' }));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
});

// 意圖：QA 判規格歧義（spec_questions 非空）→ 進 clarify_pending 批次問人，不退 coding、不加 qa_retry_count。
test('spec_questions 非空 → clarify_pending、批次問題、不加 qa_retry_count', async () => {
  claudeReturns({ verdict: 'fail', spec_questions: ['金額用單價還是小計?', '要不要含稅?'], issues: ['順帶：按鈕漏綁'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, resume_status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('clarify_pending');
  expect(t.qa_retry_count).toBe(0);           // 規格裁決非 code-fix 輪，不計數
  expect(t.resume_status).toBe('coding_running');
  expect(t.retry_feedback).toContain('按鈕漏綁'); // 同輪 code 問題暫存，答完一次補
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('金額用單價還是小計?') && l.content.includes('要不要含稅?'))).toBe(true);
});

// 意圖：規格歧義的 clarify 迴圈必須有界。裁決寫回 analysis_yaml（runner.handleClarifyAnswered）
// 之後，QA 若仍就規格再問，代表這條迴圈收斂不了——再問只是無限來回燒 token，該停下交人工。
test('已裁決兩輪仍再問規格 → stopped 交人工，不再進 clarify 閘門', async () => {
  const id = await makeTask(0);
  await dbModule.query('UPDATE tasks SET analysis_yaml=$2 WHERE id=$1',
    [id, 'summary: s\nspec_decisions:\n  - 使用者裁決：用小計\n  - 使用者裁決：含稅\n']);
  claudeReturns({ verdict: 'fail', spec_questions: ['還是不確定要不要含稅?'] });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('含稅');    // 未解的問題要帶給人看，不能只講「已達上限」
});

// 尚未達上限時行為不變（證明上面那條擋的是「已裁決兩輪」而非把整條 clarify 路徑關掉）
test('已裁決一輪 → 仍可再進一次 clarify 閘門', async () => {
  const id = await makeTask(0);
  await dbModule.query('UPDATE tasks SET analysis_yaml=$2 WHERE id=$1',
    [id, 'summary: s\nspec_decisions:\n  - 使用者裁決：用小計\n']);
  claudeReturns({ verdict: 'fail', spec_questions: ['要不要含稅?'] });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('clarify_pending');
});

// 回歸：fail 但無 spec_questions → 照舊退 coding（反轉舉證：漏給類別＝維持現況）。
test('fail 無 spec_questions → 照舊 coding_running、qa_retry_count+1', async () => {
  claudeReturns({ verdict: 'fail', issues: ['純 code bug'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
});

// 意圖：純規格歧義（spec_questions 非空、issues/summary 皆空）不可被 R3「無細節」誤攔，
// 必須直接進 clarify_pending 問使用者，且只呼叫一次 QA（不重問、不 stopped）。
test('純 spec_questions（無 issues/summary）→ clarify_pending，不被 R3 攔截', async () => {
  claudeReturns({ verdict: 'fail', spec_questions: ['金額用單價還是小計?'], issues: [], summary: '' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('clarify_pending');
  expect(t.qa_retry_count).toBe(0);
  expect(runClaude).toHaveBeenCalledTimes(1); // 沒有被 R3 重問
});

// 意圖：QA 不得看到「使用者修正指示」。那是流程層的話（「已修正」「直接推進到部署測試區」），
// 而放行與否是 triage 的 advance 分支在管——QA 沒有做這個決策的資訊（看不到彈跳次數、失敗歷史）。
// 舊版 qa.md 寫著「例如使用者明確要求忽略某項或已說明處理方式」，等於明文教它把流程指令當放行依據。
// 規格層級的決定不走這條路：那本來就會經 respec／analysis 進 analysis_yaml，維持單一規格來源。
// 這支測試釘住的是「訊息到不了 QA」這個結構保證，不是 prompt 的措辭。
test('fresh：使用者修正指示不得進 QA prompt（放行是 triage 的職責，不是 QA 的）', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(0);
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','[修正指示] 已修正，直接進入部屬測試區環節')", [id]
  );

  await runQaAgent(id, userId);

  const prompt = runClaude.mock.calls[0][0];
  expect(prompt).not.toContain('已修正，直接進入部屬測試區環節');
  expect(prompt).not.toContain('使用者修正指示');
  expect(prompt).toContain('module: sale');            // 規格仍在＝不是整個 prompt 都空了
});

test('resume：重驗輪同樣不得帶入使用者修正指示', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(1);
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-1' WHERE id=$1", [id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\nxmlid 不存在')", [id]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','[修正指示] 忽略該錯誤，直接繼續')", [id]
  );

  await runQaAgent(id, userId);

  const prompt = runClaude.mock.calls[0][0];
  expect(prompt).not.toContain('忽略該錯誤，直接繼續');
  expect(prompt).toContain('xmlid 不存在');            // 上輪未解清單仍在＝重驗輪本身正常
});

// 意圖：pass ＝這一輪 QA↔coding 迴圈結束。計數器只在那個迴圈內有意義，不清的話任務日後從 deploy／
// E2E 失敗回流再進 QA 時是「帶著上一輪的次數起跳」——本來還有額度卻直接觸頂 stopped。
// 未解清單也必須就此作廢，否則回流重驗會撈到好幾輪前早就修掉的舊清單當待驗項，永遠收斂不了。
// 但 session 刻意留著：它承載的規格與 repo 探索不因 pass 失效，回流時 resume 得回來（見上方回流測試）。
test('QA pass → 計數器歸零並寫下未解清單分界，但 session 留給回流重驗', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask();
  await dbModule.query(
    "UPDATE tasks SET qa_session_id='qs-1', qa_resume_count=1, qa_retry_count=3 WHERE id=$1", [id]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n舊清單')", [id]);

  await runQaAgent(id, userId);

  const { rows: [t] } = await dbModule.query(
    'SELECT status, qa_session_id, qa_resume_count, qa_retry_count, qa_reviewed_commit FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
  expect(t.qa_session_id).toBe('qs-1'); // 留著＝回流時不必重跑全量探索
  expect(t.qa_resume_count).toBe(0);
  expect(t.qa_retry_count).toBe(0);
  expect(t.qa_reviewed_commit).toBeNull();
  const { rows: marks } = await dbModule.query(
    "SELECT content FROM task_logs WHERE task_id=$1 AND content LIKE '[QA 通過]%'", [id]);
  expect(marks.length).toBe(1);
});

// 迴歸：回流重驗時不得撈到「上一次 pass 之前」的陳年清單
test('QA pass 之後再進 QA → 不得把作廢的舊清單當成待驗項', async () => {
  const id = await makeTask();
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n陳年項目：備註欄位未加')", [id]);
  claudeReturns({ verdict: 'pass' });
  await runQaAgent(id, userId);                       // 第一輪通過 → 寫下分界

  runClaude.mockClear();
  claudeReturns({ verdict: 'pass' });
  await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [id]);
  await runQaAgent(id, userId);                       // 從別關回流再進 QA

  expect(runClaude.mock.calls[0][0]).not.toContain('陳年項目：備註欄位未加');
  expect(runClaude.mock.calls[0][0]).toContain('（首輪，無上輪清單）');
});

// ── 未通過 log 的「去向」文案 ─────────────────────────────────────────────────
// 意圖：這則 log 在畫面上被收合成一句人話，但它有三種去向——退回 coding、QA 連續未通過觸頂、
// 總循環次數觸頂——後兩種其實是「任務停下等你處理」。一律寫成「已自動退回開發修正」在任務其實
// 停住時是錯的，而那正是使用者最需要正確資訊的時刻（他會以為還在自動跑，就不去處理）。
// 去向寫在標頭列，本體（未解清單）一字不動；剝除端連同去向一起剝掉，故不會污染下一輪待驗項。
const { machineLogHint } = require('../../public/js/machine-logs.js');

async function qaFailChip(id) {
  const { rows: [r] } = await dbModule.query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 AND content LIKE '[QA 未通過]%' ORDER BY id DESC LIMIT 1", [id]
  );
  return r ? machineLogHint(r.role, r.content) : null;
}

test('去向文案：退回 coding → 收合文案說的是「已自動退回開發修正」', async () => {
  claudeReturns({ verdict: 'fail', issues: ['第1條未實作'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(await qaFailChip(id)).toContain('已自動退回開發修正');
});

test('去向文案：QA 觸頂 stopped → 不得說退回開發，要說任務停下等你處理', async () => {
  claudeReturns({ verdict: 'fail', issues: ['又錯'] });
  const id = await makeTask(4);                        // 本次是第 5 次（QA_LIMIT=5）
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  const chip = await qaFailChip(id);
  expect(chip).toContain('任務停下等你處理');
  expect(chip).not.toContain('退回開發');
});

test('去向文案：循環斷路器觸頂 stopped → 同樣不得說退回開發，且本輪問題仍留得下來', async () => {
  const { MAX_REENTRY } = require('../pipeline/reentry');
  claudeReturns({ verdict: 'fail', issues: ['備註欄位仍未加'] });
  const id = await makeTask(0);
  await dbModule.query('UPDATE tasks SET reentry_count=$2 WHERE id=$1', [id, MAX_REENTRY - 1]);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  const chip = await qaFailChip(id);
  expect(chip).toContain('任務停下等你處理');
  expect(chip).not.toContain('退回開發');
  // 觸頂那一輪的 log 與 retry_feedback 都必須留下，否則畫面上只剩「循環 N 次仍未通過」，
  // 使用者看不到 QA 到底說了什麼、事後推回 coding 也拿不到退回原因
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('備註欄位仍未加'))).toBe(true);
  expect(t.retry_feedback).toContain('備註欄位仍未加');
});

// strip 契約：去向只能活在標頭列。剝不乾淨的話它會混進下一輪 QA 的未解清單被當成待驗項，
// QA 會對著「已自動退回開發修正」這句話重驗（永遠驗不掉，迴圈收斂不了）。
test('去向後綴不得混進下一輪 QA 的未解清單', async () => {
  claudeReturns({ verdict: 'fail', issues: ['第1條未實作'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);                        // 第一輪 fail：寫下帶去向的 log

  runClaude.mockClear();
  claudeReturns({ verdict: 'pass' });
  await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [id]);
  await runQaAgent(id, userId);                        // 第二輪：把上輪清單帶進 prompt

  const prompt = runClaude.mock.calls[0][0];
  expect(prompt).toContain('第1條未實作');              // 清單本體有帶
  expect(prompt).not.toContain('已自動退回開發修正');    // 去向是給人看的，不進待驗項
  expect(prompt).not.toContain('[QA 未通過]');           // 標頭列整列剝除
});
