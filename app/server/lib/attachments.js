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
  return { ext: '', mime: 'application/octet-stream' };
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

// 對話只收圖片。fileFilter 擋的是「宣告的」mimetype，可被偽造，所以真正的把關在呼叫端：
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

// magic bytes 判定是否為圖片（sniffFile 認不出會回 application/octet-stream）
function isImageBuffer(buf) {
  return /^image\//.test(sniffFile(buf).mime);
}

module.exports = { uploadRoot, taskDir, saveAttachmentFile, saveChatAttachmentFile, deleteTaskDir, deleteChatDir, saveFeedbackAttachmentFile, deleteFeedbackDir, deleteAttachmentFile, readAttachmentFile, sniffFile, attachmentSize, uploadAttachmentFiles, uploadChatImages, isImageBuffer };
