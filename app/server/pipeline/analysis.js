const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');

const REQUIRED_FIELDS = ['case_id', 'module', 'odoo_version', 'execution_mode', 'summary'];

function determineNextStatus(parsed) {
  const hasQuestions = Array.isArray(parsed?.clarification_channel?.questions) &&
    parsed.clarification_channel.questions.length > 0;
  if (parsed?.low_confidence === true || hasQuestions) return 'confirm_pending';
  // MODE_B＝先確認再實作 → 等使用者確認（confirm_pending）。
  // 舊的 final_pending 是死狀態：無 handler、無前端標籤，任務會卡死不可見（健檢 U14）
  if (parsed?.execution_mode === 'MODE_B') return 'confirm_pending';
  return 'branch_pending';
}

async function analyzeTask(taskId, signal) {
  const { rows } = await query('SELECT original_text, task_id, user_id FROM tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Block 1: API call — transient errors reset status and re-throw
  let rawYaml;
  try {
    const agent = loadAgent('analysis-basic');
    const callResult = await runClaude(
      agent.render({ original_text: task.original_text || '（無內容）' }),
      { signal, taskId, userId: task.user_id, model: agent.model }
    );
    rawYaml = callResult.text;
    await logTokenUsage({ taskId: task.task_id }, task.user_id, 'analysis', callResult.usage, callResult.durationMs);
  } catch (apiErr) {
    await logFailedUsage({ taskId: task.task_id }, task.user_id, 'analysis', apiErr);
    await query(
      "UPDATE tasks SET status = 'analysis_running', updated_at = NOW() WHERE id = $1",
      [taskId]
    );
    console.error(`[ANALYSIS] API error task ${taskId}:`, apiErr.message);
    throw apiErr;
  }

  // Block 2: YAML parse + validate — failures → stopped
  let parsed;
  try {
    parsed = yaml.load(rawYaml, { schema: yaml.CORE_SCHEMA });
    const missing = REQUIRED_FIELDS.filter(f => parsed?.[f] == null || parsed[f] === '');
    if (missing.length > 0) throw new Error(`Missing required YAML fields: ${missing.join(', ')}`);
  } catch (parseErr) {
    await query(
      `UPDATE tasks SET status = 'stopped', blocker_content = $2, updated_at = NOW() WHERE id = $1`,
      [taskId, `Analysis YAML error: ${parseErr.message}\n\n${rawYaml.slice(0, 500)}`]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
    return { next_status: 'stopped', analysis_yaml: rawYaml };
  }

  const next_status = determineNextStatus(parsed);

  await query(
    `UPDATE tasks SET status = $2, analysis_yaml = $3, updated_at = NOW() WHERE id = $1`,
    [taskId, next_status, rawYaml]
  );

  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `Analysis: ${parsed.summary || ''}\nMode: ${parsed.execution_mode}\nModule: ${parsed.module}`]
  );

  notify.emitToUser(task.user_id, 'task:updated', { taskId, status: next_status });

  return { next_status, analysis_yaml: rawYaml };
}

module.exports = { analyzeTask };
