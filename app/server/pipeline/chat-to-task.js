const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { parseAgentResult } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { query } = require('../db');

// 排障對話 → 任務草稿。摘要整串對話成 {title, original_text}，只回草稿、不建任務——
// 前端拿去讓使用者編輯確認後才走既有 POST /api/tasks（human-in-the-loop）。
async function draftTaskFromChat(projectId, chatId, userId) {
  const { rows: msgs } = await query(
    'SELECT role, content FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC',
    [chatId]
  );
  if (!msgs.length) {
    const e = new Error('對話沒有內容可摘要');
    e.status = 400;
    throw e;
  }

  const history = msgs
    .map(m => `${m.role === 'ai' ? '助理' : '用戶'}：${m.content}`)
    .join('\n\n');

  const agent = loadAgent('chat-to-task');
  const prompt = agent.render({ history });

  const ref = { projectId, chatId };
  let result;
  try {
    result = await runClaude(prompt, { model: agent.model, agentType: 'chat-to-task' });
  } catch (err) {
    await logFailedUsage(ref, userId, 'chat-to-task', err);
    throw err;
  }
  await logTokenUsage(ref, userId, 'chat-to-task', result.usage, result.durationMs);

  const draft = await parseAgentResult(result.text, { parse: JSON.parse, ref, userId });
  if (!draft || !draft.title) {
    const e = new Error('無法從對話摘要出任務草稿，請重試');
    e.status = 500;
    throw e;
  }
  return {
    title: String(draft.title).trim(),
    original_text: String(draft.original_text || '').trim()
  };
}

module.exports = { draftTaskFromChat };
