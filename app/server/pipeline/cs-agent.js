const { callClaude } = require('./claude-runner');
const { query } = require('../db');
const notify = require('../notify');

async function runCsAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, title, original_text, project_id FROM tasks WHERE id = $1',
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

  const prompt = `你是客服分流 Agent。分析以下客戶問題，判斷其性質並決定處理方式。

回傳 JSON（不要其他文字）：
{
  "type": "operation",
  "reply": "給客戶的回覆文字（若 type=operation）",
  "question": null
}
或
{
  "type": "code_change_clear",
  "reply": null,
  "question": null
}
或
{
  "type": "code_change_vague",
  "reply": null,
  "questions": ["問題1", "問題2", "問題3"]
}

判斷標準：
- operation：純操作問題，用現有功能就能解決
- code_change_clear：需要修改程式，且描述足夠清楚（有明確的預期行為、步驟可重現）
- code_change_vague：需要修改程式，但描述模糊（缺乏重現步驟、版本資訊等）；questions 陣列每項為一個獨立問題字串，最多 6 題

客戶問題標題：${task.title || '未命名'}
客戶問題內容：
${task.original_text || '（無詳細內容）'}

Wiki 參考資料：
${wikiContext || '（無 wiki）'}`;

  let result = null;
  try {
    const { text } = await callClaude(prompt, signal, { taskId, userId, notify });
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
  } else {
    await query(
      "UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
  }
}

module.exports = { runCsAgent };
