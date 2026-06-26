const { callClaude } = require('./claude-runner');
const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');

const ANALYSIS_SYSTEM_PROMPT = `你是 Odoo 開發需求分析師。分析任務需求並輸出 analysis.yaml。

輸出必須是嚴格合法的 YAML，只有 YAML 本身，不含任何 markdown code block 或其他文字。

必要欄位：
case_id（任務 ID）、module（英文底線格式，e.g. purchase）、odoo_version（e.g. "17.0"）、
project_name（null 或字串）、execution_mode（"MODE_A" 直接實作 / "MODE_B" 先確認再實作）、
summary（一段中文摘要）、requirements（列表）、
low_confidence（true/false）、
clarification_channel:
  questions: []
  user_answer: ""

判斷規則：
- MODE_A：需求明確、影響範圍小、修改集中在單一模組
- MODE_B：涉及複雜業務流程、多模組影響、高風險資料異動
- low_confidence=true：對需求有重大不確定性
- questions 非空：有需要使用者確認的具體問題`;

const REQUIRED_FIELDS = ['case_id', 'module', 'odoo_version', 'execution_mode', 'summary'];

function determineNextStatus(parsed) {
  const hasQuestions = Array.isArray(parsed?.clarification_channel?.questions) &&
    parsed.clarification_channel.questions.length > 0;
  if (parsed?.low_confidence === true || hasQuestions) return 'confirm_pending';
  if (parsed?.execution_mode === 'MODE_B') return 'final_pending';
  return 'branch_pending';
}

async function analyzeTask(taskId, signal) {
  const { rows } = await query('SELECT original_text, task_id, user_id FROM tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Block 1: API call — transient errors reset status and re-throw
  let rawYaml;
  try {
    rawYaml = await callClaude(`${ANALYSIS_SYSTEM_PROMPT}\n\n${task.original_text || '（無內容）'}`, signal, { taskId, userId: task.user_id, notify });
  } catch (apiErr) {
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

  return { next_status, analysis_yaml: rawYaml };
}

module.exports = { analyzeTask };
