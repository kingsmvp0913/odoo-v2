// 意圖：原始碼裡只要出現**字面** NUL byte，git 就把整支檔案判成 binary，diff 只剩一行
// 「Binary files differ」。對人來說只是看不到 diff；對夜間改善通道來說是整條路斷掉——審核關
// （fix-review）拿不到可審的內容，一律駁回。2026-09-13 提案 #164 連續兩輪死在這裡，而當時
// 測試全綠、畫面零徵狀，沒有任何訊號指向「檔案不是純文字」。
//
// 需要 NUL 當分隔符時，寫 JS 的 unicode 逸出（反斜線 u 0000），不要把那個字元本身打進檔案：
// 執行期是同一個字元（sha1 輸入、Map key 的值都不變），原始檔則維持純文字。
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
// 掃目錄而不是列檔名：列死清單只涵蓋「當初出事的那幾支」，之後新增的檔一律漏掃。
const ROOTS = ['app/server', 'app/public', 'app/rwd', '.claude'];
const TEXT_EXT = /\.(js|mjs|cjs|json|css|html|md|ya?ml|sh|py|sql|txt)$/i;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.name === 'node_modules' ? [] :
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const files = ROOTS.flatMap(r => walk(path.join(repoRoot, r))).filter(f => TEXT_EXT.test(f));

describe('原始碼必須是 git 看得懂的純文字', () => {
  // 走訪掛掉時 files 會是空陣列，下面那條就恆綠——先釘住「真的掃到東西了」。
  test('掃得到檔案（走訪沒有靜默落空）', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  test('不得含字面 NUL byte（會讓 git 判成 binary、diff 變成不可審閱）', () => {
    const offenders = files
      .filter(f => fs.readFileSync(f).includes(0))
      .map(f => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
});
