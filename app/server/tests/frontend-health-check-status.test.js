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

// 「擋下這條」是預設核准之後管理員唯一還需要做的動作，它送的值必須真的被後端接受。
test('ui-next 健檢頁的「擋下這條」送的是後端收得下的值', () => {
  const src = read('public/js/ui-next/pages/AdminHealthCheck.js');
  const btn = src.match(/setStatus\(f,\s*'([^']+)'\)"[^>]*>[^<]*擋下這條/);
  expect(btn).not.toBeNull();
  expect(backendStatuses()).toContain(btn[1]);
});
