const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { query } = require('../db');

async function chatReply(projectId, chatId, userMessage, userId) {
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

  const agent = loadAgent('chat');
  const prompt = agent.render({
    wiki: wikiContext || '（無 wiki）',
    history: historyText ? '\n\n[對話歷史]\n' + historyText : '',
    user_message: userMessage
  });

  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'user', userMessage]
  );

  let chatResult;
  try {
    chatResult = await runClaude(prompt, { model: agent.model, agentType: 'chat' });
  } catch (err) {
    await logFailedUsage({ projectId, chatId }, userId, 'chat', err);
    throw err;
  }
  const reply = chatResult.text || '（無回覆）';
  await logTokenUsage({ projectId, chatId }, userId, 'chat', chatResult.usage, chatResult.durationMs);

  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'ai', reply]
  );

  return reply;
}

module.exports = { chatReply };
