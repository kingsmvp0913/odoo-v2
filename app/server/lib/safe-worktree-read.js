// app/server/lib/safe-worktree-read.js
/**
 * safe-worktree-read.js — 容器能在任務 worktree 放符號連結（子專案 0，Task 3.14）
 *
 * AI 在容器內對任務 worktree 有完整寫入權，包含建立符號連結。平台事後在宿主讀 worktree 內的
 * 檔案（打包 zip、抓 E2E tour 檔）若照單全收，容器裡的 AI 只要放一個指向宿主 `data/config.json`
 * （含 APP_SECRET／JWT_SECRET／DATABASE_URL）之類宿主機密的 symlink，平台就會把內容讀出來、
 * 包進 zip 或送進 log／回覆給使用者。
 * 一律只認 lstat 直接判定的「一般檔案」（不 follow 任何 symlink），且其 realpath 必須仍落在
 * worktree 根目錄（root）的 realpath 內——同時擋路徑中間目錄是 symlink、以及 `..` 逃逸。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// file 是否為「一般檔案」且 realpath 落在 root（含子目錄）內。不 follow file 本身或其上層路徑
// 元件的 symlink：檢查一律以 lstat／realpath 做，從不對 file 直接 stat。
function isSafeRegularFileInside(file, root) {
  let st;
  try { st = fs.lstatSync(file); } catch { return false; }
  if (!st.isFile()) return false; // 排除 symlink／目錄／裝置檔等
  let realFile, realRoot;
  try {
    realFile = fs.realpathSync(file);
    realRoot = fs.realpathSync(root);
  } catch { return false; }
  const rel = path.relative(realRoot, realFile);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 依 root 讀取 rel：先驗證（禁止 symlink／`..` 逃逸／非一般檔案），驗不過丟例外。
async function readFileInside(root, rel, encoding) {
  const file = path.join(root, rel);
  if (!isSafeRegularFileInside(file, root)) {
    const e = new Error(`拒絕讀取：不是 worktree 內的一般檔案（${rel}）`);
    e.code = 'UNSAFE_WORKTREE_READ';
    throw e;
  }
  return fsp.readFile(file, encoding);
}

module.exports = { isSafeRegularFileInside, readFileInside };
