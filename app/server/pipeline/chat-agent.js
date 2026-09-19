const { withResume } = require('./with-resume');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { getProjectNotes } = require('./project-notes');
const { recordTroubleshooting, extractMemoryBlock } = require('./troubleshooting');
const { extractDriftBlock, enqueueWikiDrift } = require('./wiki-drift');
const { extractTaskDraftBlock } = require('./chat-to-task');
const { query } = require('../db');
const { coreSourceGuidance } = require('../lib/odoo-core-src');
const path = require('path');
const { uploadRoot } = require('../lib/attachments');
const { chatAiOutbox, quarantineStaleOutbox, collectChatAiFiles } = require('../lib/chat-ai-files');

// 對話回覆在產生途中中斷（claude-runner 出錯，或 server 進程崩潰/重啟）時，AI 方補寫的訊息。
// role='ai' → 自動計入未讀徽章；讓懸著的提問至少有明確收尾與「請重試」的指引。
const CHAT_INTERRUPTED_MSG = '⚠️ 這則回覆在產生途中中斷了（可能是伺服器重啟或連線異常）。你的訊息已保留，請重新發送以再試一次。';

// 使用者自己按下停止時補的訊息。和上面那則分開：措辭指向「伺服器異常」會讓人以為系統壞了，
// 而這裡是他自己取消的。
const CHAT_STOPPED_MSG = '⏸ 你取消了這則回覆。訊息已保留，重新發送即可再跑一次。';

// agent 根本還沒起跑就丟出的確定性設定錯誤（`agentSetupError`，例：專案的 repo 還沒 clone 完成，
// 見 lib/agent-mounts.js 的 setupError）。這類錯誤重送一百次都是同一個結果，套 CHAT_INTERRUPTED_MSG
// 會一次做錯三件事：誤指成伺服器重啟、蓋掉真因、再給一個保證無效的「請重新發送」。
function chatSetupErrorMsg(err) {
  return `⚠️ 這則回覆還沒開始跑就停住了：${err.message}\n\n` +
    `這是設定還沒就緒，不是連線異常——重新發送會得到同樣的結果。${err.userAction || '請先排除上述狀況再發送一次。'}`;
}

// Office 二進位檔的開啟方式。Read 工具開 .xlsx／.doc 這類檔一律失敗，而失敗之後 agent 照樣會生出
// 一段話——使用者完全看不出它其實沒讀到內容，所以必須明講怎麼開。.doc 那條刻意寫成「不要猜」：
// 這台機器沒有任何可用的 .doc 解析工具（antiword／catdoc／libreoffice 都沒有），能做的只有講實話。
const ATTACHMENT_READ_HINTS = [
  { exts: ['.xlsx', '.xlsm'], text: '.xlsx／.xlsm：`python3` 用 `openpyxl.load_workbook(path, data_only=True)`（少了 data_only 只會拿到公式字串，不是算出來的值）' },
  { exts: ['.xls'], text: '.xls（Excel 97-2003）：`python3` 用 `xlrd.open_workbook(path)`——openpyxl 讀不了這種舊格式' },
  { exts: ['.docx'], text: '.docx：`python3` 用 `docx.Document(path)`，段落在 `.paragraphs`、表格在 `.tables`' },
  { exts: ['.pptx'], text: '.pptx：`python3` 用 `zipfile` 解開，讀 `ppt/slides/slide*.xml` 裡的 `<a:t>` 文字節點' },
  { exts: ['.doc'], text: '.doc（Word 97-2003）：這台機器沒有可用的解析工具，**讀不出內容**。不要猜、不要從檔名推測，直接告訴使用者請另存成 .docx 或 PDF 再傳一次。' }
];

// 這一輪隨訊息附上的檔案，接進 prompt 的措辭。比照 sync.js 的 taskAttachmentNote 帶著授權宣告——
// 少了那句，agent 會照 CLAUDE.md 的「不得存取工作目錄外路徑」規則直接跳過不讀，而且完全沒有訊號：
// 它只會回一段沒看檔也講得出來的話。
function chatAttachmentNote(attachments) {
  if (!attachments || !attachments.length) return '';
  const exts = new Set(attachments.map(a => path.extname(a.filename || '').toLowerCase()));
  const hints = ATTACHMENT_READ_HINTS.filter(h => h.exts.some(e => exts.has(e)));
  return '\n\n【本則訊息附件】以下檔案可用 Read 工具直接檢視（圖片、PDF、CSV／TXT／XML／JSON 這類純文字都可以）。明確授權：讀取這些附件屬唯讀，不受「不得存取工作目錄外路徑」限制；僅可讀取，不得修改。\n' +
    attachments.map(a => `- ${a.filename}${a.mimetype ? `（${a.mimetype}）` : ''}：${path.resolve(uploadRoot(), a.file_path)}`).join('\n') +
    (hints.length
      ? '\n\n【這幾個檔 Read 開不了，照下面讀】\n' + hints.map(h => `- ${h.text}`).join('\n')
      : '');
}

// 把 AI 這輪放進出貨箱的檔掛到剛寫入的那則 AI 訊息，回傳要接在回覆尾端的提示（沒事則空字串）。
// 永不往外拋：附件出事不能讓對話回覆本身失敗；但也不能安靜——沒附上的檔與整體失敗都寫進回覆。
async function attachAiFiles(chatId, messageId) {
  if (!messageId) return '';
  try {
    const { rejected } = await collectChatAiFiles(chatId, messageId);
    if (!rejected.length) return '';
    return '\n\n⚠ 以下檔案沒有附上：\n' + rejected.map(r => `- ${r.filename}：${r.reason}`).join('\n');
  } catch (err) {
    console.error(`[CHAT-AGENT] AI 檔案附加失敗 chat ${chatId}:`, err.message);
    return `\n\n⚠ 檔案附加失敗：${err.message}`;
  }
}

async function chatReply(projectId, chatId, userMessage, userId, attachments = [], signal = undefined) {
  const { rows: history } = await query(
    'SELECT role, content FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10',
    [chatId]
  );
  const historyText = history.reverse()
    .map(m => `${m.role === 'ai' ? '助理' : '用戶'}：${m.content}`)
    .join('\n\n');

  const { getProjectInfo } = require('./task-agent');
  const info = await getProjectInfo(projectId).catch(() => null);
  const repoPaths = info && info.repos.length
    ? info.repos.map(r => `- ${r.local_path}`).join('\n')
    : '（無 repo，僅能查 wiki／正式區 DB／log）';

  const agent = loadAgent('chat');
  const projectNotes = await getProjectNotes(projectId).catch(() => null);

  // 專案備註與 repo 清單只出現在 fresh prompt（chat-retry 只有 {{user_message}}），而 agent prompt
  // 的版本指紋不含這些 per-project 內容——使用者補上「本專案已客製出庫流程」之後，同一場對話往後
  // 每一輪都還是拿第一輪的快照回答，照原生行為講。折進指紋，內容一變就自然降級 fresh 重讀一次。
  // 核心守則同理：某版本快取解好之前回的是「只用 Context7」那版，不折進去的話續接中的
  // 對話會一直停在舊快照。
  const contextVer = require('crypto').createHash('sha1')
    .update(`${projectNotes || ''}\u0000${repoPaths}\u0000${coreSourceGuidance(info && info.odoo_version, info && info.enterprise_src)}`).digest('hex').slice(0, 12);

  // 附圖註記接在 {{user_message}} 上，而不是另開一個 placeholder：chat-retry.md 只有這一個變數
  // （續接輪不重送專案脈絡），接錯地方的話 session 續接的那些輪就完全看不到圖，而且測試照樣全綠。
  // DB 存的 content 維持使用者原文，路徑只進 prompt。
  const promptMessage = userMessage + chatAttachmentNote(attachments);

  // 整包 fresh prompt 延後到真的要用時才組：續接輪只送 {{user_message}}，這裡的查詢與 render
  // 在多數輪次是白做的。history 與 user 訊息的插入有先後關係，不能一起延後（見下方 INSERT）。
  // 使用者在開新對話時挑的優先查證來源。**只是提示不是限制**——照使用者的裁決：
  // 沒選就照原本的判準自己挑，選了也仍可在需要時查別處（例如測試區壞了要比對正式區）。
  // 一個專案可以掛好幾個庫，所以要把「哪一個」講出來，光說「正式區」它不知道是哪一個。
  const dataSourceHintFor = async (value) => {
    if (value === 'test_env') {
      return '【使用者指定】這場對話請優先查平台的測試環境（測試區 Odoo 與它的 log）。真的需要時仍可查其他來源，但先從這裡找。';
    }
    if (/^db:\d+$/.test(String(value || ''))) {
      const { rows } = await query('SELECT name, db_name FROM db_connections WHERE id = $1', [String(value).slice(3)]);
      if (!rows[0]) return '';
      const label = rows[0].name + (rows[0].db_name ? `（資料庫 ${rows[0].db_name}）` : '');
      return `【使用者指定】這場對話請優先查連線「${label}」——用 getSQL 指定這個連線查（唯讀 SELECT），需要 log 時也先看它。真的需要時仍可查其他來源，但先從這裡找。`;
    }
    return '';
  };

  const renderFresh = async () => {
    const { rows: projRows } = await query('SELECT name, folder_name FROM projects WHERE id = $1', [projectId]);
    const { rows: chatRows } = await query('SELECT data_source FROM project_chats WHERE id = $1', [chatId]);
    const dataSourceHint = await dataSourceHintFor(chatRows[0]?.data_source);
    const projectName = projRows[0]?.name || String(projectId);
    // 給 /ai/wiki 的 project 參數用（端點是 folder_name=$1 OR name=$1）：優先 folder_name（純英數），
    // 且一律 encodeURIComponent——中文專案名未編碼放進 URL 會被 Node 的 HTTP parser 判 400，
    // 連 Express 都到不了，agent 只會看到「wiki 查不到」而完全不知道是 URL 的問題。
    // folder_name 是英數時 encodeURIComponent 不改變它，可讀性不受影響。
    const projectSlug = encodeURIComponent(projRows[0]?.folder_name || projectName);
    return agent.render({
      project_name: projectName,
      project_slug: projectSlug,
      repo_paths: repoPaths,
      // 與 cs 共用 cs-capability.md，那份片段的 {{odoo_core_src}} 兩個呼叫端都要傳；
      // 少傳這邊會靜默渲染成空字串（agent-loader 只留 console 告警），chat 就回頭去掃碟找核心。
      odoo_core_src: coreSourceGuidance(info && info.odoo_version, info && info.enterprise_src),
      // 空字串＝沒指定，那一行就整個不出現（placeholder 少傳會靜默渲染成空，這裡是刻意的空）
      data_source_hint: dataSourceHint ? '\n' + dataSourceHint : '',
      // 同一場對話路徑固定，只放 fresh prompt 就夠：續接輪的 session 裡已經有這一行
      chat_files_dir: chatAiOutbox(chatId),
      history: historyText ? '\n\n[對話歷史]\n' + historyText : '',
      user_message: promptMessage,
      project_notes: projectNotes || ''
    });
  };

  const { rows: [userMsg] } = await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3) RETURNING id',
    [chatId, 'user', userMessage]
  );
  // 逐筆而非 WHERE id = ANY($2::int[])：pg-mem 對有索引的欄位用 ANY(...) 會靜默配到 0 列（實測）。
  // 最多 5 筆，逐筆的代價可忽略。
  for (const a of attachments) {
    await query('UPDATE project_chat_attachments SET message_id = $2 WHERE id = $1', [a.id, userMsg.id]);
  }
  // 標記「回覆進行中」：前端據此顯示持續動畫（離開對話再回來也還在，因為是 server 狀態而非本地 state）。
  // 清除一律走下方 finally，確保成功／失敗／任何 throw 都不會留下卡住的 pending。
  await query('UPDATE project_chats SET reply_pending = true WHERE id = $1', [chatId]);
  // 出貨箱的殘留是上一輪行程在收貨前就死掉留下的，不隔離會被這輪回覆誤收成自己的附件。
  try {
    const n = quarantineStaleOutbox(chatId);
    if (n) console.error(`[CHAT-AGENT] chat ${chatId} 出貨箱有 ${n} 個上一輪殘留，已隔離到 _stale_*`);
  } catch (err) { console.error(`[CHAT-AGENT] chat ${chatId} 出貨箱殘留隔離失敗:`, err.message); }

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
        extraVersion: contextVer,
        renderFresh,
        renderRetry: () => loadAgent('chat-retry').render({ user_message: promptMessage }),
        model: agent.model,
        // agent 管理可將 chat 切到 Codex；provider／effort 必須連同 model 傳給 runner。
        // 少了 provider 時 agent-runner 預設走 Claude，會拿 Codex 的 model 名稱呼叫 Claude CLI。
        // signal 讓使用者按得動「停止回覆」：claude-runner 收到 abort 會直接砍掉行程，
        // 沒有它的話停止鈕只能關掉前端動畫、agent 照跑照燒 token。
        runOpts: { agentType: 'chat', provider: agent.provider, effort: agent.effort, signal, projectId, chatId },
        onRetryFailed: (err) => logFailedUsage({ projectId, chatId }, userId, 'chat', err, true)
      });
    } catch (err) {
      await logFailedUsage({ projectId, chatId }, userId, 'chat', err);
      // 中斷也要讓 AI 方留一則訊息（role='ai' 自動計入未讀）：否則使用者的提問就這樣懸著、
      // 既無回覆也無任何線索。process 直接崩潰的情形由啟動時 recoverInterruptedChats 兜底。
      const stopMsg = signal && signal.aborted ? CHAT_STOPPED_MSG
        : (err && err.agentSetupError) ? chatSetupErrorMsg(err)
          : CHAT_INTERRUPTED_MSG;
      const { rows: [stopRow] } = await query(
        'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3) RETURNING id',
        [chatId, 'ai', stopMsg]
      );
      // 被砍之前可能已經做好檔了：掛在收尾訊息上，別讓它們留到下一輪被當殘留隔離掉。
      // 這裡的任何失敗都不得蓋掉原本要拋的 err。
      try {
        const note = await attachAiFiles(chatId, stopRow && stopRow.id);
        if (note) await query('UPDATE project_chat_messages SET content = $2 WHERE id = $1', [stopRow.id, stopMsg + note]);
      } catch (e) { console.error(`[CHAT-AGENT] 中斷收尾的檔案附加失敗 chat ${chatId}:`, e.message); }
      throw err;
    }
    await logTokenUsage({ projectId, chatId }, userId, 'chat', chatResult.usage, chatResult.durationMs, 'completed', chatResult.resumed);

    // 兩個選用側通道，剝掉再顯示、內容各自旁路處理，解析或寫入失敗都不得影響對話回覆本身（Rule 12）：
    //  <memory>    釐清出可留存的結論 → 寫回 wiki 疑難排解區
    //  <wiki-drift> 讀碼發現某 wiki 頁與程式碼矛盾（頁錯、碼對）→ 入漂移佇列供健檢彙整（不自動改文件）
    //  <open-task>  使用者要求開任務 → 草稿隨本輪回應交給前端，由它把建立任務視窗打開（不建任務）
    const mem = extractMemoryBlock(chatResult.text);
    const drift = extractDriftBlock(mem.cleaned);
    const task = extractTaskDraftBlock(drift.cleaned);
    const reply = task.cleaned || '（無回覆）';
    if (mem.entry) {
      try { await recordTroubleshooting(projectId, mem.entry); }
      catch (err) { console.error(`[CHAT-AGENT] troubleshooting 寫回失敗 chat ${chatId}:`, err.message); }
    }
    if (drift.entry) {
      try { await enqueueWikiDrift({ projectId, userId, source: 'chat', slug: drift.entry.slug, reason: drift.entry.reason }); }
      catch (err) { console.error(`[CHAT-AGENT] wiki-drift 入列失敗 chat ${chatId}:`, err.message); }
    }

    const { rows: [aiRow] } = await query(
      'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3) RETURNING id',
      [chatId, 'ai', reply]
    );
    // 附件要掛 message_id，所以只能在訊息寫入之後收貨；有沒附上的檔時回頭補寫提示到同一則
    const filesNote = await attachAiFiles(chatId, aiRow && aiRow.id);
    if (filesNote) {
      await query('UPDATE project_chat_messages SET content = $2 WHERE id = $1', [aiRow.id, reply + filesNote]);
      return { reply: reply + filesNote, taskDraft: task.draft };
    }

    return { reply, taskDraft: task.draft };
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

module.exports = { chatReply, recoverInterruptedChats, CHAT_INTERRUPTED_MSG, CHAT_STOPPED_MSG };
