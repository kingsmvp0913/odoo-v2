const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectInfo, worktreeParent, latestResolution } = require('./task-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');

const QA_LIMIT = 5;
// 每個 QA session 世代最多 resume 幾次（比照 coding 的 RESUME_LIMIT）：重驗走 --resume
// 續用上輪對話（已含規格、規則、上輪 diff 探索），只送短增量 prompt 省 token
const QA_RESUME_LIMIT = 2;

// QA 審查：對照 SD 檢查任務 diff。pass→merge_running；fail→退 coding 並計數（滿 QA_LIMIT→stopped）。
async function runQaAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, qa_retry_count, qa_session_id, qa_resume_count FROM tasks WHERE id = $1',
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
    // 主分支名依實際 repo 而定（main/master），寫死 main 會讓 diff 基底錯誤、審查失準
    const { getMainBranch } = require('./git');
    const mainBranch = await getMainBranch(info.repos[0].local_path).catch(() => 'main');
    // 撈最近一筆 QA 未解清單餵給本輪：QA 逐項重驗（修好的掉、沒修的留、新的加），讓迴圈收斂而非每輪重新發散。
    // 新語意下每筆 [QA 未通過] 本身即「當下完整未解清單」，取最新一筆＝最完整，不必串接歷史。
    const { rows: [prev] } = await query(
      "SELECT content FROM task_logs WHERE task_id=$1 AND role='ai' AND content LIKE '[QA 未通過]%' ORDER BY id DESC LIMIT 1",
      [taskId]
    );
    const priorFindings = prev ? prev.content.replace(/^\[QA 未通過\]\s*/, '').trim() : '（首輪，無上輪清單）';
    const resolution = (await latestResolution(taskId)) || '（無）';
    // QA 在任務 worktree 父目錄操作（可跨 repo 子目錄讀 diff），只讀不改
    const cwd = worktreeParent(info.root, task.task_id);

    // 重驗走 --resume：上輪 session 已含規格＋審查規則＋repo 探索，本輪只送「重取 diff＋逐項重驗」
    // 的短增量 prompt（比照 coding 的省 token 設計）。首輪／無上輪清單／resume 額度用完 → fresh。
    const canResume = !!task.qa_session_id && (task.qa_resume_count || 0) < QA_RESUME_LIMIT && !!prev;
    let callResult = null;
    if (canResume) {
      const retryAgent = loadAgent('qa-retry');
      const prompt = retryAgent.render({
        main_branch: mainBranch,
        git_branch: task.git_branch || '（未設定）',
        prior_findings: priorFindings,
        resolution
      }).trim();
      try {
        callResult = await runClaude(prompt, { cwd, taskId, userId, signal, resumeSessionId: task.qa_session_id, model: retryAgent.model, agentType: 'qa' });
        await query('UPDATE tasks SET qa_resume_count = qa_resume_count + 1, qa_session_id = COALESCE($2, qa_session_id) WHERE id=$1', [taskId, callResult.sessionId]).catch(() => {});
      } catch (err) {
        // timeout/abort 不 fallback（交外層原樣處理）；其餘（session 遺失、CLI 壞掉）記帳後清 session 改跑 fresh 一次
        if (err.aborted || err.claudeStatus === 'timeout') throw err;
        await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', err);
        await query('UPDATE tasks SET qa_session_id=NULL, qa_resume_count=0 WHERE id=$1', [taskId]).catch(() => {});
        callResult = null;
      }
    }
    if (!callResult) {
      const agent = loadAgent('qa');
      const prompt = agent.render({
        project_name: info.name,
        odoo_version: info.odoo_version,
        main_branch: mainBranch,
        git_branch: task.git_branch || '（未設定）',
        analysis_yaml: task.analysis_yaml || '（無規格）',
        prior_findings: priorFindings,
        resolution
      }).trim();
      callResult = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, agentType: 'qa' });
      await query('UPDATE tasks SET qa_session_id=$2, qa_resume_count=0 WHERE id=$1', [taskId, callResult.sessionId || null]).catch(() => {});
    }
    raw = callResult.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', callResult.usage, callResult.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, stopReason('QA Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal, ref: { taskId: task.task_id, projectId: task.project_id }, userId });

  if (result?.verdict === 'pass') {
    await query("UPDATE tasks SET status='merge_running', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_running' });
    return true;
  }

  if (result?.verdict === 'fail') {
    const issues = Array.isArray(result.issues) ? result.issues.join('\n') : (result.summary || '未提供細節');
    // summary 是 md 契約要求的「給實作 Agent 的修正指引」，要進 retry_feedback；
    // 但不進 [QA 未通過] log——那份是下一輪 QA 的未解清單，混入指引會被當成待驗項
    const feedback = (Array.isArray(result.issues) && result.summary) ? `${issues}\n修正指引：${result.summary}` : issues;
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
        [taskId, nextCount, `[QA 未通過]\n${feedback}`]
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
