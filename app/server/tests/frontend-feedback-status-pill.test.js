// 意圖：意見狀態的顏色對照在前端有兩份寫死副本——管理頁 AdminFeedback.js 的 STATUS_PILL，
// 與「我的意見」視窗 UiNextApp.js 的 myFeedbackStatusPill（前端沒有共用模組機制，這是已裁決
// 的取捨，見 frontend-nightly-retire-prefix.test.js 的同型說明）。
// 兩邊漂掉不會有任何徵狀：測試綠、畫面正常，只是同一筆意見在兩個畫面上是不同顏色。
//
// 顏色語意本身也釘住：綠＝已完成。原本 approved 給綠、done 給黃，於是「已核准（還沒做）」
// 看起來像做完了，而真的做完的那個是警告色——使用者回報「看起來都一樣」時翻出來的。
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

// 從來源檔字串解析對照表（兩支都是瀏覽器全域腳本，在 node 裡 require 不起來）
function parseMap(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`找不到 ${marker}——改名或搬家了，這條守衛要跟著改`);
  const body = src.slice(at, src.indexOf('}', at));
  const out = {};
  for (const m of body.matchAll(/(\w+)\s*:\s*["']([\w-]+)["']/g)) out[m[1]] = m[2];
  return out;
}

const adminMap = () => parseMap(read('public/js/ui-next/pages/AdminFeedback.js'), 'const STATUS_PILL =');
const modalMap = () => parseMap(read('public/js/ui-next/UiNextApp.js'), 'myFeedbackStatusPill(status)');

// 解析不到就等於守衛失效，而失效的守衛全綠——先確認兩邊都真的抓到四個狀態
test('兩份對照都解析得到四個狀態（解析失敗時不得靜默變成空物件比空物件）', () => {
  expect(Object.keys(adminMap()).sort()).toEqual(['approved', 'done', 'new', 'rejected']);
  expect(Object.keys(modalMap()).sort()).toEqual(['approved', 'done', 'new', 'rejected']);
});

test('管理頁與「我的意見」視窗的狀態顏色逐項相同', () => {
  expect(modalMap()).toEqual(adminMap());
});

test('顏色語意：已完成是綠、已駁回是紅、已核准不得用綠（那還沒做完）', () => {
  const m = adminMap();
  expect(m.done).toBe('pill-success');
  expect(m.rejected).toBe('pill-danger');
  expect(m.approved).not.toBe('pill-success');
});
