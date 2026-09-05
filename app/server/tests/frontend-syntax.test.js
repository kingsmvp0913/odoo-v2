const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 前端沒有任何自動化測試，jest 也不載入 app/public 的檔案——所以一支 view 檔語法壞掉時，
// 整套測試照樣全綠、deploy 照樣成功，只有使用者開到那一頁才會發現。實際炸過一次：
// 2026-09-05 的 a791fe13 在 TaskDetail.js 的 HTML 註解裡寫了一對反引號，而 view 的
// template 是 template literal，反引號提前把字串收掉 → 整支 view 沒定義 → router 靜默
// 把人導回首頁，任務詳細頁等於整頁打不開。瀏覽器 console 只有一句 Unexpected token。
//
// 這支測試把 `node --check` 搬進全跑：只編譯、不執行，所以不需要 DOM 也不會有副作用。
const publicDir = path.join(__dirname, '../../public');

// 走訪全樹而非寫死清單——寫死清單只涵蓋當初改到的那幾支，之後新增的 view 一律漏掃。
// vendor/ 是第三方 bundle，不歸我們管也可能用不同的模組語法，排除。
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.name === 'vendor' ? [] :
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const jsFiles = walk(publicDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.relative(publicDir, f));

describe('app/public 的每支 JS 都要能被解析', () => {
  // 掃描目標不得為空：若 walk 或副檔名過濾寫壞，test.each 會跑 0 個案例並回綠燈，
  // 防線靜默消失。
  test('掃描範圍非空', () => {
    expect(jsFiles.length).toBeGreaterThan(50);
    expect(jsFiles).toContain(path.join('js', 'ui-next', 'pages', 'TaskDetail.js'));
  });

  test.each(jsFiles)('%s 語法正確', (file) => {
    const src = fs.readFileSync(path.join(publicDir, file), 'utf8');
    // new vm.Script 只做 parse/compile，不執行任何一行，等同 `node --check`。
    expect(() => new vm.Script(src, { filename: file })).not.toThrow();
  });
});
