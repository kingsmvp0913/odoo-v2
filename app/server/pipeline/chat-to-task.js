const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { parseAgentResult } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { getProjectNotes } = require('./project-notes');
const { query } = require('../db');
const path = require('path');
const { uploadRoot } = require('../lib/attachments');

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

  // 只列「本次要轉」那段訊息的附圖：舊議題的圖已經跟著上一張任務走了，再列一次只會讓 agent
  // 把它挑進來，等於把已處理的事又夾帶進新任務。
  const currentIds = new Set(current.map(m => m.id));
  const { rows: allAtts } = await query(
    'SELECT id, message_id, filename, mimetype, file_path FROM project_chat_attachments WHERE chat_id = $1 ORDER BY id',
    [chatId]
  );
  const atts = allAtts.filter(a => currentIds.has(a.message_id));

  const agent = loadAgent('chat-to-task');
  const projectNotes = await getProjectNotes(projectId).catch(() => null);
  const prompt = agent.render({
    history: fmt(current),
    prior_history: prior.length ? fmt(prior) : '（無：這是本場對話第一次轉任務）',
    // 編號直接用 DB 主鍵，免去一層對照表——agent 回傳的就是可以直接拿去比對的 id。
    // 帶絕對路徑＋唯讀授權（同 sync.js 的 taskAttachmentNote）：語境判不出來時它才有辦法自己開來看。
    attachments: atts.length
      ? atts.map(a => `- id=${a.id}｜${a.filename}${a.mimetype ? `（${a.mimetype}）` : ''}｜${path.resolve(uploadRoot(), a.file_path)}`).join('\n')
      : '（無：這段對話沒有附圖）',
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
  // 挑圖交給 agent，但它回的編號一概不信：只保留真的在本次清單裡的 id（模型編號、重複、
  // 把舊議題的圖挑回來，全在這一行被擋掉）。回傳含 filename 供前端顯示縮圖與勾選。
  const picked = Array.isArray(draft.attachments) ? draft.attachments.map(Number) : [];

  return {
    title: String(draft.title).trim(),
    original_text: String(draft.original_text || '').trim(),
    // 全部候選都吐回去、被挑中的標 chosen：agent 沒挑的也要讓使用者看得到並能勾回來（這個 modal
    // 的既有精神就是草稿可人工修改，圖沒理由是唯一不能改的）
    attachments: atts.map(a => ({ id: a.id, filename: a.filename, chosen: picked.includes(a.id) }))
  };
}

module.exports = { draftTaskFromChat };
