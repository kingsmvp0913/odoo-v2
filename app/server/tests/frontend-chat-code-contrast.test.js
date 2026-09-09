// 意圖：chat 對話訊息裡的程式區塊（```fenced``` 會被 marked 渲染成 <pre><code>）底色走 var(--code-bg)，
// 而 --code-bg 在淺色與深色模式**都是深色**（app.css：#1e1e1e／#141414，這是刻意的，終端風格）。
// 所以那顆 <code> 的字色若取 var(--text)，淺色模式下就是近黑字疊在近黑底上＝整段程式碼隱形，
// 而深色模式的 var(--text) 是白字，看起來完全正常——只有淺色模式才炸，很容易改壞了卻沒人發現。
//
// 這條測試盯的是「字色與底色必須來自同一個主題無關的配對」：底是 --code-bg，字就得是 --code-text。
// 行內 code（不在 pre 裡）不受此限——它的底是 var(--text) 的 10% 疊色，跟著內文走才對。
const fs = require('fs');
const path = require('path');

// 先剝掉 CSS 註解，否則說明文字裡出現的 var(--text) 會被當成真的宣告。
const css = fs
  .readFileSync(path.join(__dirname, '../../public/css/ui-next-pages/09-later-patches.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// 抓出某個選擇器的宣告區塊（本檔皆為單選擇器單行規則）。
const blockOf = (selector) => {
  const re = new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  return m ? m[1] : null;
};

const inlineCode = blockOf('.ui-next-message code');
const blockCode = blockOf('.ui-next-message pre code');

describe('對話訊息的程式區塊在兩種模式都看得到字', () => {
  // 正則失效時下面兩條會變成「找不到規則」的假綠，故先讓解析失敗以明確方式現形。
  test('解析得到這兩條既有規則（正則失效時不得靜默通過）', () => {
    expect(inlineCode).toEqual(expect.stringContaining('color:'));
    expect(blockCode).toEqual(expect.stringContaining('padding:0'));
  });

  test('pre 內的 code 字色取 --code-text，不得沿用內文的 --text', () => {
    expect(blockCode).toEqual(expect.stringContaining('color:var(--code-text)'));
    expect(blockCode).not.toMatch(/color:\s*var\(--text\)/);
  });
});
