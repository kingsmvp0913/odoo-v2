const fs = require('fs');
const path = require('path');

// 相對於專案目錄；UPLOAD_DIR 環境變數可覆寫（不寫死絕對路徑）
function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
}

function taskDir(taskId) {
  const safeId = String(taskId).replace(/\.\./g, '_').replace(/[^\w.\-]/g, '_');
  const dir = path.join(uploadRoot(), `task_${safeId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 存檔，回傳「相對於 uploadRoot() 的相對路徑」——DB 只存這個相對路徑
function saveAttachmentFile(taskId, filename, buffer) {
  const safeId = String(taskId).replace(/\.\./g, '_').replace(/[^\w.\-]/g, '_');
  const safeName = `${Date.now()}_${String(filename).replace(/\.\./g, '_').replace(/[^\w.\-]/g, '_')}`;
  fs.writeFileSync(path.join(taskDir(taskId), safeName), buffer);
  return path.join(`task_${safeId}`, safeName);
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

module.exports = { uploadRoot, taskDir, saveAttachmentFile, readAttachmentFile, sniffFile, attachmentSize };
