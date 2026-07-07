const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');
const { upgradeModules, runEnvSetup } = require('./env-agent');

const DEPLOY_LIMIT = 3;

// 從 Odoo 完整 log 抽出「真正的錯誤」：錯誤/Traceback 在 log 結尾，開頭是版本/addons paths 橫幅。
// 優先取最後一段 Traceback；否則取最後一個 ERROR/CRITICAL 行起；都沒有則取結尾。
function extractOdooError(log) {
  const s = String(log == null ? '' : log).trim();
  const tb = s.lastIndexOf('Traceback (most recent call last)');
  if (tb !== -1) return s.slice(tb).trim().slice(0, 1200);
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ERROR|CRITICAL/.test(lines[i])) return lines.slice(i).join('\n').trim().slice(0, 1200);
  }
  // 沒有任何錯誤行＝行程在載入模組前就死了，多半是環境/啟動層問題而非模組程式碼——
  // 標注出來，人與 coding agent 才不會拿 banner 當程式錯誤鑑識（健檢根因 C）
  return '（log 無 ERROR/Traceback——可能是環境或啟動層問題，非模組程式碼錯誤）\n' + s.slice(-600).trim();
}

// 失敗診斷完整落地：blocker/feedback 只留摘要，exit code 與兩路輸出存檔供事後鑑識
function saveDeployLog(taskId, count, err) {
  try {
    const dir = process.env.DEPLOY_LOG_DIR || path.join(__dirname, '..', '..', '..', 'data', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `deploy-task${taskId}-${count}.log`);
    fs.writeFileSync(file, [
      `exitCode: ${err.exitCode ?? '?'}｜killed: ${err.killed ? 'yes' : 'no'}`,
      '--- stderr ---', err.stderr || err.message || '(空)',
      '--- stdout ---', err.stdout || '(空)'
    ].join('\n'));
    return file;
  } catch { return null; }
}

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
    // 升級失敗＝程式載入/語法錯 → 退回 coding 並計數。
    // 記錄（task_logs）只留短標記；完整錯誤存 retry_feedback，coding retry 時餵給 AI 修正。
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', '[部署測試區升級失敗]')",
      [taskId]
    );
    const nextCount = (task.deploy_retry_count || 0) + 1;
    const logFile = saveDeployLog(taskId, nextCount, err);
    const odooErr = extractOdooError(err.message);
    const logRef = logFile ? `\n完整 log：${logFile}` : '';
    if (nextCount >= DEPLOY_LIMIT) {
      await query(
        "UPDATE tasks SET status='stopped', deploy_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `測試區升級連續 ${DEPLOY_LIMIT} 次失敗，需人工介入。最後錯誤：${odooErr.slice(0, 500)}${logRef}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      await query(
        "UPDATE tasks SET status='coding_running', deploy_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `[部署測試區升級失敗]\n${odooErr}${logRef}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    }
    return;
  }

  await query("UPDATE tasks SET status='playwright_running', updated_at=NOW() WHERE id=$1", [taskId]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'playwright_running' });
}

module.exports = { runDeployTesting, extractOdooError };
