const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');
const { upgradeModules, runEnvSetup } = require('./env-agent');

const DEPLOY_LIMIT = 3;

// 專案層序列鎖：同一專案的測試區升級一次一個（不能對同一 DB／env 併發升級）
const _chains = new Map();
function withProjectLock(projectId, fn) {
  const prev = _chains.get(projectId) || Promise.resolve();
  const run = prev.then(fn, fn);
  _chains.set(projectId, run.catch(() => {}));
  return run;
}

// 確保測試環境運行中；未運行則嘗試建立/啟動，仍失敗回傳 false
async function ensureEnvRunning(projectId) {
  const { rows: [env] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (env?.status === 'running') return true;
  await runEnvSetup(projectId);
  const { rows: [env2] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [projectId]);
  return env2?.status === 'running';
}

// 部署測試區（純程式）：確保 env 運行 → odoo-bin -u 升級。
// 升級成功→playwright_running；升級失敗（程式錯）→退 coding 計數（滿 DEPLOY_LIMIT→stopped）；env 起不來→stopped（infra）。
async function runDeployTesting(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, project_id, analysis_yaml, deploy_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;
  return withProjectLock(task.project_id, () => doDeploy(task, taskId, userId));
}

async function doDeploy(task, taskId, userId) {
  let running = false;
  try { running = await ensureEnvRunning(task.project_id); } catch { running = false; }
  if (!running) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='測試環境無法啟動，請至專案環境頁檢查', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  let moduleName = '';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; }
  catch { /* SD 解析失敗則升級全部 */ }

  try {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 測試區升級模組 ${moduleName || 'all'}...\n` });
    await upgradeModules(task.project_id, moduleName ? [moduleName] : []);
  } catch (err) {
    // 升級失敗＝程式載入/語法錯 → 退回 coding 並計數
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[部署測試區升級失敗]\n${err.message}`]
    );
    const nextCount = (task.deploy_retry_count || 0) + 1;
    if (nextCount >= DEPLOY_LIMIT) {
      await query(
        "UPDATE tasks SET status='stopped', deploy_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `測試區升級連續 ${DEPLOY_LIMIT} 次失敗，需人工介入。最後錯誤：${String(err.message).slice(0, 300)}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      await query(
        "UPDATE tasks SET status='coding_running', deploy_retry_count=$2, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    }
    return;
  }

  await query("UPDATE tasks SET status='playwright_running', updated_at=NOW() WHERE id=$1", [taskId]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'playwright_running' });
}

module.exports = { runDeployTesting };
