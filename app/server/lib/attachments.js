const fs = require('fs');
const path = require('path');
const multer = require('multer');

// 相對於專案目錄；UPLOAD_DIR 環境變數可覆寫（不寫死絕對路徑）
function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
}

function safeSeg(x) {
  return String(x).replace(/\.\./g, '_').replace(/[^\w.\-]/g, '_');
}

// 上傳目錄以「擁有者種類_id」分艙：task_<id>（任務附件）與 chat_<id>（對話圖片）。
// 抽成參數而非各寫一份，是因為底下三個 function 的路徑組法必須逐字相同——一邊改了另一邊沒改，
// 會變成「存得進去但刪不掉」的孤兒檔，而那完全沒有訊號。
function scopedDir(scope, ownerId) {
  const dir = path.join(uploadRoot(), `${scope}_${safeSeg(ownerId)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveScopedFile(scope, ownerId, filename, buffer) {
  const safeName = `${Date.now()}_${safeSeg(filename)}`;
  fs.writeFileSync(path.join(scopedDir(scope, ownerId), safeName), buffer);
  return path.join(`${scope}_${safeSeg(ownerId)}`, safeName);
}

function deleteScopedDir(scope, ownerId) {
  const dir = path.join(uploadRoot(), `${scope}_${safeSeg(ownerId)}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 已不存在／權限：忽略 */ }
}

function taskDir(taskId) { return scopedDir('task', taskId); }

// 存檔，回傳「相對於 uploadRoot() 的相對路徑」——DB 只存這個相對路徑
function saveAttachmentFile(taskId, filename, buffer) {
  return saveScopedFile('task', taskId, filename, buffer);
}

// 對話圖片：落在 chat_<chatId>/，DB 存相對路徑（同 task 附件）
function saveChatAttachmentFile(chatId, filename, buffer) {
  return saveScopedFile('chat', chatId, filename, buffer);
}

// 刪任務時連帶清掉整個 task_<id> 上傳目錄——過去只刪 DB 的 task_attachments 列，磁碟實體檔變孤兒永不回收。
// best-effort：目錄不存在或刪除失敗都不擋刪任務流程。
function deleteTaskDir(taskId) { deleteScopedDir('task', taskId); }

// 刪對話時同理：project_chat_attachments 靠 ON DELETE CASCADE 自己清掉，實體檔沒人管。
function deleteChatDir(chatId) { deleteScopedDir('chat', chatId); }

// 意見回饋的圖片：落在 feedback_<id>/，DB 存相對路徑（同 task／chat）。
// 走同一支 saveScopedFile 是刻意的——三處的路徑組法必須逐字相同，各寫一份會漂移成
// 「存得進去但刪不掉」的孤兒檔，而那完全沒有訊號。
function saveFeedbackAttachmentFile(feedbackId, filename, buffer) {
  return saveScopedFile('feedback', feedbackId, filename, buffer);
}

// feedback_attachments 靠 ON DELETE CASCADE 自己清掉，實體檔沒人管，所以刪意見時要連目錄收掉
function deleteFeedbackDir(feedbackId) { deleteScopedDir('feedback', feedbackId); }

// 刪單一附件實體檔（相對 uploadRoot），best-effort。用於汰換舊版壞檔列時連磁碟一起收，避免留孤兒檔。
function deleteAttachmentFile(relativePath) {
  try {
    const root = path.resolve(uploadRoot());
    const resolved = path.resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return;
    fs.rmSync(resolved, { force: true });
  } catch { /* 不存在／權限：忽略 */ }
}

function readAttachmentFile(relativePath) {
  const root = path.resolve(uploadRoot());
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Invalid attachment path');
  }
  return fs.readFileSync(resolved);
}

// 附件實際位元組大小（best-effort，讀不到回 0）；供列表頁標大小、對 0-byte 空檔做前端防呆
function attachmentSize(relativePath) {
  try {
    const root = path.resolve(uploadRoot());
    const resolved = path.resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return 0;
    return fs.statSync(resolved).size;
  } catch { return 0; }
}

// 依 magic bytes 嗅測檔型，回 { ext, mime }。eService 主附件只有 binary 沒檔名，靠這補副檔名／mimetype，
// 否則存成無副檔名檔＋octet-stream 會「下載後打不開」。認不出回 { ext:'', mime:'application/octet-stream' }。
function sniffFile(buf) {
  if (!buf || buf.length < 4) return { ext: '', mime: 'application/octet-stream' };
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: '.png', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (b.toString('ascii', 0, 4) === 'GIF8') return { ext: '.gif', mime: 'image/gif' };
  if (b.toString('ascii', 0, 4) === '%PDF') return { ext: '.pdf', mime: 'application/pdf' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  // ZIP 檔頭（PK\x03\x04 等）：Office OpenXML（xlsx/docx/pptx）本質是 zip，掃前段區塊分辨，認不出當一般 zip
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    const head = b.toString('latin1', 0, Math.min(b.length, 4000));
    if (head.includes('xl/')) return { ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (head.includes('word/')) return { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    if (head.includes('ppt/')) return { ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    return { ext: '.zip', mime: 'application/zip' };
  }
  // OLE2 複合文件：Office 97-2003 的 .xls／.doc 檔頭一模一樣，只能靠內部 stream 名稱分辨，
  // 而那些名稱在 CFB 目錄裡是 UTF-16LE。客戶從舊 ERP 匯出的還是大量 .xls，認不出來就只能當
  // octet-stream 擋掉，使用者看到的會是「格式不支援」而不知道為什麼。
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1) {
    const u16 = (s) => Buffer.from(s, 'utf16le');
    if (b.indexOf(u16('WordDocument')) !== -1) return { ext: '.doc', mime: 'application/msword' };
    // 'Workbook'（Excel 8+）與 'Book'（Excel 5/95）兩種名稱都要認
    if (b.indexOf(u16('Workbook')) !== -1 || b.indexOf(u16('Book')) !== -1) return { ext: '.xls', mime: 'application/vnd.ms-excel' };
    return { ext: '', mime: 'application/octet-stream' };
  }
  return { ext: '', mime: 'application/octet-stream' };
}

// ── 對話附件可收的檔型 ────────────────────────────────────────────────────────
// 單一真相在這裡；前端那份在 public/js/chat-file-types.js，由 chat-file-types.test.js 比對兩份一致。
// 漂移的症狀很難查：檔案選得到、送出被後端打回，而畫面上只有一句泛用錯誤。

// 純文字類完全沒有 magic bytes，只能靠副檔名認。安全性不靠這份判定——非圖片一律不 inline
// 顯示（見 chat-routes 的下載端點），所以最壞情況只是存進一個名不副實的文字檔。
const CHAT_TEXT_MIMES = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.po': 'text/x-gettext-translation'
};

// magic bytes 認得出來、圖片以外要放行的（比對的是 sniffFile 回的 ext，不是使用者的檔名）
const CHAT_BINARY_EXTS = ['.pdf', '.xlsx', '.docx', '.pptx', '.xls', '.doc'];

// 給 <input accept> 與 multer fileFilter 用的副檔名清單。含 .xlsm（巨集活頁簿）——它的 magic bytes
// 與 .xlsx 相同、sniff 出來就是 .xlsx，所以 CHAT_BINARY_EXTS 不必列，但檔案選擇器不列的話使用者
// 根本挑不到那個檔。
const CHAT_ACCEPT_EXTS = [...CHAT_BINARY_EXTS, '.xlsm', ...Object.keys(CHAT_TEXT_MIMES)];
const CHAT_ACCEPT = ['image/*', ...CHAT_ACCEPT_EXTS].join(',');

// Excel 匯出動輒破 10MB，維持原上限等於「加了格式但常用的那些還是傳不上來」。
const CHAT_FILE_MAX = 25 * 1024 * 1024;

// 「這是不是純文字」。刻意不驗編碼：台灣客戶從舊 ERP 匯出的 CSV 常是 Big5，
// 用嚴格 UTF-8 解碼驗會把它們全部擋掉，而錯誤訊息只會說「格式不支援」。
function isTextBuffer(buf) {
  if (!buf || !buf.length) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let ctrl = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ctrl++;
  }
  return ctrl / sample.length < 0.05;
}

// 對話附件的把關：回 { ext, mime } 代表放行，回 null 代表不收。
// client 宣告的 mimetype 一概不信——二進位類驗 magic bytes；純文字類沒有 magic bytes 可驗，
// 改成「內容確實是文字」＋副檔名決定 mime。
function resolveChatFile(buf, filename) {
  const sniffed = sniffFile(buf);
  if (/^image\//.test(sniffed.mime) || CHAT_BINARY_EXTS.includes(sniffed.ext)) return sniffed;
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (CHAT_TEXT_MIMES[ext] && isTextBuffer(buf)) return { ext, mime: CHAT_TEXT_MIMES[ext] };
  return null;
}

// 附件上傳 middleware：memoryStorage 讓呼叫端自己決定何時落地——附件必須早於 runPipeline 寫入，
// 否則該輪 agent 讀不到（assembleTaskContext 是在 agent 起跑時才查 task_attachments）。
// 放這裡是為了單一來源：新增任務（tasks-routes）與人工退回（pipeline-routes）共用同一組限制，
// 各持一份 multer 設定會漂移成「有的入口能傳、有的不能」且完全無訊號。
// 純 JSON 呼叫仍相容：multer 遇非 multipart 直接放行、req.files 為空。
// defParamCharset：busboy 預設用 latin1 解 multipart header 裡的 filename，中文檔名會存成
// 「2026-08-18 16_47_18-æªå…」這種 mojibake（task 150 的主附件即是）。檔案內容不受影響，
// 但清單／下載檔名全是亂碼。既有壞檔名不會被回溯修正，只影響顯示。
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  defParamCharset: 'utf8'
});
function uploadAttachmentFiles(req, res, next) {
  attachmentUpload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// 意見回饋只收圖片。fileFilter 擋的是「宣告的」mimetype，可被偽造，所以真正的把關在呼叫端：
// 落地前一律用 sniffFile 驗 magic bytes，並以嗅測結果當存進 DB 的 mimetype——client 送什麼一概不信。
// fileFilter 仍留著，作用是別為了一個 10MB 的影片先把它整包吃進記憶體才發現不能用。
const chatImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => {
    if (!/^image\//i.test(file.mimetype || '')) return cb(new Error('只能上傳圖片檔'));
    cb(null, true);
  }
});
function uploadChatImages(req, res, next) {
  chatImageUpload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// 對話收圖片＋辦公室／ERP 常見文件。同上：這一層只是別把不能用的檔整包吃進記憶體，
// 真正的把關是呼叫端的 resolveChatFile（驗 magic bytes／文字內容）。
// 這裡刻意連副檔名一起認：純文字類的 mimetype 瀏覽器各報各的（.log 常報成空字串），
// 只看 mimetype 會把使用者挑得到的檔在送出時擋掉。
const chatFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_FILE_MAX, files: 5 },
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (/^image\//i.test(file.mimetype || '') || CHAT_ACCEPT_EXTS.includes(ext)) return cb(null, true);
    cb(new Error(`「${file.originalname}」不是支援的檔案格式`));
  }
});
function uploadChatFiles(req, res, next) {
  chatFileUpload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// magic bytes 判定是否為圖片（sniffFile 認不出會回 application/octet-stream）
function isImageBuffer(buf) {
  return /^image\//.test(sniffFile(buf).mime);
}

module.exports = { uploadRoot, safeSeg, taskDir, saveAttachmentFile, saveChatAttachmentFile, deleteTaskDir, deleteChatDir, saveFeedbackAttachmentFile, deleteFeedbackDir, deleteAttachmentFile, readAttachmentFile, sniffFile, attachmentSize, uploadAttachmentFiles, uploadChatImages, uploadChatFiles, isImageBuffer, isTextBuffer, resolveChatFile, CHAT_TEXT_MIMES, CHAT_BINARY_EXTS, CHAT_ACCEPT_EXTS, CHAT_ACCEPT, CHAT_FILE_MAX };
