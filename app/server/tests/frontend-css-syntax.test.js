// 意圖：CSS 的錯誤恢復規則會「靜默吞掉檔案後段」，而不是丟掉出錯的那一條。
//
// 2026-08-31 的實例：ui-next.css 裡
//     .ui-next-pipeline-grid{grid-template-columns:repeat(2,minmax(0,1fr)}
// 少了一個右括號。瀏覽器解析器為了找配對括號，把後面所有內容一起吃掉——
// 用 CSSOM 數 document.styleSheets 的實測結果是 275 條規則，修好之後是 357 條。
// 失效的 82 條裡包含三組響應式斷點（900px／760px／560px）與整個 Chat 頁的佈局
// （ui-next-chat 規則從 0 條變成 17 條）。
//
// 為什麼既有防線全部漏掉這件事：
//   - frontend-ui-next.test.js 的 CSS gate 只解析 selector 前綴有沒有 scope，不管語法有沒有效。
//   - 截圖門禁當時沒有 Next 路由；就算有，壞掉的版面對壞掉的版面 diff 恆為 0。
//   - 頁面照樣渲染得出來（殘留的 Legacy class 撐著），沒有任何 console 錯誤。
//
// 所以這一支守的不是「好不好看」，是「這個檔案有沒有一段從此不生效」。
const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '../../public/css');

// vendor/ 是第三方 bundle，壞了也不歸我們修。
const cssFiles = fs
  .readdirSync(CSS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.css'))
  .map((e) => e.name);

// 逐字掃描，跳過註解與字串；回報第一個結構失衡的位置。
// 不用 regex：CSS 的括號結構本來就不是 regular 的，而且 url() 與 content:"…}"
// 這類內容會把任何簡化比對騙過去。
function findImbalance(src) {
  let brace = 0;      // {} 深度
  let paren = 0;      // () 深度
  let parenStart = 0; // 目前這層圓括號從哪裡開始（報錯時指得出位置）
  let i = 0;
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return { kind: '未閉合的註解', line: lineOf(i), at: i };
      i = end + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return { kind: '未閉合的字串', line: lineOf(i), at: i };
      i = j + 1;
      continue;
    }

    if (c === '(') { if (paren === 0) parenStart = i; paren++; }
    else if (c === ')') {
      paren--;
      if (paren < 0) return { kind: '多出來的 )', line: lineOf(i), at: i };
    } else if (c === '{') {
      // 進入宣告區塊時圓括號必須已經收乾淨，否則是 selector 裡的 :is(/:not( 沒關。
      if (paren !== 0) return { kind: '{ 之前有沒關的 (', line: lineOf(parenStart), at: parenStart };
      brace++;
    } else if (c === '}') {
      // 這就是那個 bug 的形狀：宣告值裡的 ( 還沒關就遇到 }。
      if (paren !== 0) return { kind: '} 之前有沒關的 (', line: lineOf(parenStart), at: parenStart };
      brace--;
      if (brace < 0) return { kind: '多出來的 }', line: lineOf(i), at: i };
    }
    i++;
  }

  if (brace !== 0) return { kind: `檔案結束時還有 ${brace} 個沒關的 {`, line: lineOf(src.length - 1), at: src.length - 1 };
  if (paren !== 0) return { kind: `檔案結束時還有 ${paren} 個沒關的 (`, line: lineOf(parenStart), at: parenStart };
  return null;
}

// 解析器失效時測試不得靜默通過——掃不到檔案就是防線已經沒了。
test('掃得到 CSS 檔（檔名或目錄變動時不得靜默略過）', () => {
  expect(cssFiles.length).toBeGreaterThanOrEqual(3);
});

describe('CSS 結構平衡（失衡會讓解析器吞掉檔案後段）', () => {
  test.each(cssFiles)('%s 的括號結構完整', (name) => {
    const src = fs.readFileSync(path.join(CSS_DIR, name), 'utf8');
    const bad = findImbalance(src);
    const detail = bad
      ? `\n\n【${name} 第 ${bad.line} 行附近：${bad.kind}】\n` +
        `  …${src.slice(Math.max(0, bad.at - 90), bad.at + 90).replace(/\n/g, '⏎')}…\n\n` +
        'CSS 不會只丟掉出錯的這一條，而是一路找配對、把後面的規則一起吞掉。\n' +
        '症狀是「某一段樣式從此不生效」，但頁面照樣渲染、console 沒有錯誤、\n' +
        '截圖 diff 也是 0（壞掉的版面對壞掉的版面）。\n'
      : '';
    expect(bad === null ? '平衡' : `失衡${detail}`).toBe('平衡');
  });
});

// 上面那支只驗結構，驗不出「規則數莫名其妙掉了一半」這種更廣的退化。
// 這一支用「每個檔案至少要有幾條頂層規則」當粗略的活著證明：數字取實際值的七成，
// 刻意留鬆——它要抓的是斷崖式塌陷，不是正常的增減。
describe('規則數不得斷崖式塌陷', () => {
  // 頂層規則 ≈ 頂層 { 的個數（@media 內的不算，那是巢狀）。
  const countTopLevelRules = (src) => {
    let brace = 0, n = 0, i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
      if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; i = j + 1; continue; }
      if (c === '{') { if (brace === 0) n++; brace++; }
      else if (c === '}') brace--;
      i++;
    }
    return n;
  };

  const FLOORS = { 'ui-next.css': 190, 'ui-next-pages.css': 280, 'app.css': 400 };

  test.each(Object.keys(FLOORS))('%s 的頂層規則數沒有塌陷', (name) => {
    const src = fs.readFileSync(path.join(CSS_DIR, name), 'utf8');
    expect(countTopLevelRules(src)).toBeGreaterThanOrEqual(FLOORS[name]);
  });
});
