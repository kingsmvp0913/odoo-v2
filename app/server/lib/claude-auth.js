/**
 * claude-auth.js — pipeline 子行程的 Claude 認證憑證（管理員在網頁設定）
 *
 * 背景：每關以 headless `claude -p` spawn，共用同一份會過期、會被刷新改寫的互動式 OAuth
 * 憑證檔；併發 spawn 在 token 輪替瞬間互相踩空 → "Not logged in"（見 pipeline/auth-signature.js）。
 * 改由管理員貼一把 `claude setup-token` 的長效 token（綁訂閱、效期一年），加密存
 * teams_settings.claude_oauth_token_enc，解密後逐行程以 CLAUDE_CODE_OAUTH_TOKEN 注入。
 *
 * 備用憑證：主帳號用量撞閘門時，整條 pipeline 原本會停下等視窗重置。管理員可再貼一把
 * 「另一份訂閱」的 token（claude_oauth_token_backup_enc），由 pipeline/usage-gate 判斷後
 * 呼叫 setActiveCredential('backup') 切過去，主帳號用量降回門檻下再切回。本模組只認旗標
 * 交出對應 token，不自己判斷用量。
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
let _backupToken = null;
let _active = 'primary';

// 單欄解密：APP_SECRET 換過／密文損壞時當成未設定，不得往外拋（啟動載入炸開會讓整台 server 起不來）
function _decryptOrNull(blob, label) {
  if (!blob) return null;
  try {
    return decrypt(blob);
  } catch (err) {
    console.warn(`[CLAUDE-AUTH] ${label}憑證解密失敗，視為未設定：`, err.message);
    return null;
  }
}

async function loadClaudeToken() {
  try {
    const { rows } = await query(
      'SELECT claude_oauth_token_enc, claude_oauth_token_backup_enc FROM teams_settings WHERE id = 1'
    );
    _token = _decryptOrNull(rows[0]?.claude_oauth_token_enc, '主');
    _backupToken = _decryptOrNull(rows[0]?.claude_oauth_token_backup_enc, '備用');
  } catch (err) {
    // DB 查不到／欄位還沒 migrate：退回原本的憑證檔行為即可
    console.warn('[CLAUDE-AUTH] 讀取憑證失敗，改用本機憑證檔：', err.message);
    _token = null;
    _backupToken = null;
  }
}

// 同步：無設定時回空物件，讓呼叫端的 { ...process.env } 原樣通過
//（回 { CLAUDE_CODE_OAUTH_TOKEN: '' } 會反而蓋掉手動設定的環境變數）
// 切到 backup 但備用憑證不存在時退回主憑證：此時交出空物件等於讓所有子行程失去認證，
// 比「繼續用已超標的主憑證」嚴重得多（前者必然全掛，後者只是撞限額）。
function getClaudeAuthEnv() {
  const tok = (_active === 'backup' && _backupToken) ? _backupToken : _token;
  return tok ? { CLAUDE_CODE_OAUTH_TOKEN: tok } : {};
}

// 用量量測要拿「指定的那一把」去打 usage API，而不是永遠打本機憑證檔
function getTokenFor(which) {
  return (which === 'backup' ? _backupToken : _token) || null;
}

function hasBackupToken() { return !!_backupToken; }

function getActiveCredential() { return _active; }

// 由 pipeline/usage-gate 在每次評估後呼叫；認不得的值一律當主憑證，不讓拼錯字靜默切走憑證
function setActiveCredential(which) {
  _active = which === 'backup' ? 'backup' : 'primary';
  return _active;
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

function _setForTesting(token, backupToken = null, active = 'primary') {
  _token = token;
  _backupToken = backupToken;
  _active = active;
}

module.exports = {
  loadClaudeToken, getClaudeAuthEnv, getTokenFor, hasBackupToken,
  getActiveCredential, setActiveCredential, resetClaudeTokenCache,
  shadowingEnvVar, _setForTesting
};
