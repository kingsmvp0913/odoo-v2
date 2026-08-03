const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectInfo, worktreeParent, buildRepoPaths } = require('./task-agent');
const { getProjectNotes } = require('./project-notes');
const { ENV_BASE, runtimeLogPath } = require('./env-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { safeReturnStatus } = require('./stations');

// 卡在哪一關的中文顯示（stuck_stage 用）
const STAGE_LABEL = {
  analysis_running: '分析', coding_running: '開發', qa_running: 'QA 審查',
  merge_running: '併入測試', deploy_testing: '部署測試區', playwright_running: 'E2E 測試',
  respec_running: '調整規格', review_pending: '最終人工審核'
};
// advance.target → 目標 status（白名單，最遠只到 review_pending，不含 done）
const TARGET_STATUS = {
  qa: 'qa_running', merge: 'merge_running', deploy: 'deploy_testing',
  e2e: 'playwright_running', review: 'review_pending'
};
// 各關卡對應的重試計數器：落到該關時歸零，讓使用者聲稱已處理的關卡重取完整重試額度
const RESUME_COUNTER = {
  qa_running: 'qa_retry_count', deploy_testing: 'deploy_retry_count', playwright_running: 'pw_retry_count'
};
// 分診關自己：resume_status 若指向這兩者，代表它是 clarify 閘門寫的「回分診續判」回程，
// 不是原關——原關另存在 triage_home（見 db.js）。誤當原關會讓分診 resume 回到自己、無限重進分診。
const TRIAGE_STATUSES = new Set(['reject_triage', 'resolve_triage']);

async function stop(taskId, userId, reason) {
  await query("UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, reason]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  return true;
}

// 通用分診：任務停下（reject_triage=人工審核退回／resolve_triage=卡關填修正指示）後，
// 讀 diff＋runtime log 查清真相，依「停下原因＋使用者的話」判 resume/advance/fix/respec 決定下一步。
async function runRejectTriage(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, status, git_branch, analysis_yaml, retry_feedback, resume_status, triage_home, respec_return_status, blocker_content FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) return stop(taskId, userId, '專案未設定任何已完成 clone 的 Repo');

  const isReject = task.status === 'reject_triage';

  // 這裡曾有「人工退回 >=2 次就禁 fix、強制降級 respec」的防呆。已移除：它算的是任務累計退回次數，
  // 不是「同一問題重複退回」——兩件無關的退回（例：DB 欄位缺失 ＋ 按鈕樣式）會被算成同一筆帳，
  // 把純樣式修正誤判成規格問題整包重跑分析（實測 task 157）。「這次退的跟上次是不是同一件事」
  // 只有讀得懂內容的 agent 判得出來，改由它依「有沒有改變什麼算正確」自行判 fix／respec
  // （分界線寫在 analysis-reject.md）。把關的是人：每一輪 fix 都是人主動退回換來的（見下方 fix 分支）。

  // 情境輸入：停在哪關、停下原因、使用者最新的話、以及 resume 的「原關」——依入口組不同來源
  let stuckStage, stopContext, userInstruction, homeStatus;
  if (isReject) {
    stuckStage = STAGE_LABEL.review_pending;
    stopContext = '任務已通過所有自動關卡（QA／E2E），在最終人工審核被審核者退回。';
    userInstruction = (task.retry_feedback || '').replace(/^\[人工退回\]\s*/, '').trim() || '（無退回原因）';
    homeStatus = 'review_pending';
  } else {
    // resume_status 指向分診關本身＝走過 clarify 往返（閘門把回程寫在該欄），真正的原關在 triage_home。
    // respec_running 也是中繼關、不是原關：追加需求檢查點攔截推進時，「原本要去的那一關」記在
    // respec_return_status。respec 途中失敗（claude 逾時／認證撞刷新／回非 YAML）會停在 stopped，
    // 使用者解除阻塞後 resume_status 仍是 'respec_running'——不還原就會被下面的 safeReturnStatus
    // 當成非法值落到 coding_running，把一張已經跑到 deploy 的任務打回開發重跑整條尾巴，
    // 正好抵銷掉 respec_return_status 這個欄位存在的目的。
    const home = task.resume_status === 'respec_running'
      ? task.respec_return_status
      : ((TRIAGE_STATUSES.has(task.resume_status) ? null : task.resume_status) || task.triage_home);
    stuckStage = STAGE_LABEL[home] || home || '（未知）';
    stopContext = (task.blocker_content || '（無停下原因）').trim();
    const { rows: [instr] } = await query(
      "SELECT content FROM task_logs WHERE task_id=$1 AND role='user' AND content LIKE '[修正指示]%' ORDER BY created_at DESC LIMIT 1",
      [taskId]
    );
    userInstruction = instr ? instr.content.replace(/^\[修正指示\]\s*/, '').trim() : '（無指示）';
    homeStatus = safeReturnStatus(home);
  }
  // 併入近幾則對話（審核退回時審核者可能有補充）
  const { rows: dlg } = await query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 AND role IN ('user','ai') ORDER BY created_at DESC LIMIT 6", [taskId]
  );
  const convo = dlg.reverse().map(l => `${l.role === 'ai' ? 'AI' : '使用者'}：${l.content}`).join('\n');
  if (convo) userInstruction = `${userInstruction}\n---（近期對話）---\n${convo}`;

  // 尚未納入規格的使用者留言：使用者在關卡執行期間補的話，可能是追加需求，也可能只是流程指令
  // （「已修正，直接推進到部署測試區」這種）。分診看不到它就無從分辨——判 respec 才會讓 analysis
  // 把需求寫進規格，判 advance／fix 則等於當它不存在。這也是 respec 分支有資格銷帳的前提。
  const { rows: pendingMsgs } = await query(
    "SELECT content FROM task_messages WHERE task_id=$1 AND source='manual' AND applied_at IS NULL ORDER BY occurred_at ASC, id ASC",
    [taskId]
  );
  if (pendingMsgs.length) {
    userInstruction = `${userInstruction}\n---（尚未納入規格的使用者留言）---\n${pendingMsgs.map(m => String(m.content).trim()).join('\n')}`;
  }

  // 測試環境 runtime log 路徑（供 agent 自行判斷是否 Bash 讀取實機證據；正斜線好給 Git Bash 用）
  const { rows: [proj] } = await query('SELECT folder_name, name FROM projects WHERE id=$1', [task.project_id]);
  const dirName = proj ? (proj.folder_name || proj.name) : null;
  const runtimeLog = dirName
    ? runtimeLogPath(path.join(ENV_BASE, dirName)).replace(/\\/g, '/')
    : '（無法解析測試環境 log 路徑）';

  let raw;
  try {
    const agent = loadAgent('analysis-reject');
    // base 分支＝任務切點 ai-dev：用 main 當 diff 基底會把其他已核准任務的變更算成本任務的成果
    const { AI_BRANCH } = require('./git');
    const baseBranch = AI_BRANCH;
    const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
    const prompt = agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      main_branch: baseBranch,
      git_branch: task.git_branch || '（未設定）',
      repo_paths: buildRepoPaths(info, task.task_id),
      analysis_yaml: task.analysis_yaml || '（無規格）',
      stuck_stage: stuckStage,
      stop_context: stopContext,
      user_instruction: userInstruction,
      runtime_log_path: runtimeLog,
      project_notes: projectNotes || ''
    }).trim();
    // 停在早期分析階段就被 resume 時 worktree 尚未建立；worktree 不存在 → 退回專案根（一定存在），
    // 否則 spawn 會拿不存在的 cwd 直接 ENOENT。分診不需任務 worktree（判 resume 後回 analysis 會重建）。
    const wt = worktreeParent(info.root, task.task_id);
    const cwd = fs.existsSync(wt) ? wt : info.root;
    const result = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, agentType: 'reject_triage' });
    raw = result.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'reject_triage', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'reject_triage', err);
    if (err.aborted) return true; // 手動暫停：狀態原地不動
    return stop(taskId, userId, stopReason('分診 Agent 執行失敗', err));
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal, ref: { taskId: task.task_id, projectId: task.project_id }, userId });
  const summary = (result?.summary || '').trim();
  const logAi = (content) => query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, content]);

  // 列舉值先正規化再比對（大小寫／前後空白）：模型輸出不穩定，' FIX ' 這種飄動會一路掉到
  // 「未回傳有效結果」，整包分診結論被丟掉、任務白白 stopped。target 同理（不合法會靜默降級成 resume）。
  let decision = String(result?.decision ?? '').trim().toLowerCase();
  const target = String(result?.target ?? '').trim().toLowerCase();

  // 共用：清停下狀態、落到某 status（並歸零該關計數器）。keepFeedback 保留 retry_feedback 給重跑的關卡當回饋。
  // reentry_count 一律歸零：分診＝人工已介入，總循環兜底（MAX_REENTRY）額度應重新起算——
  // 否則達上限被停過的任務，人工放回後只剩一次下游失敗額度就再度永久 stopped，人工介入實質失效。
  // （代價：前端顯示的循環次數變成「距上次人工介入」的次數，屬可接受語意。）
  const goto = async (nextStatus, { keepFeedback = false, freshRespec = false, resetReentry = true } = {}) => {
    const counter = RESUME_COUNTER[nextStatus];
    // triage_home 一併清：本次分診已落地，暫存的原關用完即棄，留著會被下一次分診誤當原關
    const sets = ['status=$2', 'blocker_content=NULL', 'blocker_type=NULL', 'resume_status=NULL', 'triage_home=NULL', 'respec_return_status=NULL', 'updated_at=NOW()'];
    if (resetReentry) sets.push('reentry_count=0');
    if (!keepFeedback) sets.push('retry_feedback=NULL');
    // freshRespec＝交回分析重寫規格，coding 的痕跡要一併清乾淨。git_branch 必須跟 coding_session_id
    // 一起清：respec-agent 判「pre-coding」（＝規格審核閘門的對話式問答，該委派 spec-review）的條件是
    // 兩者皆空，只清一半會讓任務重產規格、停在 spec_review 後，使用者按「送出修改意見」時被判成
    // 「已開工」→ 跳過 spec-review 對話、把修改意見當追加需求 patch 完直接轉 coding_running，
    // 規格審核閘門被靜默繞過。清掉安全：branch_pending→coding 一定會重寫 git_branch，且分支名由
    // task_id 決定、重算同值。
    // spec_session_id／spec_prompt_ver 同樣一併清：真正落地點是 task-agent.js 分析關寫出新規格
    // 那一刻（writeAnalysisYaml，主防線），這裡只是提早在交回 analysis 之前先清一次的備援——
    // 萬一 analysis 那輪中途失敗、任務還沒走到那一刻就又被繞回 spec_review，也不會續接到舊 session。
    if (freshRespec) sets.push('coding_session_id=NULL', 'git_branch=NULL', 'spec_session_id=NULL', 'spec_prompt_ver=NULL');
    if (counter) sets.push(`${counter}=0`);
    await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$1`, [taskId, nextStatus]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  };

  // answer → 純提問（僅最終人工審核退回）：在時間軸回答，不路由。回滾這次 /reject 的副作用——提問不算退回，
  // 只有真的退回修改才計入退回統計／健檢。刪本次 task_rejections(new)＋系統退回標記、清 retry_feedback。
  // 不動 reentry_count：/reject 本就不再累加它，故此處也無 +1 可回滾；若硬扣會誤傷真實自動彈跳累積的計數。
  if (decision === 'answer' && isReject) {
    const question = (task.retry_feedback || '').replace(/^\[人工退回\]\s*/, '').trim() || '（提問）';
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)", [taskId, question]);
    await logAi(summary || '（無回答）');
    const { rows: [rej] } = await query(
      "SELECT id FROM task_rejections WHERE task_id=$1 AND status='new' ORDER BY created_at DESC, id DESC LIMIT 1",
      [task.task_id]
    );
    if (rej) await query('DELETE FROM task_rejections WHERE id=$1', [rej.id]);
    const { rows: [sys] } = await query(
      "SELECT id FROM task_logs WHERE task_id=$1 AND role='system' AND content='[人工退回]' ORDER BY created_at DESC, id DESC LIMIT 1",
      [taskId]
    );
    if (sys) await query('DELETE FROM task_logs WHERE id=$1', [sys.id]);
    await query(
      "UPDATE tasks SET status='review_pending', retry_feedback=NULL, updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'review_pending' });
    return true;
  }

  // clarify → 停下批次問人：退回原因含糊到 fix 與 respec 都說得通、且答案會左右去向時，不硬猜，
  // 走與 QA 同一條統一 clarify 閘門問使用者。答完回原分診關（reject_triage/resolve_triage），
  // 由本員帶「使用者答覆＋原退回原因」續判。carryFeedback 保原因避免被清空。
  const clarifyQs = Array.isArray(result?.questions)
    ? result.questions.map(q => String(q).trim()).filter(Boolean) : [];
  if (decision === 'clarify' && clarifyQs.length) {
    if (summary) await logAi(summary);
    // 閘門會把 resume_status 寫成分診關自己（答完的回程）——原關先搬進 triage_home，否則永久遺失。
    // 只有 resolve 入口有原關可保（reject 入口的原關固定是 review_pending，不需暫存）。
    if (!isReject) await query('UPDATE tasks SET triage_home=$2 WHERE id=$1', [taskId, homeStatus]);
    const { enterClarifyGate } = require('./verdict-router');
    await enterClarifyGate(taskId, userId, {
      questions: clarifyQs,
      carryFeedback: task.retry_feedback,
      resumeStatus: task.status,
      fromStatus: task.status
    });
    return true;
  }

  // respec → 交回分析：分診員不自己改 SD，把結論當「使用者澄清」餵給重跑的 analysis（clarification 讀 role='user'）
  if (decision === 'respec') {
    const handoff = summary || '判定為規格問題，請依停下原因重新分析並調整規格。';
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)", [taskId, `[分診—需調整規格]\n${handoff}`]);
    // 留言的銷帳不在這裡：analysis 這輪可能失敗或被中止，跳關前先銷帳會讓第二輪分診改判 fix／
    // advance 時需求已消失。改由 task-agent.js 在「成功寫出新規格」的同一段落地（見該處註解）。
    await goto('analysis_running', { freshRespec: true });
    return true;
  }

  // fix → coding：保留 retry_feedback（退回原因／失敗回饋）給 coding resume 當修補依據。
  // 刻意「不」過總循環斷路器（bumpReentryOrStop），reentry 一律歸零：斷路器防的是 QA／deploy／E2E
  // 之間無人監督地空轉燒 token（那三關仍各自呼叫它），而分診的每一輪都是人主動退回／填修正指示
  // 換來的，帶著新資訊，不是機器空轉。舊版讓人工退回也吃額度（MAX_REENTRY=2），結果是第二次退回
  // 直接 stopped，且填修正指示 → 又判 fix → 又觸頂 → 任務永久推不動（實測過的死迴圈）。
  if (decision === 'fix') {
    if (summary) await logAi(summary);
    await goto('coding_running', { keepFeedback: true });
    return true;
  }

  // advance → 放行推進到 target（白名單，最遠 review）；target 不合法則保守退回 resume
  if (decision === 'advance' && TARGET_STATUS[target]) {
    if (summary) await logAi(summary);
    let advanceTo = TARGET_STATUS[target];
    // 專案停用 E2E：advance 推進到 E2E 時改導向最終人工審核（旗標在此處也當家，堵住繞過主推進點的路徑）
    if (advanceTo === 'playwright_running') {
      const { rows: [proj] } = await query('SELECT e2e_disabled FROM projects WHERE id=$1', [task.project_id]);
      if (proj && proj.e2e_disabled) {
        await logAi('E2E 已依專案設定停用，跳過');
        advanceTo = 'review_pending';
      }
    }
    await goto(advanceTo);
    return true;
  }

  // resume（含 advance 但 target 不合法）→ 回原關重跑，保留 retry_feedback 給該關當回饋
  if (decision === 'resume' || decision === 'advance') {
    if (summary) await logAi(summary);
    await goto(homeStatus, { keepFeedback: true });
    return true;
  }

  // decision 認得、但這一輪用不了 → 停下交人工，並說清楚實際發生什麼。
  // 刻意**不**比照 advance 缺 target 那樣降級放行——方向性相反：advance 降級是放棄往前推進、
  // 回原關重跑（更保守）；這兩種降級卻是放寬：
  //   - clarify 缺題：agent 說它得先問使用者才能決定方向，卻沒產出題目。放行＝讓任務帶著未解的
  //     疑問繼續跑，多半重蹈覆轍。
  //   - answer 走錯入口：agent 以為使用者只是提問，但 resolve 入口收到的是卡關修正指示。
  //     放行＝使用者的疑問沒人回答。
  // 只修訊息：舊版兩者都掉到下面那句通用文案，把「agent 挑錯決策」謊報成「未回傳有效結果」，
  // 看到的人會跑去 terminal 找解析失敗——但根本沒有解析失敗，agent 有好好回結果。
  const MISUSE = {
    clarify: '分診判定需要先問你問題才能決定方向，卻沒有產出任何題目',
    answer: '分診判定這是一則提問（該決策僅適用於最終人工審核退回），但這裡收到的是卡關修正指示',
  };
  if (MISUSE[decision]) return stop(taskId, userId, `${MISUSE[decision]}。請補充說明後再送出。`);

  return stop(taskId, userId, `分診 Agent 未回傳有效結果（decision=${decision || '空'}），請檢查 terminal 輸出`);
}

module.exports = { runRejectTriage };
