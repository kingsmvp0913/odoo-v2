const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectInfo, worktreeParent } = require('./task-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');

// 同 task 第二次以上退回時給的預設澄清提問（模型判 bug 被防呆擋下時沿用）
const REPEAT_REJECT_QUESTION =
  '這個問題上一輪已當作程式 bug 修正過但仍被退回，請具體說明期望的正確行為與規格，我會據此更新分析書再重做。';

async function stop(taskId, userId, reason) {
  await query("UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, reason]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  return true;
}

// 退回分診：對照 [退回原因 + 現行 SD + 本輪 diff] 判 bug / clarify / respec。
async function runRejectTriage(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, retry_feedback FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) return stop(taskId, userId, '專案未設定任何已完成 clone 的 Repo');

  // 防呆：同一 task 已退回幾次（task_rejections 存業務 id task.task_id）；>=2 禁判 bug
  const { rows: [{ n }] } = await query(
    'SELECT COUNT(*)::int AS n FROM task_rejections WHERE task_id = $1', [task.task_id]
  );
  const allowBug = n <= 1;

  // 退回原因（route 已寫入 retry_feedback，格式 [人工退回]\n...）
  const rejectReason = (task.retry_feedback || '').replace(/^\[人工退回\]\s*/, '').trim() || '（無退回原因）';
  // 對話續接：把近幾則對話 log 併入 prompt（沿用 analysis 澄清做法）
  const { rows: logs } = await query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 8", [taskId]
  );
  const clarification = logs.reverse()
    .filter(l => l.role === 'user' || l.role === 'ai')
    .map(l => `${l.role === 'ai' ? 'AI' : '審核者'}：${l.content}`).join('\n') || '（無）';

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
      reject_reason: rejectReason,
      clarification,
      allow_bug: allowBug ? 'true' : 'false'
    }).trim();
    const result = await runClaude(prompt, { cwd: worktreeParent(info.root, task.task_id), taskId, userId, signal, model: agent.model });
    raw = result.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'reject_triage', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'reject_triage', err);
    if (err.aborted) return true; // 手動暫停：狀態原地不動
    return stop(taskId, userId, stopReason('退回分診 Agent 執行失敗', err));
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal });

  // 使用者面泡泡：原因總結＋結論。summary 缺漏則退回舊行為（不寫空泡泡）。
  const summary = (result?.summary || '').trim();
  const logAi = (content) => query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, content]);

  // bug（且允許）→ 保留 retry_feedback、SD 不動，轉 coding（coding 走 resume 修補）
  if (result?.decision === 'bug' && allowBug) {
    if (summary) await logAi(summary);
    await query("UPDATE tasks SET status='coding_running', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    return true;
  }

  // clarify，或 bug 被防呆擋下 → 落 AI 提問，轉 reject_confirm_pending
  if (result?.decision === 'clarify' || (result?.decision === 'bug' && !allowBug)) {
    const question = (result?.decision === 'clarify' && result.question) ? result.question : REPEAT_REJECT_QUESTION;
    await logAi(summary ? `${summary}\n\n${question}` : question);
    await query("UPDATE tasks SET status='reject_confirm_pending', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'reject_confirm_pending' });
    return true;
  }

  // respec → 改寫 SD、清空 retry_feedback（coding 走 fresh 重做），轉 coding
  if (result?.decision === 'respec' && result.analysis_yaml) {
    if (summary) await logAi(summary);
    await query(
      "UPDATE tasks SET status='coding_running', analysis_yaml=$2, retry_feedback=NULL, updated_at=NOW() WHERE id=$1",
      [taskId, result.analysis_yaml]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    return true;
  }

  return stop(taskId, userId, '退回分診 Agent 未回傳有效結果，請檢查 terminal 輸出');
}

module.exports = { runRejectTriage };
