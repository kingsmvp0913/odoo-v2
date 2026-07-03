const { callClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage } = require('./token-logger');
const { query } = require('../db');

async function triageTask(taskId) {
  await query(
    "UPDATE tasks SET status = 'triage_running', updated_at = NOW() WHERE id = $1",
    [taskId]
  );

  const { rows } = await query('SELECT original_text, task_id, user_id FROM tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);

  let text;
  try {
    const agent = loadAgent('triage');
    const callResult = await callClaude(
      agent.render({ original_text: task.original_text || '（無內容）' }),
      undefined,
      { model: agent.model }
    );
    text = callResult.text;
    await logTokenUsage({ taskId: task.task_id }, task.user_id, 'triage', callResult.usage, callResult.durationMs);
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
