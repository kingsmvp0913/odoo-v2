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

class NoAnthropicKeyError extends Error {
  constructor(msg) { super(msg); this.code = 'NO_ANTHROPIC_KEY'; }
}

/**
 * buildClaudeAuthEnv(userId) — 這一次執行該用誰的 Anthropic 憑證（階段 3：客戶自帶 API key）。
 *
 * ⚠ **非同步只發生在這裡，不在讀取端**。檔頭寫明 getClaudeAuthEnv() 刻意同步——runClaude
 * 若改成 await 查 DB，spawn 會晚一個 microtask，而既有測試多是「呼叫後同步對 mock child
 * 發事件」，會整片失效。所以呼叫端先 await 這支拿到結果，再以參數傳進 runClaude。
 *
 * 形狀照抄 lib/git-identity.js 的 buildGitEnv()，但**優先序相反**：
 * GIT 是「個人優先、沒有才退公司」；這裡是「公司自己的 key 優先」——客戶自帶 key 的意思
 * 就是那筆錢算客戶的。
 *
 * ⚠ **客戶公司沒有 key 時必須丟例外，不可以退回平台那把共用訂閱。**
 * companies.is_internal 的欄位註解已經寫明：客戶公司被誤標成內部，就會用平台的訂閱跑客戶
 * 的 AI，違反 Anthropic 條款。靜默退回等於同一件事——而且更難發現，因為它不會報錯，
 * 只會在月底的帳單上出現。
 *
 * 回傳只含**一把**憑證：官方優先序是 ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY >
 * CLAUDE_CODE_OAUTH_TOKEN（見 shadowingEnvVar()），兩把都給的話實際生效的是哪一把
 * 要靠讀者記得這條優先序，那是留給未來的人踩的坑。
 */
async function buildClaudeAuthEnv(userId) {
  // 系統觸發（cron、夜間批次、系統自動 push）沒有發起人：用平台訂閱，且**不查 DB**——
  // 落點不受 DB 狀態影響，不可能因為查詢結果而飄到某家客戶的憑證上。
  if (userId === null || userId === undefined) return getClaudeAuthEnv();

  const { rows } = await query(
    `SELECT u.company_id, c.is_internal, c.anthropic_key_enc
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1`,
    [userId]
  );
  const r = rows[0];

  // 查不到人、或這個人沒有公司（平台管理員永遠沒有公司）→ 平台訂閱。
  if (!r || r.company_id === null || r.company_id === undefined) return getClaudeAuthEnv();
  // 內部公司＝廠商自己，本來就用平台訂閱（is_internal 欄位註解的原話）。
  if (r.is_internal === true) return getClaudeAuthEnv();

  // 以下是客戶公司。
  if (!r.anthropic_key_enc) {
    throw new NoAnthropicKeyError('這家公司還沒有設定 Anthropic API key，AI 無法執行。請公司管理員在設定頁填入。');
  }
  // 停用或到期的公司，它的憑證不可以再被拿來跑 AI（規格 §7）。HTTP 那側的全域閘門擋得住
  // 網頁操作，但 cron、夜間批次、系統觸發的執行不經過 HTTP——與 buildGitEnv 同一個理由。
  const { isUserCompanyUsable } = require('./tenant-access');
  if (!await isUserCompanyUsable(userId)) {
    throw new NoAnthropicKeyError('這家公司已停用或不在使用期間，不能再用它的憑證執行 AI。');
  }
  return { ANTHROPIC_API_KEY: decrypt(r.anthropic_key_enc) };
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
  loadClaudeToken, getClaudeAuthEnv, buildClaudeAuthEnv, NoAnthropicKeyError, getTokenFor, hasBackupToken,
  getActiveCredential, setActiveCredential, resetClaudeTokenCache,
  shadowingEnvVar, _setForTesting
};
