/**
 * auth-signature.js — 「claude CLI 認證失效」的字面特徵（單一真相）
 *
 * 背景：pipeline 每關都以 headless `claude -p` spawn，卻共用同一份會過期、會被刷新改寫的
 * 互動式 OAuth 憑證檔。並發 spawn 在 token 刷新／輪替瞬間互相踩空 → 讀到失效憑證 →
 * 印 "Not logged in"（走 stdout，stderr 空）→ exit 1，被吞成泛用「claude exited with code 1」。
 *
 * 兩處共用、必須同步，故抽成獨立模組（放任一端都會讓 claude-runner ↔ failure-classifier 成 require 迴圈）：
 *   claude-runner.js      掃 stdout/stderr，把泛用退出碼改歸因成可讀的認證失效並標 claudeStatus='auth'
 *   failure-classifier.js 歸 transient——實測重跑就過，交既有重試上限自癒，耗盡才丟人工
 */

// 只收「鐵板釘釘是認證」的字面；刻意不收 /credentials? invalid/、/unauthorized/ 等籠統詞——
// 那些在 Odoo／DB／git 失敗訊息裡也會出現，收了會把真正的 env 問題誤判成可重試。
const AUTH_FAIL = [
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /\bauthentication_error\b/i,
  /API Error:? 401\b/,
  /OAuth token (?:has )?expired/i,
  /401 Unauthorized/i,
  /Missing bearer or basic authentication/i,
];

function looksLikeAuthFailure(text) {
  const s = String(text == null ? '' : text);
  return AUTH_FAIL.some(re => re.test(s));
}

module.exports = { AUTH_FAIL, looksLikeAuthFailure };
