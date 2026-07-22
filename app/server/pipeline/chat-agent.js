const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { getProjectNotes } = require('./project-notes');
const { query } = require('../db');

async function chatReply(projectId, chatId, userMessage, userId) {
  const { rows: history } = await query(
    'SELECT role, content FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10',
    [chatId]
  );
  const historyText = history.reverse()
    .map(m => `${m.role === 'ai' ? '助理' : '用戶'}：${m.content}`)
    .join('\n\n');

  const { rows: projRows } = await query('SELECT name FROM projects WHERE id = $1', [projectId]);
  const projectName = projRows[0]?.name || String(projectId);

  const agent = loadAgent('chat');
  const projectNotes = await getProjectNotes(projectId).catch(() => null);
  const prompt = agent.render({
    project_name: projectName,
    history: historyText ? '\n\n[對話歷史]\n' + historyText : '',
    user_message: userMessage,
    project_notes: projectNotes || ''
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
