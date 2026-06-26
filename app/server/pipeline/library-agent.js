const { callClaude } = require('./claude-runner');
const { query } = require('../db');
const notify = require('../notify');

async function runLibraryAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, analysis_yaml, project_id, title FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;

  if (!task.project_id) {
    try {
      await query("UPDATE tasks SET status='done', updated_at=NOW() WHERE id=$1", [taskId]);
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'done' });
    } catch (err) {
      console.error(`[LIBRARY-AGENT] status update error task ${taskId}:`, err.message);
    }
    return;
  }

  const { rows: logs } = await query(
    'SELECT role, content FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 20',
    [taskId]
  );
  const logText = logs.reverse().map(l => `[${l.role}] ${l.content}`).join('\n');

  let wikiUpdate = null;
  try {
    const prompt = `你是 Library Agent，負責維護專案 wiki。

根據以下任務資訊，產生一筆 wiki 更新。回傳 JSON 格式（不要其他文字）：
{"slug":"<slug>","title":"<標題>","content":"<Markdown 內容>"}

slug 規則：英文小寫+連字號，描述功能主題（如 "sales-order-flow"）。

任務標題：${task.title || '未命名'}
任務分析：
${task.analysis_yaml || '無'}

執行日誌（最後 20 筆）：
${logText || '無'}`;

    const text = await callClaude(prompt, signal, { taskId, userId, notify });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) wikiUpdate = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[LIBRARY-AGENT] API error task ${taskId}:`, err.message);
  }

  if (wikiUpdate?.slug && wikiUpdate?.title) {
    try {
      await query(
        `INSERT INTO wiki_pages (project_id, slug, title, content, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (project_id, slug)
         DO UPDATE SET title=$3, content=$4, updated_at=NOW()`,
        [task.project_id, wikiUpdate.slug, wikiUpdate.title, wikiUpdate.content || '']
      );
    } catch (err) {
      console.error(`[LIBRARY-AGENT] wiki upsert error task ${taskId}:`, err.message);
    }
  }

  try {
    await query("UPDATE tasks SET status='done', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'done' });
  } catch (err) {
    console.error(`[LIBRARY-AGENT] status update error task ${taskId}:`, err.message);
  }
}

module.exports = { runLibraryAgent };
