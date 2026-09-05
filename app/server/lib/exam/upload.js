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

// 給畫面用：連「過期了」也要看得到，才講得出「請重新產生」而不是「尚未設定」。
function peekUploadToken(dataDir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(tokenPath(dataDir), 'utf8')); } catch { return null; }
  const token = String(raw && raw.token || '').trim();
  const expiresAt = Number(raw && raw.expires_at) || 0;
  if (!token || !expiresAt) return null;
  return { token, expiresAt, expired: Date.now() >= expiresAt };
}

// 認證用：過期的一律當作沒有。
function readUploadToken(dataDir) {
  const t = peekUploadToken(dataDir);
  return t && !t.expired ? t.token : null;
}

// 重產＝舊的立刻失效（只留一把有效的鑰匙）。
function issueUploadToken(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'exam'), { recursive: true });
  const token = crypto.randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + tokenTtlMs();
  fs.writeFileSync(tokenPath(dataDir), JSON.stringify({ token, expires_at: expiresAt }, null, 2));
  return { token, expiresAt };
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
  isLocal, saveImage, validateItem,
};
