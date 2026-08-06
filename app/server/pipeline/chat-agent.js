const { withResume } = require('./with-resume');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { getProjectNotes } = require('./project-notes');
const { recordTroubleshooting, extractMemoryBlock } = require('./troubleshooting');
const { extractDriftBlock, enqueueWikiDrift } = require('./wiki-drift');
const { query } = require('../db');

// 對話回覆在產生途中中斷（claude-runner 出錯，或 server 進程崩潰/重啟）時，AI 方補寫的訊息。
// role='ai' → 自動計入未讀徽章；讓懸著的提問至少有明確收尾與「請重試」的指引。
const CHAT_INTERRUPTED_MSG = '⚠️ 這則回覆在產生途中中斷了（可能是伺服器重啟或連線異常）。你的訊息已保留，請重新發送以再試一次。';

async function chatReply(projectId, chatId, userMessage, userId) {
  const { rows: history } = await query(
    'SELECT role, content FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10',
    [chatId]
  );
  const historyText = history.reverse()
    .map(m => `${m.role === 'ai' ? '助理' : '用戶'}：${m.content}`)
    .join('\n\n');

  const { rows: projRows } = await query('SELECT name, folder_name FROM projects WHERE id = $1', [projectId]);
  const projectName = projRows[0]?.name || String(projectId);
  // 給 /ai/wiki 的 project 參數用（端點是 folder_name=$1 OR name=$1）：優先 folder_name（純英數），
  // 且一律 encodeURIComponent——中文專案名未編碼放進 URL 會被 Node 的 HTTP parser 判 400，
  // 連 Express 都到不了，agent 只會看到「wiki 查不到」而完全不知道是 URL 的問題。
  // folder_name 是英數時 encodeURIComponent 不改變它，可讀性不受影響。
  const projectSlug = encodeURIComponent(projRows[0]?.folder_name || projectName);

  const { getProjectInfo } = require('./task-agent');
  const info = await getProjectInfo(projectId).catch(() => null);
  const repoPaths = info && info.repos.length
    ? info.repos.map(r => `- ${r.local_path}`).join('\n')
    : '（無 repo，僅能查 wiki／正式區 DB／log）';

  const agent = loadAgent('chat');
  const projectNotes = await getProjectNotes(projectId).catch(() => null);
  const prompt = agent.render({
    project_name: projectName,
    project_slug: projectSlug,
    repo_paths: repoPaths,
    history: historyText ? '\n\n[對話歷史]\n' + historyText : '',
    user_message: userMessage,
    project_notes: projectNotes || ''
  });

  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'user', userMessage]
  );
  // 標記「回覆進行中」：前端據此顯示持續動畫（離開對話再回來也還在，因為是 server 狀態而非本地 state）。
  // 清除一律走下方 finally，確保成功／失敗／任何 throw 都不會留下卡住的 pending。
  await query('UPDATE project_chats SET reply_pending = true WHERE id = $1', [chatId]);

  try {
    let chatResult;
    try {
      // session 續接：前一輪讀過的 code／DB／log 都留在 session 裡，續接輪只送使用者這輪的話。
      // chat 的成本 98.8% 在 agentic 調查（prompt 僅 0.9%），無狀態＝同一個問題被反覆完整調查。
      // 刻意不改走「把證據塞回 history」：塞進 prompt 的內容付 cache_create（1.25×），留在 session
      // 裡的下一輪是 cache_read（0.1×），差 12.5 倍；且 history 是 LIMIT 10 滑動視窗，塞大後最舊
      // 那則被擠掉會讓 cache 前綴變動而全數失效，比不塞更貴。
      // 護欄由 with-resume 提供：無 session／prompt 指紋不符／retry 失敗 → 一律降級 fresh，
      // 使用者這輪仍拿得到回覆。
      chatResult = await withResume({
        freshAgentName: 'chat',
        retryAgentName: 'chat-retry',
        getSession: async () => {
          const { rows: [r] } = await query('SELECT chat_session_id, chat_prompt_ver FROM project_chats WHERE id=$1', [chatId]);
          return r && r.chat_session_id ? { sessionId: r.chat_session_id, promptVer: r.chat_prompt_ver } : null;
        },
        setSession: ({ sessionId, promptVer }) =>
          query('UPDATE project_chats SET chat_session_id=$2, chat_prompt_ver=$3 WHERE id=$1', [chatId, sessionId, promptVer]),
        clearSession: () =>
          query('UPDATE project_chats SET chat_session_id=NULL, chat_prompt_ver=NULL WHERE id=$1', [chatId]),
        renderFresh: () => prompt,
        renderRetry: () => loadAgent('chat-retry').render({ user_message: userMessage }),
        model: agent.model,
        runOpts: { agentType: 'chat' },
        onRetryFailed: (err) => logFailedUsage({ projectId, chatId }, userId, 'chat', err)
      });
    } catch (err) {
      await logFailedUsage({ projectId, chatId }, userId, 'chat', err);
      // 中斷也要讓 AI 方留一則訊息（role='ai' 自動計入未讀）：否則使用者的提問就這樣懸著、
      // 既無回覆也無任何線索。process 直接崩潰的情形由啟動時 recoverInterruptedChats 兜底。
      await query(
        'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
        [chatId, 'ai', CHAT_INTERRUPTED_MSG]
      );
      throw err;
    }
    await logTokenUsage({ projectId, chatId }, userId, 'chat', chatResult.usage, chatResult.durationMs);

    // 兩個選用側通道，剝掉再顯示、內容各自旁路處理，解析或寫入失敗都不得影響對話回覆本身（Rule 12）：
    //  <memory>    釐清出可留存的結論 → 寫回 wiki 疑難排解區
    //  <wiki-drift> 讀碼發現某 wiki 頁與程式碼矛盾（頁錯、碼對）→ 入漂移佇列供健檢彙整（不自動改文件）
    const mem = extractMemoryBlock(chatResult.text);
    const drift = extractDriftBlock(mem.cleaned);
    const reply = drift.cleaned || '（無回覆）';
    if (mem.entry) {
      try { await recordTroubleshooting(projectId, mem.entry); }
      catch (err) { console.error(`[CHAT-AGENT] troubleshooting 寫回失敗 chat ${chatId}:`, err.message); }
    }
    if (drift.entry) {
      try { await enqueueWikiDrift({ projectId, userId, source: 'chat', slug: drift.entry.slug, reason: drift.entry.reason }); }
      catch (err) { console.error(`[CHAT-AGENT] wiki-drift 入列失敗 chat ${chatId}:`, err.message); }
    }

    await query(
      'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
      [chatId, 'ai', reply]
    );

    return reply;
  } finally {
    await query('UPDATE project_chats SET reply_pending = false WHERE id = $1', [chatId]);
  }
}

// server 啟動時呼叫：process 若在 chatReply 執行到一半崩潰/被重啟，reply_pending 會永遠停在 true
//（finally 沒機會跑），前端就一直轉圈。啟動代表舊的處理程序已死，把這些孤兒對話補上中斷訊息並清除
// pending。單一平台實例假設下，啟動當下的 pending 必為死掉的前世遺留（見 deployment-topology）。
async function recoverInterruptedChats() {
  const { rows } = await query('SELECT id FROM project_chats WHERE reply_pending = true');
  for (const c of rows) {
    await query(
      'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
      [c.id, 'ai', CHAT_INTERRUPTED_MSG]
    );
    await query('UPDATE project_chats SET reply_pending = false WHERE id = $1', [c.id]);
  }
  if (rows.length) console.log(`[CHAT] 啟動修復：已為 ${rows.length} 個中斷的對話補上中斷訊息`);
  return rows.length;
}

module.exports = { chatReply, recoverInterruptedChats, CHAT_INTERRUPTED_MSG };
