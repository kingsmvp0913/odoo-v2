const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { E2E_LOGIN, E2E_PASSWORD } = require('./e2e-account');
const { getProjectInfo, worktreeParent } = require('./task-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { ensureEnvRunning } = require('./ensure-env');

const PW_LIMIT = 3;

async function stopTask(taskId, userId, msg, blockerType = null) {
  await query("UPDATE tasks SET status='stopped', blocker_type=$3, blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, msg, blockerType]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

// Playwright E2E：依 SD 產測試計畫並打測試區實跑。
// pass→review_pending；fail→退 coding 計數（滿 PW_LIMIT→stopped）；無 env／無有效結果→stopped。
async function runPlaywrightAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, pw_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  // 測試環境：未運行則自動啟動（與 deploy 階段一致），避免階段間被砍時 E2E 直接報錯
  if (!(await ensureEnvRunning(task.project_id))) {
    await stopTask(taskId, userId, '測試環境未運行且無法自動啟動，請至專案環境頁檢查', 'env');
    return true;
  }
  const { rows: [env] } = await query('SELECT url FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (!env?.url) {
    await stopTask(taskId, userId, '測試環境未提供 URL，無法執行 E2E 測試', 'env');
    return true;
  }

  // 登入憑證：全域固定 E2E 測試帳號（建立環境／同步使用者時已自動寫入測試區）
  const info = await getProjectInfo(task.project_id);
  const cwd = info?.root ? worktreeParent(info.root, task.task_id) : process.cwd();

  let raw;
  try {
    const agent = loadAgent('playwright');
    // 密碼（敏感值）不進 prompt，改以環境變數 E2E_PASSWORD 傳給子行程（健檢 E-1）
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      test_url: env.url,
      login: E2E_LOGIN
    }).trim();
    const result = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, env: { E2E_PASSWORD } });
    raw = result.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', err);
    await stopTask(taskId, userId, stopReason('Playwright Agent 執行失敗', err));
    return true;
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal });

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
    // env 仍 running，但 agent 自報「根本無法完成測試」（連不上、登入進不去、逾時）＝環境/測試帳號問題，
    // 非本次程式碼 bug——與 deploy 一致：不退 coding、不加 pw 計數，停下等人工修環境。
    // 僅明確 failure_type==='env' 才走此路；缺值或其他值一律當 code（保守預設＝現行行為）。
    if (result.failure_type === 'env') {
      await query(
        "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, `E2E 無法完成測試，屬環境／測試帳號問題（非程式碼），請檢查測試環境與登入帳號後重試。最後結果：${String(report).slice(0, 300)}`]
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
      const { bumpReentryOrStop } = require('./reentry');
      if (await bumpReentryOrStop(taskId, userId)) return true; // 總循環達上限 → 已標 stopped
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
