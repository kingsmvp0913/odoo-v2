const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { getProjectNotes } = require('./project-notes');
const { recordTroubleshooting, extractMemoryBlock } = require('./troubleshooting');
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

  const { getProjectInfo } = require('./task-agent');
  const info = await getProjectInfo(projectId).catch(() => null);
  const repoPaths = info && info.repos.length
    ? info.repos.map(r => `- ${r.local_path}`).join('\n')
    : '（無 repo，僅能查 wiki／正式區 DB／log）';

  const agent = loadAgent('chat');
  const projectNotes = await getProjectNotes(projectId).catch(() => null);
  const prompt = agent.render({
    project_name: projectName,
    repo_paths: repoPaths,
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
  await logTokenUsage({ projectId, chatId }, userId, 'chat', chatResult.usage, chatResult.durationMs);

  // 排障釐清出可留存的結論時，agent 會於回覆末端附一段 <memory> 側通道：剝掉再顯示、內容寫回 wiki
  // 疑難排解區，供下次 AI／人員查詢。側通道解析或寫入失敗都不得影響對話回覆本身（Rule 12：失敗留痕不中斷）。
  const { entry, cleaned } = extractMemoryBlock(chatResult.text);
  const reply = cleaned || '（無回覆）';
  if (entry) {
    try { await recordTroubleshooting(projectId, entry); }
    catch (err) { console.error(`[CHAT-AGENT] troubleshooting 寫回失敗 chat ${chatId}:`, err.message); }
  }

  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'ai', reply]
  );

  return reply;
}

module.exports = { chatReply };
