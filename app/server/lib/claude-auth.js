/**
 * claude-auth.js — pipeline 子行程的 Claude 認證憑證（全平台一把，管理員在網頁設定）
 *
 * 背景：每關以 headless `claude -p` spawn，共用同一份會過期、會被刷新改寫的互動式 OAuth
 * 憑證檔；併發 spawn 在 token 輪替瞬間互相踩空 → "Not logged in"（見 pipeline/auth-signature.js）。
 * 改由管理員貼一把 `claude setup-token` 的長效 token（綁訂閱、效期一年），加密存
 * teams_settings.claude_oauth_token_enc，解密後逐行程以 CLAUDE_CODE_OAUTH_TOKEN 注入。
 *
 * 讀取端刻意是同步的：runClaude 若改成 async 再 await 查 DB，spawn 會晚一個 microtask，
 * 而既有測試多是「呼叫後同步對 mock child 發事件」，會整片失效。故非同步只發生在
 * 啟動載入（index.js）與管理員存檔（resetClaudeTokenCache）。
 *
 * 本模組不得把 token 寫進任何 log。
 */
const { query } = require('../db');
const { decrypt } = require('./crypto');

let _token = null;

async function loadClaudeToken() {
  try {
    const { rows } = await query('SELECT claude_oauth_token_enc FROM teams_settings WHERE id = 1');
    const blob = rows[0]?.claude_oauth_token_enc;
    _token = blob ? decrypt(blob) : null;
  } catch (err) {
    // APP_SECRET 換過／密文損壞／DB 查不到：退回原本的憑證檔行為即可，
    // 絕不能 throw——啟動載入若炸開會讓整台 server 起不來
    console.warn('[CLAUDE-AUTH] 讀取憑證失敗，改用本機憑證檔：', err.message);
    _token = null;
  }
}

// 同步：無設定時回空物件，讓呼叫端的 { ...process.env } 原樣通過
//（回 { CLAUDE_CODE_OAUTH_TOKEN: '' } 會反而蓋掉手動設定的環境變數）
function getClaudeAuthEnv() {
  return _token ? { CLAUDE_CODE_OAUTH_TOKEN: _token } : {};
}

async function resetClaudeTokenCache() {
  await loadClaudeToken();
}

// 官方認證優先序：ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN。
// 環境有前兩者時本設定會被靜默忽略，回傳變數名供介面警告。
function shadowingEnvVar() {
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (process.env[name]) return name;
  }
  return null;
}

function _setForTesting(token) { _token = token; }

module.exports = { loadClaudeToken, getClaudeAuthEnv, resetClaudeTokenCache, shadowingEnvVar, _setForTesting };
