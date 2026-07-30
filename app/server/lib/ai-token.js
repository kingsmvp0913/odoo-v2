/**
 * ai-token.js — `/ai/*` 端點的第二道門
 *
 * 為什麼需要：第一道門是「來源 IP 是不是 loopback」，它擋得住**取決於 nginx 住在哪個網路
 * 命名空間**——那是機房拓樸，不是程式碼保證得了的東西。現行正式機的 nginx 是另一個 bridge
 * 網路上的容器，所以反代進來的請求來源是 172.17.0.1 之類，會被擋。但只要有人把 nginx 搬上
 * 宿主機、改成 network_mode: host、或加一層 socat/port-forward（都是會被當成純設定變更的調整），
 * 反代進來的請求就全部變成 127.0.0.1，四個 /ai/* 端點同時對全網開放——而**程式碼一個字都不用改、
 * 沒有任何測試會紅、log 也看不出來**。其中 POST /ai/db/query 不驗 token、不綁專案（專案 id 是從
 * 連線自己反查出來的），破了就是所有客戶正式資料庫任意讀取，且不留可歸屬的稽核軌跡。
 *
 * 兩道門必須是 AND：它們的失效原因不同（拓樸變更 vs 通行碼外流），一次調整不可能同時弄壞兩者。
 *
 * 為什麼從 APP_SECRET 推導，而不是啟動時隨機產生：隨機的話 server 一重啟，正在飛的 agent 手上
 * 那份就作廢，症狀是「pipeline 跑到一半突然查不到資料庫」——完全不指向認證。推導出來的值跨重啟穩定。
 * 用 HMAC 而非直接拿 APP_SECRET 當通行碼：APP_SECRET 同時是所有 *_enc 欄位的加密金鑰，
 * 通行碼外洩時不可以連帶把它賠掉。
 */
const crypto = require('crypto');

const AI_TOKEN_HEADER = 'x-aidev-ai-token';

// 推導用的固定標籤：日後若要換金鑰世代，改這裡即可（舊碼自然失效）。
const TOKEN_LABEL = 'aidev:ai-endpoints:v1';

let _cache = null;

// 目前的通行碼；APP_SECRET 未設定時回 null（＝無法驗章，呼叫端一律擋）。
// 依 APP_SECRET 快取：測試會在執行期換 secret，用它當快取鍵才不會拿到過期值。
function aiToken() {
  const secret = process.env.APP_SECRET;
  if (!secret) return null;
  if (_cache && _cache.secret === secret) return _cache.token;
  const token = crypto.createHmac('sha256', secret).update(TOKEN_LABEL).digest('hex');
  _cache = { secret, token };
  return token;
}

// 供 claude-runner 注入子行程用（APP_SECRET 未設就不放這個 key，語意是「沒有碼」而非空字串碼）。
function aiTokenEnv() {
  const token = aiToken();
  return token ? { AIDEV_AI_TOKEN: token } : {};
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // 長度不同時 timingSafeEqual 會 throw；先比長度（長度本身不是秘密）。
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// /ai/* 的完整守衛：本機來源 **且** 帶對通行碼。
function aiEndpointGuard(req, res, next) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ ok: false, error: 'AI endpoint 僅限本機' });
  }
  const expected = aiToken();
  if (!expected) {
    // fail closed。APP_SECRET 沒設時平台本來就無法加解密憑證，這裡跟著擋才一致。
    return res.status(403).json({ ok: false, error: 'AI endpoint 通行碼未設定（APP_SECRET 未設），請檢查啟動設定' });
  }
  const got = (req.headers && req.headers[AI_TOKEN_HEADER]) || '';
  if (!timingSafeEqualStr(got, expected)) {
    // 訊息要指得出真因：這個修法最可能的故障是「agent 沒帶碼」，而症狀會是「AI 突然查不到資料庫」，
    // 看起來完全不像認證問題。說不清楚就會被查成別的東西。
    return res.status(403).json({
      ok: false,
      error: `AI endpoint 通行碼不正確或未帶（header ${AI_TOKEN_HEADER}）——agent 是否在 server 重啟前就派工了？重新派工即可`,
    });
  }
  return next();
}

module.exports = { aiToken, aiTokenEnv, AI_TOKEN_HEADER, aiEndpointGuard };
