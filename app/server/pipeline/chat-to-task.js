const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { parseAgentResult } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { getProjectNotes } = require('./project-notes');
const { query } = require('../db');

// 排障對話 → 任務草稿。摘要整串對話成 {title, original_text}，只回草稿、不建任務——
// 前端拿去讓使用者編輯確認後才走既有 POST /api/tasks（human-in-the-loop）。
async function draftTaskFromChat(projectId, chatId, userId) {
  const { rows: msgs } = await query(
    'SELECT id, role, content FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC',
    [chatId]
  );
  if (!msgs.length) {
    const e = new Error('對話沒有內容可摘要');
    e.status = 400;
    throw e;
  }

  // 上次轉任務的分界線：之前的只當背景、之後的才是本次要轉的內容。一場排障對話常談完一件事、
  // 轉成任務，接著在同一場繼續談下一件事——不分段的話第二次轉任務會把兩件事混成一張單。
  const { rows: [chat] } = await query(
    'SELECT converted_upto_message_id FROM project_chats WHERE id = $1', [chatId]
  );
  const upto = chat?.converted_upto_message_id || 0;
  const fmt = list => list.map(m => `${m.role === 'ai' ? '助理' : '用戶'}：${m.content}`).join('\n\n');
  let prior = msgs.filter(m => m.id <= upto);
  let current = msgs.filter(m => m.id > upto);
  // 分界線之後一則都不剩＝這場對話自上次轉任務後沒有新內容，使用者仍按了轉任務（多半是想重轉
  // 同一件事）。此時退回舊行為整串重摘，而不是拿空白去問 agent——它只會憑空編一張需求出來。
  if (!current.length) { prior = []; current = msgs; }

  const agent = loadAgent('chat-to-task');
  const projectNotes = await getProjectNotes(projectId).catch(() => null);
  const prompt = agent.render({
    history: fmt(current),
    prior_history: prior.length ? fmt(prior) : '（無：這是本場對話第一次轉任務）',
    project_notes: projectNotes || ''
  });

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
