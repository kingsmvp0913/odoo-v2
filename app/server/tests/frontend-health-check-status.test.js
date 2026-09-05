// 意圖：釘住「健檢頁的處置狀態清單」與「後端 PATCH 白名單」之間那條縫。
//
// 這條縫是實際踩過的：HC_STATUS 不是純顯示清單——兩支 View 都把它 bind 成 statuses 並 v-for
// render 成可點的裁決鈕，所以往裡面加一個值，等於在畫面上多一顆會送出該值的按鈕。後端
// FINDING_STATUS 沒同步時，那顆鈕按下去一律 400「狀態不合法」，而且全套前端靜態守衛都不會紅
// （它們檢的是配色、a11y、字串重複，沒有人負責跨前後端比對這個列舉）。
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

// 從前端常數檔抓 HC_STATUS 的 value 集合。刻意用來源檔字串解析而不是 require：那支檔是瀏覽器
// 全域腳本（頂層就 window.XXX = Vue.defineComponent），在 node 裡載不起來。
function frontendStatuses() {
  const src = read('public/js/views/AdminHealthCheck.js');
  const block = src.match(/const HC_STATUS\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('找不到 HC_STATUS——常數改名或搬家了，這條守衛要跟著改');
  return [...block[1].matchAll(/value:\s*'([^']+)'/g)].map(m => m[1]);
}

function backendStatuses() {
  const src = read('server/admin-routes.js');
  const block = src.match(/const FINDING_STATUS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('找不到 FINDING_STATUS——常數改名或搬家了，這條守衛要跟著改');
  return [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

// 解析不到就等於守衛失效，而失效的守衛全綠——先確認兩邊都真的抓到東西，這條測試才有鑑別力。
test('兩邊的狀態列舉都解析得到（解析失敗時不得靜默變成空集合比較）', () => {
  expect(frontendStatuses().length).toBeGreaterThan(1);
  expect(backendStatuses().length).toBeGreaterThan(1);
});

test('健檢頁每一顆狀態鈕送出的值，後端 PATCH 白名單都收得下', () => {
  const backend = new Set(backendStatuses());
  const missing = frontendStatuses().filter(v => !backend.has(v));
  // 列出缺的是哪幾個：只說「不相等」的話，下次紅了還要自己再比對一次
  expect(missing).toEqual([]);
});

// 這一支原本釘的是 ui-next 健檢頁「擋下這條」那顆鈕送出的值。2026-09-05 使用者裁決：
// 健檢頁收斂成純 log，提案的處置（核准／駁回／刪除）一律在「改善提案」頁——兩頁各放一套
// 按鈕做同一件事，正是這次要消掉的毛病。
//
// 守衛跟著換方向：不再檢查那顆鈕送什麼，改成擋住「有人又把裁決鈕加回健檢頁」。加回去的話
// 症狀不是壞掉而是分裂——同一條提案在兩頁各有一套狀態，管理員按了哪邊才算數沒有人說得準。
test('ui-next 健檢頁不得再送出任何裁決（處置一律在改善提案頁）', () => {
  const src = read('public/js/ui-next/pages/AdminHealthCheck.js');
  expect(src).not.toMatch(/setStatus\s*\(/);
  // 這一頁只讀不寫：PATCH／DELETE 出現就是又長出了處置入口
  expect(src).not.toMatch(/Api\.(patch|delete)\s*\(/);
});
