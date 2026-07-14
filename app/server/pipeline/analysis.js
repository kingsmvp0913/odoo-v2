const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractResult } = require('./agent-result');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');
const { assembleTaskContext } = require('./sync');

const REQUIRED_FIELDS = ['case_id', 'module', 'odoo_version', 'execution_mode', 'summary'];
// API 失敗保留 analysis_running 讓 cron 重試（transient 自癒），但需上限兜底：
// 持久性故障（CLI 壞掉、credentials）不設限會每分鐘無限重試、token 與機器空燒
const ANALYSIS_RETRY_LIMIT = parseInt(process.env.PIPELINE_ANALYSIS_RETRY_LIMIT || '3', 10);

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
  const { rows } = await query('SELECT task_id, user_id FROM tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);
  const original_text = await assembleTaskContext(taskId);

  // Block 1: API call — transient errors reset status and re-throw
  let rawYaml;
  try {
    const agent = loadAgent('analysis-basic');
    const callResult = await runClaude(
      agent.render({ original_text: original_text || '（無內容）' }),
      { signal, taskId, userId: task.user_id, model: agent.model, agentType: 'analysis' }
    );
    rawYaml = callResult.text;
    await logTokenUsage({ taskId: task.task_id }, task.user_id, 'analysis', callResult.usage, callResult.durationMs);
  } catch (apiErr) {
    await logFailedUsage({ taskId: task.task_id }, task.user_id, 'analysis', apiErr);
    if (apiErr.aborted) throw apiErr; // 手動暫停：不計失敗、狀態原地，解除暫停後從這一關重跑
    const { rows: [r] } = await query(
      'UPDATE tasks SET analysis_retry_count = COALESCE(analysis_retry_count, 0) + 1, updated_at = NOW() WHERE id = $1 RETURNING analysis_retry_count',
      [taskId]
    );
    if ((r?.analysis_retry_count || 0) >= ANALYSIS_RETRY_LIMIT) {
      await query(
        "UPDATE tasks SET status = 'stopped', blocker_content = $2, updated_at = NOW() WHERE id = $1",
        [taskId, `分析連續 ${ANALYSIS_RETRY_LIMIT} 次執行失敗，需人工介入。最後錯誤：${apiErr.message}`]
      );
      notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
      return { next_status: 'stopped', analysis_yaml: null };
    }
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
    // 統一契約：<result> 包住的 YAML，剝 fence＋解析失敗先 haiku 補救一次（健檢 F）
    parsed = await parseAgentResult(rawYaml, {
      parse: s => yaml.load(s, { schema: yaml.CORE_SCHEMA }), signal,
      ref: { taskId: task.task_id }, userId: task.user_id
    });
    if (!parsed) throw new Error('無法解析為有效 YAML');
    const missing = REQUIRED_FIELDS.filter(f => parsed?.[f] == null || parsed[f] === '');
    if (missing.length > 0) throw new Error(`Missing required YAML fields: ${missing.join(', ')}`);
  } catch (parseErr) {
    if (parseErr.aborted) throw parseErr; // 補救期間手動暫停：不是解析失敗，狀態原地不動

    await query(
      `UPDATE tasks SET status = 'stopped', blocker_content = $2, updated_at = NOW() WHERE id = $1`,
      [taskId, `Analysis YAML error: ${parseErr.message}\n\n${rawYaml.slice(0, 500)}`]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
    return { next_status: 'stopped', analysis_yaml: rawYaml };
  }

  const next_status = determineNextStatus(parsed);
  // 存剝乾淨的 YAML（去掉 <result> 包絡與 fence），別把契約標記雜訊帶進下游 spec
  const cleanYaml = extractResult(rawYaml) || rawYaml;

  await query(
    `UPDATE tasks SET status = $2, analysis_yaml = $3, analysis_retry_count = 0, updated_at = NOW() WHERE id = $1`,
    [taskId, next_status, cleanYaml]
  );

  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `Analysis: ${parsed.summary || ''}\nMode: ${parsed.execution_mode}\nModule: ${parsed.module}`]
  );

  notify.emitToUser(task.user_id, 'task:updated', { taskId, status: next_status });

  return { next_status, analysis_yaml: cleanYaml };
}

// determineNextStatus / REQUIRED_FIELDS 供 task-agent（analysis-project 路徑）共用：
// 兩條分析路徑同一份「YAML → 下一狀態」推導與必要欄位驗證，避免雙契約漂移
module.exports = { analyzeTask, determineNextStatus, REQUIRED_FIELDS };
