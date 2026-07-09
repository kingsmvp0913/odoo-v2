const fs = require('fs');
const path = require('path');

// 相對於專案目錄；UPLOAD_DIR 環境變數可覆寫（不寫死絕對路徑）
function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
}

function taskDir(taskId) {
  const dir = path.join(uploadRoot(), `task_${taskId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 存檔，回傳「相對於 uploadRoot() 的相對路徑」——DB 只存這個相對路徑
function saveAttachmentFile(taskId, filename, buffer) {
  const safeName = `${Date.now()}_${String(filename).replace(/\.\./g, '_').replace(/[^\w.\-]/g, '_')}`;
  fs.writeFileSync(path.join(taskDir(taskId), safeName), buffer);
  return path.join(`task_${taskId}`, safeName);
}

function readAttachmentFile(relativePath) {
  return fs.readFileSync(path.join(uploadRoot(), relativePath));
}

module.exports = { uploadRoot, taskDir, saveAttachmentFile, readAttachmentFile };
