const { callClaude } = require('./claude-runner');
const { execFile } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

const MAX_RETRY = 3;

function runFix(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function analyzeDeployError(errorText, signal, opts = {}) {
  const prompt = `分析以下部署錯誤，判斷類型並提供修復指令。

回傳 JSON（不要其他文字）之一：
{"type":"odoo_error","fix_bin":null,"fix_args":null}
{"type":"env_error_fixable","fix_bin":"pip","fix_args":["install","xxx"]}
{"type":"env_error_needs_auth","fix_bin":null,"fix_args":null}

判斷標準：
- odoo_error：Python traceback、Odoo 模組錯誤（Field、Model、XML 解析等）
- env_error_fixable：缺少 Python 套件（ModuleNotFoundError）可用 pip install 修復、檔案權限（chmod）等
- env_error_needs_auth：需要 sudo、root、SSL 憑證、系統套件（apt）等

部署錯誤：
${errorText}`;

  const { text } = await callClaude(prompt, signal, opts);
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return { type: 'env_error_needs_auth', fix_bin: null, fix_args: null };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { type: 'env_error_needs_auth', fix_bin: null, fix_args: null };
  }
}

async function runDeployFixer(taskId, userId, errorMsg, signal) {
  const { rows: [task] } = await query(
    'SELECT deploy_retry_count FROM tasks WHERE id = $1', [taskId]
  );
  if (!task) return;

  const retryCount = (task.deploy_retry_count || 0) + 1;
  await query('UPDATE tasks SET deploy_retry_count = $2 WHERE id = $1', [taskId, retryCount]);

  if (retryCount > MAX_RETRY) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, `部署重試超過 ${MAX_RETRY} 次上限：${errorMsg}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  let classification;
  try {
    classification = await analyzeDeployError(errorMsg, signal, { taskId, userId, notify });
  } catch {
    classification = { type: 'env_error_needs_auth', fix_bin: null, fix_args: null };
  }

  if (classification.type === 'odoo_error') {
    await query(
      "UPDATE tasks SET status='coding_running', updated_at=NOW() WHERE id=$1", [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    return;
  }

  if (
    classification.type === 'env_error_fixable' &&
    typeof classification.fix_bin === 'string' &&
    Array.isArray(classification.fix_args)
  ) {
    try {
      await runFix(classification.fix_bin, classification.fix_args);
      await query(
        "UPDATE tasks SET status='deploy_pending', updated_at=NOW() WHERE id=$1", [taskId]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_pending' });
    } catch (fixErr) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, `自動修復失敗：${fixErr.message}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    }
    return;
  }

  await query(
    "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
    [taskId, `部署失敗需人工處理：${errorMsg}`]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

module.exports = { runDeployFixer, analyzeDeployError };
