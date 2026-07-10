const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectInfo, worktreeParent } = require('./task-agent');
const { ENV_BASE, runtimeLogPath } = require('./env-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');

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

  // 測試環境 runtime log 路徑（供 agent 自行判斷是否 Bash 讀取實機證據；path 統一正斜線好給 Git Bash 用）
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
      reject_reason: rejectReason,
      clarification,
      runtime_log_path: runtimeLog,
      allow_bug: allowBug ? 'true' : 'false'
    }).trim();
    const result = await runClaude(prompt, { cwd: worktreeParent(info.root, task.task_id), taskId, userId, signal, model: agent.model, agentType: 'reject_triage' });
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

  // 規格類（respec），或 bug 被防呆擋下 → 分診員不自己改 SD，交回分析階段重寫。
  // 把分診結論當「使用者澄清」餵給重跑的 analysis（其 clarification 讀 role='user'），指出要往哪改；
  // 清 retry_feedback／coding_session_id 走全新一輪（重建乾淨 worktree → 重寫 SD → fresh coding）。
  if (result?.decision === 'respec' || result?.decision === 'bug') {
    const handoff = summary || '審核者退回，判定為規格問題，請依退回原因重新分析並調整規格。';
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
      [taskId, `[退回—需調整規格]\n${handoff}`]
    );
    await query(
      "UPDATE tasks SET status='analysis_running', retry_feedback=NULL, coding_session_id=NULL, updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
    return true;
  }

  return stop(taskId, userId, '退回分診 Agent 未回傳有效結果，請檢查 terminal 輸出');
}

module.exports = { runRejectTriage };
