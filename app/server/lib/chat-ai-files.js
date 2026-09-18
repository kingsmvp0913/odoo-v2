// 對話 AI 產出的檔案（chatFiles skill）：AI 把檔放進出貨箱 chat_<id>/ai/outbox/，回覆寫進 DB 之後由這支收貨——
// 驗過的搬進 ai/msg_<訊息id>/ 並掛到那則回覆上，前端既有的附件按鈕就會自己畫出來。
// 搬走而不是原地掛：出貨箱若一路累積，AI 之後用同檔名覆蓋時，舊回覆的按鈕會靜默變成下載新檔。
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { uploadRoot, safeSeg, sniffFile, isTextBuffer, CHAT_FILE_MAX } = require('./attachments');

const AI_FILE_MAX_COUNT = 5;
// 二進位類靠 magic bytes 驗（sniffFile 對 JPEG 一律回 .jpg，.jpeg 在比對前先正規化）
const AI_BINARY_EXTS = ['.xlsx', '.docx', '.pdf', '.png', '.jpg'];
// 純文字類沒有 magic bytes，判準同上傳端：內容確實是文字＋副檔名決定 mime。
// 下載端點對非圖片一律 octet-stream，所以信副檔名不構成 inline 風險。
const AI_TEXT_MIMES = {
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.sql': 'text/plain',
  '.log': 'text/plain'
};

// 已收貨的 msg_*、已隔離的 _stale_* 都放這裡；容器裡這一層是唯讀的。
// root 可傳入：組容器掛載那端（lib/agent-mounts.js）的 uploadRoot 是可注入的，讓它沿用同一套路徑規則。
function chatAiDir(chatId, root = uploadRoot()) {
  return path.join(root, `chat_${safeSeg(chatId)}`, 'ai');
}

// 出貨箱自成一層：容器只把這一層掛成可寫（lib/agent-mounts.js），AI 碰不到上一層已交付的 msg_*，
// 舊回覆的下載按鈕不可能被它改掉或刪掉。
function chatAiOutbox(chatId, root = uploadRoot()) {
  return path.join(chatAiDir(chatId, root), 'outbox');
}

function pendingEntries(outbox) {
  if (!fs.existsSync(outbox)) return [];
  return fs.readdirSync(outbox, { withFileTypes: true });
}

// 本輪開始前呼叫：出貨箱有殘留＝上一輪行程在收貨前就死了。那些檔不屬於這一輪，
// 不隔離的話會被這輪的回覆誤收成自己的附件。回傳隔離的項目數。
function quarantineStaleOutbox(chatId) {
  const outbox = chatAiOutbox(chatId);
  const entries = pendingEntries(outbox);
  if (!entries.length) return 0;
  const dest = path.join(chatAiDir(chatId), `_stale_${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const d of entries) fs.renameSync(path.join(outbox, d.name), path.join(dest, d.name));
  return entries.length;
}

function resolveAiFileMime(buf, ext) {
  if (AI_BINARY_EXTS.includes(ext)) {
    const sniffed = sniffFile(buf);
    return sniffed.ext === ext ? sniffed.mime : null;
  }
  if (AI_TEXT_MIMES[ext] && isTextBuffer(buf)) return AI_TEXT_MIMES[ext];
  return null;
}

// 回傳 { attached, rejected }。rejected 由呼叫端寫進回覆——不合格的檔不可以安靜消失。
async function collectChatAiFiles(chatId, messageId) {
  const outbox = chatAiOutbox(chatId);
  const entries = pendingEntries(outbox).sort((a, b) => a.name.localeCompare(b.name));
  const attached = [];
  const rejected = [];
  let seq = 0;
  for (const d of entries) {
    const src = path.join(outbox, d.name);
    const reject = (reason) => {
      rejected.push({ filename: d.name, reason });
      // 原因已寫進回覆，留在出貨箱只會在下一輪開頭被當殘留隔離。
      // rmSync 對 symlink 刪的是連結本身，不會動到它指向的檔。
      fs.rmSync(src, { recursive: true, force: true });
    };
    try {
      // Dirent 不追 symlink：指向設定檔的連結在這裡就是「不是一般檔案」，內容不會被讀出來
      if (!d.isFile()) {
        reject(d.isDirectory() ? '是資料夾，檔案要直接放在出貨箱這一層' : '不是一般檔案（捷徑／連結不收）');
        continue;
      }
      if (attached.length >= AI_FILE_MAX_COUNT) { reject(`超過每輪 ${AI_FILE_MAX_COUNT} 個的上限`); continue; }
      if (fs.lstatSync(src).size > CHAT_FILE_MAX) { reject(`超過 ${CHAT_FILE_MAX / 1024 / 1024}MB 上限`); continue; }
      let ext = path.extname(d.name).toLowerCase();
      if (ext === '.jpeg') ext = '.jpg';
      const mime = resolveAiFileMime(fs.readFileSync(src), ext);
      if (!mime) { reject('內容與副檔名不符，或不是支援的格式'); continue; }

      const destDir = path.join(chatAiDir(chatId), `msg_${safeSeg(messageId)}`);
      fs.mkdirSync(destDir, { recursive: true });
      // 磁碟檔名只求唯一與安全：safeSeg 會把中文換成底線，「報表.csv」「銷售.csv」會撞成同名，故加序號。
      // 序號每個嘗試都遞增（不是用 attached.length）：INSERT 失敗的那個檔已經搬過去了，重用序號會蓋掉它。
      const dest = path.join(destDir, `${++seq}_${safeSeg(d.name)}`);
      fs.renameSync(src, dest);
      const { rows: [att] } = await query(
        `INSERT INTO project_chat_attachments (chat_id, message_id, filename, mimetype, file_path)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, filename, mimetype`,
        [chatId, messageId, d.name, mime, path.relative(uploadRoot(), dest)]
      );
      attached.push(att || { filename: d.name, mimetype: mime });
    } catch (err) {
      rejected.push({ filename: d.name, reason: `附加失敗：${err.message}` });
    }
  }
  return { attached, rejected };
}

module.exports = { chatAiDir, chatAiOutbox, quarantineStaleOutbox, collectChatAiFiles, AI_FILE_MAX_COUNT, AI_BINARY_EXTS, AI_TEXT_MIMES };
