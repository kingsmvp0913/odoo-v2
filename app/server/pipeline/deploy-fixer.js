const { callClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage } = require('./token-logger');
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
  const agent = loadAgent('deploy-fix');
  const callResult = await callClaude(agent.render({ error_text: errorText }), signal, { ...opts, model: agent.model });
  const match = callResult.text.match(/\{[\s\S]*?\}/);
  let classification;
  if (!match) {
    classification = { type: 'env_error_needs_auth', fix_bin: null, fix_args: null };
  } else {
    try {
      classification = JSON.parse(match[0]);
    } catch {
      classification = { type: 'env_error_needs_auth', fix_bin: null, fix_args: null };
    }
  }
  return { classification, usage: callResult.usage, durationMs: callResult.durationMs };
}

async function runDeployFixer(taskId, userId, errorMsg, signal) {
  const { rows: [task] } = await query(
    'SELECT task_id, deploy_retry_count FROM tasks WHERE id = $1', [taskId]
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
    const analyzeResult = await analyzeDeployError(errorMsg, signal, { taskId, userId, notify });
    classification = analyzeResult.classification;
    await logTokenUsage({ taskId: task.task_id }, userId, 'deploy_fix', analyzeResult.usage, analyzeResult.durationMs);
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
