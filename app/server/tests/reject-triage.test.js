// 意圖：通用分診員——任務停下（reject_triage=人工退回／resolve_triage=卡關修正指示）後，
// 依使用者語氣＋實機真相判 resume/advance/fix/respec 決定下一步：
//   fix→coding（保留 retry_feedback resume 修補）；respec→analysis（不自己改 SD，結論以 user 澄清餵回）；
//   advance→放行推進到指定關（歸零該關計數器）；resume→回原關重跑；二次退回禁 fix 降級 respec；無效結果 stopped。
const { newDb } = require('pg-mem');

// 核心 source 供給走 docker 解壓——單測不碰真 docker，回固定守則字串即可（真行為由 odoo-core-src.test.js 驗）
jest.mock('../lib/odoo-core-src', () => ({ coreSourceGuidance: () => '（測試：核心來源守則）', ensureOdooCoreSrc: () => '', majorOf: (v) => String(v || '').split('.')[0] }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));
jest.mock('../pipeline/git', () => ({ getMainBranch: jest.fn().mockResolvedValue('main'), AI_BRANCH: 'ai-dev' }));
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, getProjectInfo: jest.fn() };
});

let dbModule, runRejectTriage, taskAgent, runClaude;
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
    "INSERT INTO users (username, password_hash, display_name) VALUES ('rt', $1, 'R') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('RP', '17.0') RETURNING id"
  );
  projectId = p.id;
  taskAgent = require('../pipeline/task-agent');
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ runRejectTriage } = require('../pipeline/reject-triage'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  runClaude.mockReset();
  taskAgent.getProjectInfo.mockReset();
  taskAgent.getProjectInfo.mockResolvedValue({
    name: 'RP', odoo_version: '17.0', root: '/repos/rp',
    repos: [{ subdir: 'main', local_path: '/repos/rp/main' }]
  });
});

let seq = 0;
// 建一個分診中的任務。預設為人工退回入口（reject_triage）。
async function makeTask({ rejectCount = 1, qaRejects = 0, status = 'reject_triage', resume_status = null, blocker = null,
  qa = 0, deploy = 0, pw = 0, instruction = null } = {}) {
  seq++;
  const bizId = `rt_${seq}`;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, blocker_content, project_id,
       git_branch, analysis_yaml, retry_feedback, coding_session_id, qa_retry_count, deploy_retry_count, pw_retry_count)
     VALUES ($1,$2,'odoo','T',$3,$4,$5,$6,'task/x','module: sale','[人工退回]\n備註型別錯','sess-1',$7,$8,$9) RETURNING id`,
    [userId, bizId, status, resume_status, blocker, projectId, qa, deploy, pw]
  );
  for (let i = 0; i < rejectCount; i++) {
    await dbModule.query(
      "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ($1,$2,$3,'r','new')",
      [bizId, projectId, userId]
    );
  }
  // QA 自動退回也寫同一張 task_rejections（source='qa'），但不是「人工退回」
  for (let i = 0; i < qaRejects; i++) {
    await dbModule.query(
      "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status, source) VALUES ($1,$2,$3,'qa','classified','qa')",
      [bizId, projectId, userId]
    );
  }
  if (instruction) {
    await dbModule.query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user',$2)", [t.id, `[修正指示] ${instruction}`]
    );
  }
  return t.id;
}

function claudeReturns(json) {
  runClaude.mockResolvedValue({ text: `x\n<result>\n${JSON.stringify(json)}\n</result>`, usage: null, durationMs: null });
}

// ---- 人工退回入口（reject_triage）----

test('fix → coding_running：保留 retry_feedback、SD 不動、summary 落 AI 泡泡', async () => {
  claudeReturns({ decision: 'fix', summary: '退回原因：備註型別錯；結論：研判為程式 bug，已轉回 coding 修補。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.retry_feedback).toContain('備註型別錯');   // 保留 → coding resume 修補
  expect(t.coding_session_id).toBe('sess-1');          // resume 續用
  expect(t.analysis_yaml).toBe('module: sale');        // SD 不動
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('研判為程式 bug'))).toBe(true);
});

// 總循環斷路器（MAX_REENTRY）防的是 QA／deploy／E2E 之間無人監督地空轉燒 token——那三關各自
// 呼叫 bumpReentryOrStop，不受此處影響。分診的每一輪 fix 都是人主動退回換來的，帶著新資訊，
// 讓它也吃額度的後果是：第二次退回就 stopped，之後填修正指示 → 又判 fix → 又觸頂 → 永久推不動。
test('fix → coding_running 且 reentry_count 歸零（人工介入＝額度重新起算）', async () => {
  claudeReturns({ decision: 'fix', summary: '轉回 coding 修補。' });
  const id = await makeTask({ rejectCount: 1 });
  await dbModule.query('UPDATE tasks SET reentry_count=1 WHERE id=$1', [id]);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, reentry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.reentry_count).toBe(0);
});

// 死迴圈守衛：已在斷路器上限的任務被人工退回，仍須放行進 coding。舊行為在此直接 stopped，
// 而使用者填修正指示會再走一次同一條路 → 再度 stopped，任務再也推不動。
test('fix：已達 MAX_REENTRY 的任務被人工退回 → 仍放行進 coding，不卡死', async () => {
  claudeReturns({ decision: 'fix', summary: '轉回 coding 修補。' });
  const id = await makeTask({ rejectCount: 1 });
  await dbModule.query('UPDATE tasks SET reentry_count=2 WHERE id=$1', [id]); // 已達上限
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, reentry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.reentry_count).toBe(0);
});

// git_branch 必須跟著 coding_session_id 一起清：respec-agent 判「pre-coding」（＝規格審核閘門的
// 對話式問答，該委派給 spec-review）的條件是 `!coding_session_id && !git_branch`，刻意要求兩者皆空
// ——因為 coding fresh 成功但 CLI 沒回 sessionId 時 coding_session_id 會是 NULL，單看它不可靠。
// 只清一半的後果：任務 respec 回分析、重產規格、停在 spec_review，使用者按「送出修改意見」時
// respec-agent 因 git_branch 還在而判定「已開工」，跳過 spec-review 對話、把使用者的修改意見當成
// 追加需求 patch 進規格後**直接轉 coding_running**——規格審核閘門被靜默繞過，使用者never 得到
// 重新確認規格的機會，而且他不會知道。
// 清掉是安全的：branch_pending→coding 一定會重寫 git_branch（runner.js 該處 UPDATE），
// 且分支名由 task_id 決定，重算得到同一個值。
test('respec → analysis_running：清 retry_feedback/coding_session_id/git_branch，結論以 user 澄清餵回分析', async () => {
  claudeReturns({ decision: 'respec', summary: '退回原因：備註需求變更；結論：判定為規格問題，交回分析階段重寫 SD。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id, git_branch, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('analysis_running');
  expect(t.retry_feedback).toBeNull();
  expect(t.coding_session_id).toBeNull();
  expect(t.git_branch).toBeNull();   // 少這行＝規格審核閘門被靜默繞過
  expect(t.analysis_yaml).toBe('module: sale');
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('需調整規格') && l.content.includes('規格問題'))).toBe(true);
});

// Fix round 1（spec_review session 清除點）：真正落地點是 task-agent.js 分析關寫出新規格那一刻
// （writeAnalysisYaml），這裡只是 goto 的 freshRespec 備援——提早在交回 analysis 之前先清一次，
// 防 analysis 那輪中途失敗、任務還沒走到那一刻就又被繞回 spec_review 續接到舊 session。
test('respec → analysis_running：也一併清 spec_session_id／spec_prompt_ver（備援，防繞回 spec_review 續接舊 session）', async () => {
  claudeReturns({ decision: 'respec', summary: '判定為規格問題，交回分析重寫 SD。' });
  const id = await makeTask({ rejectCount: 1 });
  await dbModule.query("UPDATE tasks SET spec_session_id='sp-stale', spec_prompt_ver='F.R' WHERE id=$1", [id]);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT spec_session_id, spec_prompt_ver FROM tasks WHERE id=$1', [id]);
  expect(t.spec_session_id).toBeNull();
  expect(t.spec_prompt_ver).toBeNull();
});

test('advance target=review → review_pending：誤判/點錯直接送審', async () => {
  claudeReturns({ decision: 'advance', target: 'review', summary: '結論：判定為誤判，直接推進到人工審核。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');
  expect(t.retry_feedback).toBeNull();   // 放行不帶失敗回饋
});

test('resume → 回原關（reject 入口的原關＝review_pending）', async () => {
  claudeReturns({ decision: 'resume', summary: '結論：判定為暫時狀態，回原關重跑。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');
});

// 舊版有「人工退回 >=2 次就禁 fix、強制降級 respec」的防呆。它算的是任務累計退回次數而非
// 「同一問題重複退回」，會把兩件無關的退回算成同一筆帳——實測 task 157 因此把「按鈕樣式改一下」
// 誤判成規格問題，整包重跑分析＋重寫實作。去向一律由 agent 依退回內容自行判定。
test('多次人工退回後，模型判 fix 仍走 coding_running（不再被降級成 respec）', async () => {
  claudeReturns({ decision: 'fix', summary: '純樣式問題，轉回 coding 調整 CSS class。' });
  const id = await makeTask({ rejectCount: 3 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.retry_feedback).toContain('備註型別錯');   // 退回原因留給 coding 當修補依據
  expect(t.coding_session_id).not.toBeNull();        // 不清 coding 痕跡＝不必從零重寫
});

// clarify → 統一問人閘門：退回原因含糊到 fix/respec 都說得通時停下問使用者，
// 答完由 resume_status 導回原分診關續判；原退回原因不得被洗掉（carryFeedback 保留）。
test('clarify（帶 questions）→ clarify_pending，resume_status 回 reject_triage，保留原退回原因', async () => {
  claudeReturns({ decision: 'clarify', summary: '退回原因僅寫「備註不對」，無法判定是 bug 還是需求。',
    questions: ['備註欄型別錯，是要修成正確型別（bug），還是改呈現需求（規格）？'] });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, resume_status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('clarify_pending');
  expect(t.resume_status).toBe('reject_triage');       // 答完回原分診關續判，非寫死 coding
  expect(t.retry_feedback).toContain('備註型別錯');      // 原退回原因保留，二次進來讀得到
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('需要你裁決') && l.content.includes('修成正確型別'))).toBe(true);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('無法判定'))).toBe(true); // summary 也落泡泡
});

// 模型輸出的大小寫／尾隨空白不穩定；不正規化就會被判「未回傳有效結果」，整包分診結論被丟掉、任務 stopped。
test('decision 大小寫／空白飄動 → 正規化後照樣走 fix，不當成無效結果', async () => {
  claudeReturns({ decision: ' FIX \n', summary: '轉回 coding 修補。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
});

// 缺 questions 的 clarify＝無效輸出（契約要求必帶）→ fail loud 停下，不靜默放行
test('clarify 但無 questions → stopped（不靜默放行）', async () => {
  claudeReturns({ decision: 'clarify', summary: '想問但沒給問題' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});

// answer → 純提問（僅最終人工審核退回）：在時間軸回答，不路由，回滾這次退回（提問不算退回）。
test('answer（純提問）→ review_pending：Q&A 落時間軸、刪最近 task_rejections、不動 reentry、清退回標記', async () => {
  claudeReturns({ decision: 'answer', summary: '這個欄位設計成唯讀，是因為它同步自來源工單。' });
  const id = await makeTask({ rejectCount: 1 });   // retry_feedback='[人工退回]\n備註型別錯'
  await dbModule.query('UPDATE tasks SET reentry_count=1 WHERE id=$1', [id]);  // 模擬先前真實自動彈跳累積的計數
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'system','[人工退回]')", [id]);

  await runRejectTriage(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status, reentry_count, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');       // 留在原地讓對話持續
  expect(t.reentry_count).toBe(1);               // 提問不動 reentry：/reject 已不再 +1，此處也不扣，才不會誤傷真實彈跳計數
  expect(t.retry_feedback).toBeNull();           // 退回標記／原因清掉
  const { rows: rej } = await dbModule.query(
    "SELECT id FROM task_rejections WHERE task_id=(SELECT task_id FROM tasks WHERE id=$1) AND status='new'", [id]
  );
  expect(rej.length).toBe(0);                     // 本次退回記錄刪除
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('備註型別錯'))).toBe(true);   // 提問落時間軸(=退回原因本文)
  expect(logs.some(l => l.role === 'ai' && l.content.includes('同步自來源工單'))).toBe(true);  // 回答落時間軸
  expect(logs.some(l => l.role === 'system' && l.content === '[人工退回]')).toBe(false);       // 系統退回標記回滾
});

// ---- 卡關修正指示入口（resolve_triage）----

test('resolve 入口 advance target=e2e → playwright_running，並歸零 pw 計數器', async () => {
  claudeReturns({ decision: 'advance', target: 'e2e', summary: '結論：判定為誤判，重測 E2E。' });
  const id = await makeTask({ status: 'resolve_triage', resume_status: 'playwright_running', blocker: 'E2E boom', pw: 3, instruction: '沒事誤判，直接重測 E2E' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count, resume_status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
  expect(t.pw_retry_count).toBe(0);          // 落到 e2e 關 → 重取完整重試額度
  expect(t.resume_status).toBeNull();
  expect(t.blocker_content).toBeNull();
});

test('專案停用 E2E：advance target=e2e 改導向 review_pending，並留痕跡（旗標在此當家，堵繞過路徑）', async () => {
  await dbModule.query('UPDATE projects SET e2e_disabled=true WHERE id=$1', [projectId]);
  try {
    claudeReturns({ decision: 'advance', target: 'e2e', summary: '結論：判定為誤判，重測 E2E。' });
    const id = await makeTask({ status: 'resolve_triage', resume_status: 'playwright_running', blocker: 'E2E boom', pw: 3, instruction: '重測 E2E' });
    await runRejectTriage(id, userId);
    const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
    expect(t.status).toBe('review_pending');   // 不進 E2E，直接送審
    const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1", [id]);
    expect(logs.some(l => l.content.includes('E2E 已依專案設定停用，跳過'))).toBe(true);
  } finally {
    await dbModule.query('UPDATE projects SET e2e_disabled=false WHERE id=$1', [projectId]);
  }
});

test('resolve 入口 resume → 回原關（resume_status）並歸零該關計數器', async () => {
  claudeReturns({ decision: 'resume', summary: '結論：環境已修，回原關重跑。' });
  const id = await makeTask({ status: 'resolve_triage', resume_status: 'qa_running', blocker: 'QA env boom', qa: 3, instruction: '環境弄好了，再跑一次' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, resume_status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('qa_running');
  expect(t.qa_retry_count).toBe(0);
  expect(t.resume_status).toBeNull();
});

// clarify 閘門會把 resume_status 蓋成分診關本身（＝答完的回程）。resolve 入口的 resume_status
// 存的是「真正的原關」，被蓋掉就永久遺失：答完回分診續判時 homeStatus 退化成 coding_running
// （或指回分診自己形成死循環），任務落到不是它該回去的關，該關的重試額度也對不上。
test('resolve 入口 clarify 往返後 resume → 仍回真正的原關（原關不因 clarify 遺失）', async () => {
  claudeReturns({ decision: 'clarify', summary: '指示含糊，無法判定。', questions: ['是程式 bug 還是需求變更？'] });
  const id = await makeTask({ status: 'resolve_triage', resume_status: 'playwright_running', blocker: 'E2E boom', pw: 3, instruction: '再看看' });
  await runRejectTriage(id, userId);
  const { rows: [mid] } = await dbModule.query('SELECT status, resume_status FROM tasks WHERE id=$1', [id]);
  expect(mid.status).toBe('clarify_pending');
  expect(mid.resume_status).toBe('resolve_triage');   // 答完的回程＝回分診續判（此語意不變）

  // 使用者答完 → runner.handleClarifyAnswered 依 resume_status 把任務送回 resolve_triage 續判
  await dbModule.query("UPDATE tasks SET status='resolve_triage' WHERE id=$1", [id]);
  claudeReturns({ decision: 'resume', summary: '已確認是環境問題，回原關重跑。' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count, resume_status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');   // 不是 coding_running、也不是分診關自己
  expect(t.pw_retry_count).toBe(0);
  expect(t.resume_status).toBeNull();
});

// ---- 邊界 ----

test('agent 未回 summary → 不因缺欄位丟例外，fix 仍轉 coding_running', async () => {
  claudeReturns({ decision: 'fix' });
  const id = await makeTask({ rejectCount: 1 });
  await expect(runRejectTriage(id, userId)).resolves.toBe(true);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
});

test('advance 但 target 不合法 → 保守退回 resume（回原關）', async () => {
  claudeReturns({ decision: 'advance', target: 'done', summary: '想跳到完成' });  // done 不在白名單
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');   // reject 入口的原關
});

test('無有效 result → stopped', async () => {
  runClaude.mockResolvedValue({ text: '沒有標記', usage: null, durationMs: null });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});

// ---- 使用者留言的銷帳（防被 runner 的追加需求檢查點二次消費）----
// 意圖：使用者要推進卡住的任務，唯一管道是留言框——所以「用留言下流程指令」是常態。
// 分診讀了它、據此做出決策，就必須一併銷帳；否則 runner.js 的追加需求檢查點會在下一次成功推進時
// 看到 applied_at IS NULL，把同一句流程指令當成新需求丟進 respec 跑一輪再退回 coding。
// task 171 實例：「已修正，直接推進到部署測試區」在 deploy 成功後害整條 pipeline 重跑。
async function addManualMsg(taskId, content = '確認是其他問題造成，已修正，直接推進到部署測試區環節') {
  await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me',$2,NOW())",
    [taskId, content]
  );
}
async function pendingCount(taskId) {
  const { rows: [r] } = await dbModule.query(
    "SELECT COUNT(*)::int AS n FROM task_messages WHERE task_id=$1 AND source='manual' AND applied_at IS NULL", [taskId]
  );
  return r.n;
}

// 銷帳的資格條件＝「落點會不會重新讀到這則留言」，不是「分診有沒有做出決策」。
// fix→coding_running、advance→qa/merge/deploy/review、resume→原關：這些落點**沒有一個**讀
// task_messages（assembleTaskContext 只有 runTaskAnalysis 會呼叫），標了就是把使用者在關卡執行
// 期間補的真需求靜默丟掉——比二次消費更糟，因為畫面上留言還在、使用者不會發現它永遠不生效。
test.each([
  ['advance', { decision: 'advance', target: 'deploy', summary: 's' }],
  ['fix',     { decision: 'fix', summary: 's' }],
  ['resume',  { decision: 'resume', summary: 's' }],
])('%s：留言不得銷帳——落點都不讀 task_messages，標了等於丟掉', async (_name, verdict) => {
  claudeReturns(verdict);
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'coding_running' });
  await addManualMsg(id, '順便把單價欄位改成可編輯');
  await runRejectTriage(id, userId);
  expect(await pendingCount(id)).toBe(1);       // 仍待吸收，留給檢查點吸收進規格
});

// respec 也不在這裡銷帳：它只是「把任務交回 analysis」，analysis 那一輪可能失敗、被中止或使用者
// 中途插手，第二輪分診改判 fix／advance 時留言已被標成已吸收＝需求永久消失、證據還被自己刪掉。
// 銷帳的正確時點是「analysis 真的產出新規格」，落在 task-agent.js（見該處 absorbUpTo 註解）。
test('respec：交回 analysis 時尚不銷帳（等 analysis 真的寫出規格才算吸收）', async () => {
  claudeReturns({ decision: 'respec', summary: 's' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'coding_running' });
  await addManualMsg(id, '順便把單價欄位改成可編輯');
  await runRejectTriage(id, userId);
  expect(await pendingCount(id)).toBe(1);       // 仍待吸收，交給 analysis
});

// 上面那條「respec 才銷帳」的正確性建立在「分診真的看得到留言」之上——看不到就無從分辨
// 「順便改個欄位」（追加需求，該判 respec）與「已修正，直接推進」（流程指令，該判 advance）。
// 這支釘住那個前提；拿掉留言注入，分診就只是在瞎猜。
test('待吸收留言必須進分診 prompt（分辨追加需求與流程指令的唯一依據）', async () => {
  claudeReturns({ decision: 'resume', summary: 's' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'coding_running' });
  await addManualMsg(id, '順便把單價欄位改成可編輯');
  await runRejectTriage(id, userId);
  expect(runClaude.mock.calls[0][0]).toContain('順便把單價欄位改成可編輯');
  // {{odoo_core_src}} 漏傳只會 console.warn，資料來源段會整段變空白（連禁止掃碟的警告都沒了）
  expect(runClaude.mock.calls[0][0]).toContain('（測試：核心來源守則）');
});

// 反向守衛：clarify 是「還在問、尚未消費完」，此時銷帳會讓使用者答完後的真需求永遠不被吸收。
test('clarify：尚未消費完 → 留言不得銷帳（否則答完後真需求會遺失）', async () => {
  claudeReturns({ decision: 'clarify', questions: ['是規格要改，還是程式寫錯？'], summary: 's' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'coding_running' });
  await addManualMsg(id, '這裡的金額算錯了');
  await runRejectTriage(id, userId);
  expect(await pendingCount(id)).toBe(1);       // 仍待吸收
});

// ---- decision 認得但本輪用不了 → 停下交人工，且死因不得誤導 ----
// 行為刻意維持 stopped（既有測試「clarify 但無 questions → stopped（不靜默放行）」守住的正是這點：
// agent 說它得先問才能決定，放行等於讓任務帶著未解疑問繼續跑）。這裡只釘住「訊息要說實話」——
// 舊版兩種情況都落到通用的「未回傳有效結果，請檢查 terminal」，會把人導去找根本不存在的解析失敗。
test('clarify 但沒帶任何問題 → stopped，死因寫出真正原因而非「未回傳有效結果」', async () => {
  claudeReturns({ decision: 'clarify', questions: [], summary: '需要更多資訊' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'qa_running' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('沒有產出任何題目');
  expect(t.blocker_content).not.toContain('未回傳有效結果');
});

test('resolve 入口回 answer（該決策僅適用人工審核退回）→ stopped，死因指出入口用錯', async () => {
  claudeReturns({ decision: 'answer', summary: '這是提問' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'deploy_testing' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('僅適用於最終人工審核退回');
});

// 反向守衛：真的認不得的 decision 才該用通用文案，且要帶上實際收到的值方便追。
test('完全認不得的 decision → stopped，訊息帶出實際收到的值', async () => {
  claudeReturns({ decision: 'teleport', summary: 's' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'coding_running' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('teleport');
});

// ---- 中繼關的回程不得被 safeReturnStatus 當成非法值吞掉 ----
// 「回程狀態」有兩種語意：(a) pipeline 各關的回程（該收斂）、(b) 中繼關的原地續判。
// respec_running 屬 (b)：追加需求檢查點攔截推進時把「原本要去的那一關」記在 respec_return_status，
// respec 途中失敗（逾時／認證撞刷新／回非 YAML）會停在 stopped，使用者解除阻塞後 resume_status
// 仍是 respec_running。不還原就會落到 coding_running，把跑到 deploy 的任務打回開發重跑整條尾巴——
// 正好抵銷掉 respec_return_status 這個欄位存在的目的。
test('respec 途中失敗後解除阻塞 → 回 respec_return_status 記的那一關，不被降級到 coding', async () => {
  claudeReturns({ decision: 'resume', summary: '環境問題已排除，回原關重跑' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'respec_running' });
  await dbModule.query("UPDATE tasks SET respec_return_status='deploy_testing' WHERE id=$1", [id]);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, respec_return_status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('deploy_testing');        // 不是 coding_running
  expect(t.respec_return_status).toBeNull();      // 用完即清，不留給下一輪誤讀
});

// 沒有 respec_return_status 可還原時（舊資料）才允許落安全預設，不得意外落到別的站。
test('resume_status=respec_running 但沒有回程值 → 落安全預設 coding_running', async () => {
  claudeReturns({ decision: 'resume', summary: 's' });
  const id = await makeTask({ rejectCount: 1, status: 'resolve_triage', resume_status: 'respec_running' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
});
