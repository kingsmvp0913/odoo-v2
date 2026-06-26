const { callClaude } = require('./claude-runner');
const { query } = require('../db');

async function chatReply(projectId, chatId, userMessage) {
  const { rows: pages } = await query(
    'SELECT title, content FROM wiki_pages WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 5',
    [projectId]
  );
  let wikiContext = pages.map(p => `## ${p.title}\n${p.content}`).join('\n\n');
  if (wikiContext.length > 3000) wikiContext = wikiContext.slice(0, 3000) + '\n...(截斷)';

  const { rows: history } = await query(
    'SELECT role, content FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10',
    [chatId]
  );
  const historyText = history.reverse()
    .map(m => `${m.role === 'ai' ? '助理' : '用戶'}：${m.content}`)
    .join('\n\n');

  const prompt = `你是一個熟悉 Odoo 的技術助理。請根據以下 Wiki 資料回答問題。若 Wiki 未涵蓋，可依你的知識回答。

Wiki 資料：
${wikiContext || '（無 wiki）'}${historyText ? '\n\n[對話歷史]\n' + historyText : ''}

用戶：${userMessage}`;

  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'user', userMessage]
  );

  const reply = (await callClaude(prompt)) || '（無回覆）';

  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'ai', reply]
  );

  return reply;
}

module.exports = { chatReply };
