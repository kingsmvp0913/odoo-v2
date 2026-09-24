// 上傳截圖的驗證與落檔。純邏輯與檔案操作分開，讓判斷部分測得動。
//
// 這支的每一條檢查都對應原專案實測踩過的坑，不是防禦性編程的裝飾。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sniffFile, isImageBuffer } = require('../attachments');

// 圖片一律用檔頭（magic bytes）認格式，**不信 data URI 宣告的型別也不信長度**。
//
// 為什麼：`Buffer.from(s, 'base64')` 對非法字元不拋錯、默默跳過，一段中文字串
// 也能「解碼成功」變成幾個 bytes 的垃圾。只檢查長度的話那題會被收下、排進佇列、
// 燒一次 token，最後才由 claude 回一個讀不出來的空答案——錯誤在離真因最遠的
// 地方才浮現（原專案實測踩過）。
//
// 判定本身借用平台既有的 `attachments.js`（聊天圖片上傳已經在用同一套），
// 不自己再寫一份 magic bytes 表——兩份遲早會分岔，而分岔的症狀是「同一張圖
// 在聊天可以傳、在題庫被拒收」，沒人會想到去比對兩張表。
// 回不帶點的副檔名（'jpg'）。sniffFile 回的是 '.jpg'，直接拿去組檔名會變成
// `xxx..jpg`——這種錯不會報，只是檔名醜且日後用副檔名比對時對不上。
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || !isImageBuffer(buf)) return null;
  const { ext } = sniffFile(buf);
  return ext ? ext.replace(/^\./, '') : null;
}

// base64 或 data URI 都吃。解不出合法圖片一律回 null，不要讓呼叫端自己判斷。
function decodeImage(input) {
  if (Buffer.isBuffer(input)) return sniffImage(input) ? input : null;
  if (typeof input !== 'string' || !input.trim()) return null;
  const b64 = input.includes(',') && input.trim().startsWith('data:')
    ? input.slice(input.indexOf(',') + 1)
    : input;
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  return sniffImage(buf) ? buf : null;
}

// 上傳通行碼：給同事用的，與平台帳號無關——為了傳一張圖去開平台帳號沒道理。
// 存在檔案裡（被 gitignore），不進版控也不進 DB。
//
// **有效期 3 小時**：這組碼會被貼進 Line 群、寫進同事的腳本，一旦外流就是
// 整個網段都能往平台塞圖。考試當天用完即失效，比「永久有效但記得刪」可靠。
// 舊的純文字 `upload-token.txt` 不再認：那是手動放的、永不過期，正是要換掉的東西。
const TOKEN_FILE = 'upload-token.json';
const tokenTtlMs = () => parseInt(process.env.EXAM_TOKEN_TTL_MS || String(3 * 60 * 60 * 1000), 10);
const tokenPath = dataDir => path.join(dataDir, 'exam', TOKEN_FILE);

// **一家公司一把**（規格 2026-09-24-exam-tenant-scope-design.md §3.5）。
//
// 原本是全平台一把。客戶開始用考試之後，那等於雙方互相把對方的碼作廢——而症狀是
// 「我的通行碼昨天還能用」，log 上看不出任何異常。桶子名：內部是 'internal'，
// 客戶是 company-<id>。名字在組鍵之前先過白名單，免得日後有人把別的來源接進來。
const INTERNAL_BUCKET = 'internal';
const BUCKET_RE = /^(internal|company-[1-9]\d*)$/;

// 這個人的碼放在哪一桶。回 null＝算不出來（不是內部、又沒有公司），呼叫端要當錯誤處理，
// **不可以退到 internal**——那會把內部那把碼交到客戶手上。
function tokenBucketFor(actor) {
  if (!actor) return null;
  if (actor.isPlatformAdmin === true || actor.isInternal === true) return INTERNAL_BUCKET;
  return Number.isInteger(actor.companyId) ? `company-${actor.companyId}` : null;
}

function tokenEntry(v) {
  const token = String((v && v.token) || '').trim();
  const expiresAt = Number(v && v.expires_at) || 0;
  if (!token || !expiresAt) return null;
  const issuedBy = Number.isInteger(v && v.issued_by) ? v.issued_by : null;
  return { token, expiresAt, issuedBy, expired: Date.now() >= expiresAt };
}

// 全部的桶子。讀不到、壞掉、格式不認得一律回 {}（＝尚未產生），不往外拋。
function allUploadTokens(dataDir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(tokenPath(dataDir), 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  // 相容 2026-09-24 之前的單一物件格式（全平台一把）：當成內部那一桶。
  // 舊碼效期只有 3 小時，升級後很快就會被重產取代，所以不做資料搬移。
  if (typeof raw.token === 'string') {
    const e = tokenEntry(raw);
    return e ? { [INTERNAL_BUCKET]: e } : {};
  }
  const buckets = (raw.buckets && typeof raw.buckets === 'object') ? raw.buckets : {};
  const out = {};
  for (const [k, v] of Object.entries(buckets)) {
    if (!BUCKET_RE.test(k)) continue;
    const e = tokenEntry(v);
    if (e) out[k] = e;
  }
  return out;
}

// 給畫面用：連「過期了」也要看得到，才講得出「請重新產生」而不是「尚未設定」。
function peekUploadToken(dataDir, bucket = INTERNAL_BUCKET) {
  if (!bucket) return null;
  return allUploadTokens(dataDir)[bucket] || null;
}

// 認證用：拿到一串碼，問它是誰的。回中的那一桶（含 issuedBy 與 expired）。
// 掃全部桶子而不是只比對「呼叫者那一桶」——呼叫者帶碼進來時還不知道他是誰，
// 那正是這支要回答的問題。
function findUploadToken(dataDir, token) {
  const got = String(token || '').trim();
  if (!got) return null;
  for (const [bucket, e] of Object.entries(allUploadTokens(dataDir))) {
    if (e.token === got) return { bucket, ...e };
  }
  return null;
}

// 認證用的舊介面：過期的一律當作沒有。
function readUploadToken(dataDir, bucket = INTERNAL_BUCKET) {
  const t = peekUploadToken(dataDir, bucket);
  return t && !t.expired ? t.token : null;
}

// 重產＝**只有那一桶**的舊碼立刻失效，別家不受影響。
function issueUploadToken(dataDir, issuedBy = null, bucket = INTERNAL_BUCKET) {
  if (!BUCKET_RE.test(String(bucket))) throw new Error(`通行碼桶子名稱不合法：${bucket}`);
  fs.mkdirSync(path.join(dataDir, 'exam'), { recursive: true });
  const token = crypto.randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + tokenTtlMs();
  const issued = Number.isInteger(issuedBy) ? issuedBy : null;
  // 讀回既有的桶子再合併：整份覆蓋會把別家的碼一起殺掉，而那正是本次要修的問題。
  const existing = allUploadTokens(dataDir);
  const buckets = {};
  for (const [k, e] of Object.entries(existing)) {
    buckets[k] = { token: e.token, expires_at: e.expiresAt, issued_by: e.issuedBy };
  }
  buckets[bucket] = { token, expires_at: expiresAt, issued_by: issued };
  fs.writeFileSync(tokenPath(dataDir), JSON.stringify({ buckets }, null, 2));
  return { token, expiresAt, issuedBy: issued, bucket };
}

// **判斷一律用 req.socket.remoteAddress，絕不可改成看 header／query／body 裡的東西。**
// 那些同網段誰都偽造得出來，等於把免驗證後門開放給整個網段（原專案的硬規則）。
function isLocal(req) {
  const a = req && req.socket && req.socket.remoteAddress;
  if (!a) return false;
  const ip = String(a).replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

// 落檔。檔名帶時間戳與亂數，避免同一頁重傳互相蓋掉。
// 回傳**相對 uploadRoot 的路徑**——DB 不存絕對路徑（專案硬規則）。
function saveImage({ uploadRoot, bankId, buf, ext }) {
  const dir = path.join(uploadRoot, `exam_${bankId}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return path.join(`exam_${bankId}`, name);
}

// 一批裡單筆壞掉不讓整批失敗：好的收下，壞的具名回報。
// 同事一次丟 20 題，不該因為第 13 題漏填答案就得整批重送、重燒一次 token。
function validateItem(it, index) {
  if (!it || typeof it !== 'object') return { index, reason: '不是物件' };
  const page = String(it.page ?? '').trim();
  if (!page) return { index, reason: '缺少 page' };
  if (!String(it.answer ?? '').trim()) return { index, page, reason: '缺少 answer' };
  const buf = decodeImage(it.image);
  if (!buf) return { index, page, reason: '圖片解不出來（檔頭不是已知的圖片格式）' };
  return null;
}

module.exports = {
  sniffImage, decodeImage, readUploadToken, peekUploadToken, issueUploadToken,
  allUploadTokens, findUploadToken, tokenBucketFor, INTERNAL_BUCKET,
  isLocal, saveImage, validateItem,
};
