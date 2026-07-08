const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');
const { upgradeModules } = require('./env-agent');
const { ensureEnvRunning } = require('./ensure-env');
const { classifyFailureWithAgent } = require('./failure-classifier');
const { withProjectLock } = require('./project-lock');

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

// 部署測試區（純程式）：確保 env 運行 → odoo-bin -u 升級。
// 升級成功→playwright_running；升級失敗（程式錯）→退 coding 計數（滿 DEPLOY_LIMIT→stopped）；env 起不來→stopped（infra）。
async function runDeployTesting(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, analysis_yaml, deploy_retry_count FROM tasks WHERE id = $1',
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

  const mods = moduleName ? [moduleName] : [];
  const clsCtx = { taskId: task.task_id, projectId: task.project_id, userId };
  let err = null;
  try {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 測試區升級模組 ${moduleName || 'all'}...\n` });
    await upgradeModules(task.project_id, mods);
  } catch (e) { err = e; }

  // transient（網路抖動/被砍）→ 自動重試一次，不佔計數；再敗重新分類（多半 env）
  if (err && (await classifyFailureWithAgent(err.message, clsCtx)) === 'transient') {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 暫時性失敗，自動重試一次...\n` });
    err = null;
    try { await upgradeModules(task.project_id, mods); } catch (e) { err = e; }
  }

  if (err) {
    // 依失敗類別歸因：env/transient 不是程式問題，不退 coding、不加計數（健檢根因 B）
    const cls = await classifyFailureWithAgent(err.message, clsCtx);
    const odooErr = extractOdooError(err.message);

    if (cls !== 'code') {
      // 環境/仍暫時性問題：停下等人工修環境，不動 coding 計數。
      // env 路徑不累加 deploy_retry_count，log 檔名用時間戳避免重複覆蓋、丟失前次診斷
      const logFile = saveDeployLog(taskId, `env-${Date.now()}`, err);
      const logRef = logFile ? `\n完整 log：${logFile}` : '';
      await query(
        "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, `環境問題（非程式碼），請檢查測試環境後重試。最後錯誤：${odooErr.slice(0, 500)}${logRef}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return;
    }

    // 程式碼問題：退回 coding 修正並計數（滿上限 stopped）
    const nextCount = (task.deploy_retry_count || 0) + 1;
    const logFile = saveDeployLog(taskId, nextCount, err);
    const logRef = logFile ? `\n完整 log：${logFile}` : '';
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', '[部署測試區升級失敗]')", [taskId]);
    if (nextCount >= DEPLOY_LIMIT) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_type='code', deploy_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `測試區升級連續 ${DEPLOY_LIMIT} 次失敗，需人工介入。最後錯誤：${odooErr.slice(0, 500)}${logRef}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      const { bumpReentryOrStop } = require('./reentry');
      if (await bumpReentryOrStop(taskId, userId)) return; // 總循環達上限 → 已標 stopped
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
