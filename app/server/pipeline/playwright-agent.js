const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const yaml = require('js-yaml');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { E2E_LOGIN, E2E_PASSWORD } = require('./e2e-account');
const { getProjectInfo, worktreeParent } = require('./task-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { ensureEnvRunning } = require('./ensure-env');
const { runTourTests } = require('./env-agent');
const { classifyFailureWithAgent } = require('./failure-classifier');
const { extractOdooError } = require('./deploy-testing');

const PW_LIMIT = 3;

// 失敗診斷完整落地（比照 deploy-testing.js 的 saveDeployLog）：blocker/feedback 只留摘要，
// 完整 stdout/stderr/exitCode 存檔供事後鑑識，避免 tour 斷言細節與 traceback 永久遺失。
function saveTourLog(taskId, err) {
  try {
    const dir = process.env.E2E_LOG_DIR || path.join(__dirname, '..', '..', '..', 'data', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `e2e-task${taskId}-${Date.now()}.log`);
    fs.writeFileSync(file, [
      `exitCode: ${err.exitCode ?? '?'}｜killed: ${err.killed ? 'yes' : 'no'}`,
      '--- stderr ---', err.stderr || err.message || '(空)',
      '--- stdout ---', err.stdout || '(空)'
    ].join('\n'));
    return file;
  } catch { return null; }
}

async function stopTask(taskId, userId, msg, blockerType = null) {
  await query("UPDATE tasks SET status='stopped', blocker_type=$3, blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, msg, blockerType]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

// tour 失敗屬程式問題：把報告餵回 coding 並加計數，滿 PW_LIMIT→stopped（沿用原 E2E 失敗語意）。
async function bounceToCoding(task, taskId, userId, report, logRef = '') {
  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, `[E2E tour 未通過]\n${report}${logRef}`]);
  const nextCount = (task.pw_retry_count || 0) + 1;
  if (nextCount >= PW_LIMIT) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='code', pw_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
      [taskId, nextCount, `E2E tour 連續 ${PW_LIMIT} 次未通過，需人工介入。最後結果：${String(report).slice(0, 300)}${logRef}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }
  const { bumpReentryOrStop } = require('./reentry');
  if (await bumpReentryOrStop(taskId, userId)) return; // 總循環達上限 → 已標 stopped
  await query(
    "UPDATE tasks SET status='coding_running', pw_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
    [taskId, nextCount, `[E2E tour 未通過]\n${report}${logRef}`]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
}

// E2E via Odoo 原生 tour（獨立階段）：agent 產 tour+HttpCase 寫入模組並 commit（副作用），
// 再由 Node 跑 odoo-bin --test-enable 判 exit code；verdict 對映複用 deploy 的分類邏輯。
async function runTourStage(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, pw_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  if (!(await ensureEnvRunning(task.project_id))) {
    await stopTask(taskId, userId, '測試環境未運行且無法自動啟動，請至專案環境頁檢查', 'env');
    return true;
  }
  const { rows: [env] } = await query('SELECT url FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (!env?.url) {
    await stopTask(taskId, userId, '測試環境未提供 URL，無法執行 E2E 測試', 'env');
    return true;
  }

  let moduleName = '';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; } catch { /* SD 解析失敗 */ }
  if (!moduleName) {
    await stopTask(taskId, userId, '無法從分析規格取得 module 名稱，無法產生 tour 測試', 'code');
    return true;
  }

  // 1) tour-author agent：把 tour+HttpCase 寫進模組並 commit（結果由下方 exit code 判，不解析其文字）
  const info = await getProjectInfo(task.project_id);
  const cwd = info?.root ? worktreeParent(info.root, task.task_id) : process.cwd();
  try {
    const agent = loadAgent('playwright');
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      test_url: env.url,
      login: E2E_LOGIN,
      module: moduleName
    }).trim();
    const result = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, env: { E2E_PASSWORD } });
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', err);
    await stopTask(taskId, userId, stopReason('Tour 產生失敗', err));
    return true;
  }

  // 2) Node 跑 tour（odoo-bin --test-enable），依 exit code 判定
  const clsCtx = { taskId: task.task_id, projectId: task.project_id, userId };
  let log = '', err = null;
  try { ({ log } = await runTourTests(task.project_id, moduleName)); } catch (e) { err = e; }

  // transient（網路抖動/被砍）→ 自動重試一次，不佔計數（比照 deploy）
  if (err && (await classifyFailureWithAgent(err.message, clsCtx)) === 'transient') {
    err = null;
    try { ({ log } = await runTourTests(task.project_id, moduleName)); } catch (e) { err = e; }
  }

  if (!err) {
    // 防假綠燈：chrome 消失時 Odoo raise SkipTest（exit 0），log 會有此字樣＝tour 沒真的跑
    if (/Chrome executable not found|unittest\.SkipTest/i.test(log)) {
      await stopTask(taskId, userId, 'tour 被跳過（測試機找不到 Chrome），E2E 未實際執行。請確認測試環境已安裝 Google Chrome。', 'env');
      return true;
    }
    await query("UPDATE tasks SET status='review_pending', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'review_pending' });
    return true;
  }

  // 失敗分類（比照 deploy）：env／env 已非 running → 停等修環境；code → 退 coding 計數
  const cls = await classifyFailureWithAgent(err.message, clsCtx);
  const odooErr = extractOdooError(err.message);
  const logFile = saveTourLog(taskId, err);
  const logRef = logFile ? `\n完整 log：${logFile}` : '';
  const { rows: [env2] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (cls !== 'code' || !env2 || env2.status !== 'running') {
    await stopTask(taskId, userId, `E2E tour 期間屬環境問題（非程式碼），請恢復環境後重試。最後錯誤：${odooErr.slice(0, 500)}${logRef}`, 'env');
    return true;
  }
  await bounceToCoding(task, taskId, userId, odooErr, logRef);
  return true;
}

module.exports = { runTourStage };
