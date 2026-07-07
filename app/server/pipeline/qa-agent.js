const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { spawnClaude, getProjectInfo, worktreeParent, parseResult, latestResolution } = require('./task-agent');
const { stopReason } = require('./claude-runner');

const QA_LIMIT = 3;

// QA 審查：對照 SD 檢查任務 diff。pass→merge_running；fail→退 coding 並計數（滿 QA_LIMIT→stopped）。
async function runQaAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, qa_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='專案未設定任何已完成 clone 的 Repo', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  let raw;
  try {
    const agent = loadAgent('qa');
    // 主分支名依實際 repo 而定（main/master），寫死 main 會讓 diff 基底錯誤、審查失準
    const { getMainBranch } = require('./git');
    const mainBranch = await getMainBranch(info.repos[0].local_path).catch(() => 'main');
    const prompt = agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      main_branch: mainBranch,
      git_branch: task.git_branch || '（未設定）',
      analysis_yaml: task.analysis_yaml || '（無規格）',
      resolution: (await latestResolution(taskId)) || '（無）'
    }).trim();
    // QA 在任務 worktree 父目錄操作（可跨 repo 子目錄讀 diff），只讀不改
    const result = await spawnClaude(prompt, { cwd: worktreeParent(info.root, task.task_id), taskId, userId, signal, model: agent.model });
    raw = result.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', err);
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, stopReason('QA Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = parseResult(raw);

  if (result?.verdict === 'pass') {
    await query("UPDATE tasks SET status='merge_running', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_running' });
    return true;
  }

  if (result?.verdict === 'fail') {
    const issues = Array.isArray(result.issues) ? result.issues.join('\n') : (result.summary || '未提供細節');
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[QA 未通過]\n${issues}`]
    );
    const nextCount = (task.qa_retry_count || 0) + 1;
    if (nextCount >= QA_LIMIT) {
      await query(
        "UPDATE tasks SET status='stopped', qa_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `QA 連續 ${QA_LIMIT} 次未通過，需人工介入。最後問題：${issues.slice(0, 300)}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      const { bumpReentryOrStop } = require('./reentry');
      if (await bumpReentryOrStop(taskId, userId)) return true; // 總循環達上限 → 已標 stopped
      await query(
        "UPDATE tasks SET status='coding_running', qa_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `[QA 未通過]\n${issues}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    }
    return true;
  }

  // 無有效 RESULT-JSON
  await query(
    "UPDATE tasks SET status='stopped', blocker_content='QA Agent 未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1",
    [taskId]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  return true;
}

module.exports = { runQaAgent };
