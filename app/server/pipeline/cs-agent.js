const { callClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage } = require('./token-logger');
const { query } = require('../db');
const notify = require('../notify');

async function runCsAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, original_text, project_id, user_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;

  let wikiContext = '';
  if (task.project_id) {
    const { rows: pages } = await query(
      'SELECT title, content FROM wiki_pages WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 5',
      [task.project_id]
    );
    wikiContext = pages.map(p => `## ${p.title}\n${p.content}`).join('\n\n');
  }

  const agent = loadAgent('cs');
  const prompt = agent.render({
    title: task.title || '未命名',
    original_text: task.original_text || '（無詳細內容）',
    wiki: wikiContext || '（無 wiki）'
  });

  let result = null;
  try {
    const { text, usage, durationMs } = await callClaude(prompt, signal, { taskId, userId, notify, model: agent.model });
    await logTokenUsage({ taskId: task.task_id }, task.user_id, 'cs', usage, durationMs);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) result = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[CS-AGENT] API error task ${taskId}:`, err.message);
  }

  if (!result) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, 'CS agent failed to parse response']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  if (result.type === 'operation') {
    await query(
      "UPDATE tasks SET status='cs_reply_pending', cs_reply=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.reply || '']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_reply_pending' });
  } else if (result.type === 'code_change_vague') {
    await query(
      "UPDATE tasks SET status='cs_data_needed', cs_question=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.question || JSON.stringify(result.questions || [])]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_data_needed' });
  } else if (!task.project_id) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, '需修改程式的任務必須先綁定專案，請至任務設定綁定專案後重試']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  } else {
    await query(
      "UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
  }
}

module.exports = { runCsAgent };
