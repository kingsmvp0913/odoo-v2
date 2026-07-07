const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { decrypt } = require('../lib/crypto');
const { spawnClaude, getProjectInfo, worktreeParent, parseResult } = require('./task-agent');
const { stopReason } = require('./claude-runner');

const PW_LIMIT = 3;

async function stopTask(taskId, userId, msg) {
  await query("UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, msg]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

// Playwright E2E：依 SD 產測試計畫並打測試區實跑。
// pass→review_pending；fail→退 coding 計數（滿 PW_LIMIT→stopped）；無 env／無憑證／無有效結果→stopped。
async function runPlaywrightAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, pw_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  // 測試區 URL
  const { rows: [env] } = await query('SELECT url, status FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (!env || env.status !== 'running' || !env.url) {
    await stopTask(taskId, userId, '測試環境未運行，無法執行 E2E 測試');
    return true;
  }

  // 登入憑證：任務所屬使用者的可逆加密密碼
  const { rows: [user] } = await query('SELECT username, password_enc FROM users WHERE id=$1', [userId]);
  let password = null;
  if (user?.password_enc) { try { password = decrypt(user.password_enc); } catch { password = null; } }
  if (!password) {
    await stopTask(taskId, userId, '使用者尚未建立 E2E 憑證，請重新登入一次系統後重試');
    return true;
  }

  const info = await getProjectInfo(task.project_id);
  const cwd = info?.root ? worktreeParent(info.root, task.task_id) : process.cwd();

  let raw;
  try {
    const agent = loadAgent('playwright');
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      test_url: env.url,
      login: user.username,
      password
    }).trim();
    const result = await spawnClaude(prompt, { cwd, taskId, userId, signal, model: agent.model });
    raw = result.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', err);
    await stopTask(taskId, userId, stopReason('Playwright Agent 執行失敗', err));
    return true;
  }

  const result = parseResult(raw);

  if (result?.verdict === 'pass') {
    await query("UPDATE tasks SET status='review_pending', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'review_pending' });
    return true;
  }

  if (result?.verdict === 'fail') {
    const report = result.report || result.plan || '未提供細節';
    // env 若已非 running（多半被夜間 shutdown 砍了／掛了），E2E 失敗是環境問題不是程式 bug——
    // 不退 coding、不加 pw 計數，停下等環境恢復（健檢：夜間 shutdown 誤歸因）
    const { rows: [env2] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [task.project_id]);
    if (!env2 || env2.status !== 'running') {
      await query(
        "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, `測試環境於 E2E 期間停止運行，屬環境問題（非程式碼），請恢復環境後重試。最後結果：${String(report).slice(0, 300)}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return true;
    }
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[E2E 測試未通過]\n${report}`]
    );
    const nextCount = (task.pw_retry_count || 0) + 1;
    if (nextCount >= PW_LIMIT) {
      await query(
        "UPDATE tasks SET status='stopped', pw_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `E2E 連續 ${PW_LIMIT} 次未通過，需人工介入。最後結果：${String(report).slice(0, 300)}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      // 失敗報告餵回 coding（與 QA／deploy 一致），否則重跑只能盲改（健檢 U4）
      await query(
        "UPDATE tasks SET status='coding_running', pw_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `[E2E 測試未通過]\n${report}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    }
    return true;
  }

  await stopTask(taskId, userId, 'Playwright Agent 未回傳有效結果，請檢查 terminal 輸出');
  return true;
}

module.exports = { runPlaywrightAgent };
