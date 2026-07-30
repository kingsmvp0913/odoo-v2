// 意圖：任務狀態徽章的底色由 `.status-badge.<status>` 這條 CSS 決定，class 名直接來自後端回傳的
// status 字串（TaskList／TaskDetail 都是 :class="t.status"）。新增一個流程狀態時只補了
// status-labels.js、沒補 app.css，不會報錯也不會退回某個預設色——徽章直接渲染成「沒有底色的純文字」，
// 夾在一排彩色徽章裡看起來像壞掉，而且只有那個狀態出現時才看得到，很容易漏掉。
//
// 深色模式另有一組 [data-theme="dark"] 覆寫。只補淺色那組的話，深色模式下會沿用淺色的亮底深字，
// 在深色頁面上是一塊刺眼的白斑；只補深色則淺色模式無樣式。故兩組都要斷言。
const fs = require('fs');
const path = require('path');
const { STATUS_LABELS } = require('../../public/js/status-labels.js');

// 先剝掉 CSS 註解，否則本檔案（或 app.css 內）說明文字裡出現的 .status-badge.xxx 會被當成真的有樣式。
const css = fs
  .readFileSync(path.join(__dirname, '../../public/css/app.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// 淺色規則的選擇器出現在行首或逗號之後；深色規則一律以 [data-theme="dark"] 開頭，故兩者不會互相污染。
const collect = (re) => new Set([...css.matchAll(re)].map((m) => m[1]));
const lightStyled = collect(/(?:^|,)\s*\.status-badge\.([A-Za-z0-9_-]+)/gm);
const darkStyled = collect(/\[data-theme="dark"\]\s+\.status-badge\.([A-Za-z0-9_-]+)/g);

const statuses = Object.keys(STATUS_LABELS);

describe('狀態徽章樣式涵蓋所有會出現的狀態', () => {
  // 正則失效時上面兩個集合會變空，所有斷言就會變成「全部都沒樣式」的假紅；反過來若寫成
  // toContain 之類也可能假綠。這裡先確認解析結果數量合理，讓解析失敗以明確的方式現形。
  test('解析到合理數量的既有規則（正則失效時不得靜默通過）', () => {
    expect(lightStyled.size).toBeGreaterThan(10);
    expect(darkStyled.size).toBeGreaterThan(10);
    expect(statuses.length).toBeGreaterThan(10);
  });

  test('淺色模式：每個狀態都有 .status-badge 樣式', () => {
    expect(statuses.filter((s) => !lightStyled.has(s))).toEqual([]);
  });

  test('深色模式：每個狀態都有 [data-theme="dark"] 覆寫', () => {
    expect(statuses.filter((s) => !darkStyled.has(s))).toEqual([]);
  });
});
