const { runClaude } = require('./claude-runner');
const { logTokenUsage } = require('./token-logger');
const { query } = require('../db');

// 建立對話時前後端都填這四個字（chat-routes 的 POST 與 db.js 的欄位預設值）。
// 只有仍是這個值的對話才自動命名——使用者自己取過名字的、或先前已自動命名過的都不能蓋掉。
const DEFAULT_TITLE = '新對話';
// 側欄那一欄很窄，再長也只是被截斷。
const MAX_LEN = 24;
// 產標題不該拖住對話。逾時就放棄，標題維持「新對話」，下一則訊息還有機會再試。
const TIMEOUT_MS = 60000;
// 整段對話丟進去只是浪費 token：標題要的是主題，開頭幾句就講完了。
const EXCERPT_LEN = 600;

function buildPrompt(userMessage, aiReply) {
  return [
    '你是對話標題產生器。以下是一場技術支援對話的開頭。',
    '請用繁體中文（台灣）產生一個標題，描述使用者想解決的問題。',
    '',
    `規則：不超過 ${MAX_LEN} 個字、不加標點符號、不加引號、不要寫「關於」或「詢問」這類贅詞。`,
    '只輸出標題本身，不要任何解釋或前後綴。',
    '',
    '=== 使用者 ===',
    String(userMessage || '').slice(0, EXCERPT_LEN),
    '',
    '=== AI 回覆 ===',
    String(aiReply || '').slice(0, EXCERPT_LEN),
  ].join('\n');
}

// 模型很愛回「標題：xxx」或整句包在引號裡，直接存進去側欄就會出現那些贅字。
// 換行只取第一行：多行輸出代表它多解釋了，第一行通常才是標題。
function sanitize(raw) {
  const first = String(raw || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const cleaned = first
    .replace(/^(標題|title)\s*[:：]\s*/i, '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .trim();
  return cleaned.slice(0, MAX_LEN);
}

// 對話第一次有了 AI 回覆之後才叫得動——標題要描述「問題是什麼」，
// 光有使用者那則常常只是一張截圖或一句「幫我看一下」。
//
// 絕對不可以讓這件事弄壞對話：任何一步失敗都吞掉、回 null，標題就維持預設值。
// 呼叫端不必包 try/catch。
async function maybeGenerateTitle(chatId, userMessage, aiReply, userId) {
  try {
    const { rows: [chat] } = await query(
      'SELECT title FROM project_chats WHERE id = $1', [chatId]
    );
    if (!chat || chat.title !== DEFAULT_TITLE) return null;
    if (!String(aiReply || '').trim()) return null;

    const result = await runClaude(buildPrompt(userMessage, aiReply), {
      userId, agentType: 'chat-title', timeoutMs: TIMEOUT_MS,
    });
    await logTokenUsage(null, userId, 'chat-title', result.usage, result.durationMs).catch(() => {});

    const title = sanitize(result.text);
    if (!title) return null;

    // 條件式 UPDATE：產標題要花幾秒，這期間使用者可能已經自己重新命名了。
    // 無條件寫入會把他剛打的名字蓋掉，而且他不會知道發生過什麼事。
    const { rowCount } = await query(
      'UPDATE project_chats SET title = $1 WHERE id = $2 AND title = $3',
      [title, chatId, DEFAULT_TITLE]
    );
    return rowCount ? title : null;
  } catch (err) {
    console.error('[CHAT-TITLE] 自動命名失敗（對話不受影響）:', err.message);
    return null;
  }
}

module.exports = { maybeGenerateTitle, sanitize, DEFAULT_TITLE, MAX_LEN };
