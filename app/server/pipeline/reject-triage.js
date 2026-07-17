const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectInfo, worktreeParent } = require('./task-agent');
const { ENV_BASE, runtimeLogPath } = require('./env-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');

// 卡在哪一關的中文顯示（stuck_stage 用）
const STAGE_LABEL = {
  analysis_running: '分析', coding_running: '開發', qa_running: 'QA 審查',
  merge_running: '併入測試', deploy_testing: '部署測試區', playwright_running: 'E2E 測試',
  review_pending: '最終人工審核'
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

async function stop(taskId, userId, reason) {
  await query("UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, reason]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  return true;
}

// 通用分診：任務停下（reject_triage=人工審核退回／resolve_triage=卡關填修正指示）後，
// 讀 diff＋runtime log 查清真相，依「停下原因＋使用者的話」判 resume/advance/fix/respec 決定下一步。
async function runRejectTriage(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, status, git_branch, analysis_yaml, retry_feedback, resume_status, blocker_content FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) return stop(taskId, userId, '專案未設定任何已完成 clone 的 Repo');

  const isReject = task.status === 'reject_triage';

  // 防呆：同一 task 已退回幾次（task_rejections 存業務 id）；>=2 禁 fix（只能 advance/respec/resume）
  const { rows: [{ n }] } = await query(
    'SELECT COUNT(*)::int AS n FROM task_rejections WHERE task_id = $1', [task.task_id]
  );
  const allowBug = n <= 1;

  // 情境輸入：停在哪關、停下原因、使用者最新的話、以及 resume 的「原關」——依入口組不同來源
  let stuckStage, stopContext, userInstruction, homeStatus;
  if (isReject) {
    stuckStage = STAGE_LABEL.review_pending;
    stopContext = '任務已通過所有自動關卡（QA／E2E），在最終人工審核被審核者退回。';
    userInstruction = (task.retry_feedback || '').replace(/^\[人工退回\]\s*/, '').trim() || '（無退回原因）';
    homeStatus = 'review_pending';
  } else {
    stuckStage = STAGE_LABEL[task.resume_status] || task.resume_status || '（未知）';
    stopContext = (task.blocker_content || '（無停下原因）').trim();
    const { rows: [instr] } = await query(
      "SELECT content FROM task_logs WHERE task_id=$1 AND role='user' AND content LIKE '[修正指示]%' ORDER BY created_at DESC LIMIT 1",
      [taskId]
    );
    userInstruction = instr ? instr.content.replace(/^\[修正指示\]\s*/, '').trim() : '（無指示）';
    homeStatus = task.resume_status || 'coding_running';
  }
  // 併入近幾則對話（審核退回時審核者可能有補充）
  const { rows: dlg } = await query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 AND role IN ('user','ai') ORDER BY created_at DESC LIMIT 6", [taskId]
  );
  const convo = dlg.reverse().map(l => `${l.role === 'ai' ? 'AI' : '使用者'}：${l.content}`).join('\n');
  if (convo) userInstruction = `${userInstruction}\n---（近期對話）---\n${convo}`;

  // 測試環境 runtime log 路徑（供 agent 自行判斷是否 Bash 讀取實機證據；正斜線好給 Git Bash 用）
  const { rows: [proj] } = await query('SELECT folder_name, name FROM projects WHERE id=$1', [task.project_id]);
  const dirName = proj ? (proj.folder_name || proj.name) : null;
  const runtimeLog = dirName
    ? runtimeLogPath(path.join(ENV_BASE, dirName)).replace(/\\/g, '/')
    : '（無法解析測試環境 log 路徑）';

  let raw;
  try {
    const agent = loadAgent('analysis-reject');
    const { getMainBranch } = require('./git');
    const mainBranch = await getMainBranch(info.repos[0].local_path).catch(() => 'main');
    const prompt = agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      main_branch: mainBranch,
      git_branch: task.git_branch || '（未設定）',
      analysis_yaml: task.analysis_yaml || '（無規格）',
      stuck_stage: stuckStage,
      stop_context: stopContext,
      user_instruction: userInstruction,
      runtime_log_path: runtimeLog,
      allow_bug: allowBug ? 'true' : 'false'
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

  let decision = result?.decision;
  // 防呆：不准 fix 時降級為 respec（同一問題已當程式問題修過仍被退）
  if (decision === 'fix' && !allowBug) decision = 'respec';

  // 共用：清停下狀態、落到某 status（並歸零該關計數器）。keepFeedback 保留 retry_feedback 給重跑的關卡當回饋。
  // reentry_count 預設一併歸零：分診＝人工已介入，總循環兜底（MAX_REENTRY）額度應重新起算——
  // 否則達上限被停過的任務，人工放回後只剩一次下游失敗額度就再度永久 stopped，人工介入實質失效。
  // （代價：前端顯示的循環次數變成「距上次人工介入」的次數，屬可接受語意。）
  // 例外：fix→coding 呼叫端會先過 bumpReentryOrStop 斷路器並傳 resetReentry:false——
  // 人工判 fix 的退回本身也計入總循環額度，不再無條件重取，避免人工退回無限繞過斷路器（長尾主因）。
  const goto = async (nextStatus, { keepFeedback = false, freshRespec = false, resetReentry = true } = {}) => {
    const counter = RESUME_COUNTER[nextStatus];
    const sets = ['status=$2', 'blocker_content=NULL', 'blocker_type=NULL', 'resume_status=NULL', 'updated_at=NOW()'];
    if (resetReentry) sets.push('reentry_count=0');
    if (!keepFeedback) sets.push('retry_feedback=NULL');
    if (freshRespec) sets.push('coding_session_id=NULL');
    if (counter) sets.push(`${counter}=0`);
    await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$1`, [taskId, nextStatus]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  };

  // respec → 交回分析：分診員不自己改 SD，把結論當「使用者澄清」餵給重跑的 analysis（clarification 讀 role='user'）
  if (decision === 'respec') {
    const handoff = summary || '判定為規格問題，請依停下原因重新分析並調整規格。';
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)", [taskId, `[分診—需調整規格]\n${handoff}`]);
    await goto('analysis_running', { freshRespec: true });
    return true;
  }

  // fix → coding：保留 retry_feedback（退回原因／失敗回饋）給 coding resume 當修補依據。
  // 先過總循環斷路器（bumpReentryOrStop）：人工退回的 fix 也計入額度，達上限直接 stopped，
  // 不再無條件放行——關掉「人工退回無限繞過斷路器」的長尾漏洞。
  if (decision === 'fix') {
    if (summary) await logAi(summary);
    const { bumpReentryOrStop } = require('./reentry');
    if (await bumpReentryOrStop(taskId, userId, { blockerContent: summary || '' })) return true; // 達上限已標 stopped
    await goto('coding_running', { keepFeedback: true, resetReentry: false });
    return true;
  }

  // advance → 放行推進到 target（白名單，最遠 review）；target 不合法則保守退回 resume
  if (decision === 'advance' && TARGET_STATUS[result?.target]) {
    if (summary) await logAi(summary);
    let advanceTo = TARGET_STATUS[result.target];
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

  return stop(taskId, userId, '分診 Agent 未回傳有效結果，請檢查 terminal 輸出');
}

module.exports = { runRejectTriage };
