const { callClaude } = require('./claude-runner');
const { query } = require('../db');

const TRIAGE_SYSTEM_PROMPT = `你是 AI 開發工作流程的 Triage Agent，負責分析 Odoo/Service 任務並分類。
輸出必須是嚴格合法的 JSON，禁止包含任何其他文字（不得有 markdown code block）。

輸出格式：
{
  "outcome": "answered|triage_blocked|confirm_pending|analysis_running",
  "content": "回覆內容、阻塞原因、或確認事項說明",
  "clarification_questions": []
}

判斷規則：
- answered：純諮詢/問題類，直接給出回覆即可，完全不需要修改任何程式碼
- triage_blocked：需求在技術上無法透過標準 Odoo 模組擴展實現，或需求極度不清楚無法繼續
- confirm_pending：可以實作，但有具體細節需在開始前確認（在 clarification_questions 列出 1-3 個問題）
- analysis_running：需求清晰可直接開始技術分析

content 填寫原則：
- answered：直接回覆問題
- triage_blocked：說明無法實作的具體原因
- confirm_pending：整體說明，具體問題列在 clarification_questions
- analysis_running：一句話確認理解`;

async function triageTask(taskId) {
  await query(
    "UPDATE tasks SET status = 'triage_running', updated_at = NOW() WHERE id = $1",
    [taskId]
  );

  const { rows } = await query('SELECT original_text FROM tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);

  let text;
  try {
    ({ text } = await callClaude(`${TRIAGE_SYSTEM_PROMPT}\n\n${task.original_text || '（無內容）'}`));
  } catch (apiErr) {
    // Transient error — reset to new for retry next tick
    await query(
      "UPDATE tasks SET status = 'new', updated_at = NOW() WHERE id = $1",
      [taskId]
    );
    console.error(`[TRIAGE] API error task ${taskId}:`, apiErr.message);
    throw apiErr;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {
      outcome: 'triage_blocked',
      content: `Triage response parse error: ${String(text).slice(0, 200)}`
    };
  }

  const outcome = parsed.outcome || 'triage_blocked';
  const content = parsed.content || '';
  const clarification_questions = parsed.clarification_questions || [];

  await query(
    `UPDATE tasks SET
       status = $2,
       blocker_content = $3,
       updated_at = NOW()
     WHERE id = $1`,
    [
      taskId,
      outcome,
      outcome === 'triage_blocked' ? content : null
    ]
  );

  if (content) {
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, content]
    );
  }

  return { outcome, content, clarification_questions };
}

async function triageNewTasks(userId) {
  const { rows: tasks } = await query(
    "SELECT id FROM tasks WHERE user_id = $1 AND status = 'new' AND is_hidden = false AND is_paused = false",
    [userId]
  );
  for (const task of tasks) {
    try {
      await triageTask(task.id);
    } catch (err) {
      console.error(`[TRIAGE] task ${task.id}:`, err.message);
    }
  }
}

module.exports = { triageTask, triageNewTasks };
