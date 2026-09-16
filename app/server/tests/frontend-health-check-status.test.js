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


// ── 「要不要改善」那一欄 ──────────────────────────────────────────────────────
//
// 意圖：這一欄是使用者每天唯一會掃的那格，它必須誠實回答「我今天要不要動手」。
// 實際踩過（2026-09-14／09-15）：那兩輪 auditor 只出 signal（候選訊號＝像個問題但證據還
// 不夠），改善提案頁因此一張單都沒有，而這一欄照樣寫「待處理 1」。使用者的結論是「提案不見
// 了」——其實提案根本沒產生，而這一欄把「還在看」講成了「等你處理」。
//
// 用字串比對只能確認檔案裡有「觀察中」三個字，擋不住它被掛在錯的分支上。所以把 histTodo
// 真的切出來執行：分支邏輯錯了才會紅。
function loadHistTodo() {
  const src = read('public/js/ui-next/pages/AdminHealthCheck.js');
  const start = src.indexOf('histTodo(h) {');
  if (start === -1) throw new Error('找不到 histTodo——改名或搬家了，這條守衛要跟著改');
  // 從函式開頭做大括號配對，切出完整函式本體（行數／縮排會隨改版漂移，不能拿來當界線）
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error('histTodo 的大括號配不起來');
  // 物件方法簡寫 → 具名函式，才 eval 得起來
  const body = src.slice(start, end).replace(/^histTodo\(h\)/, 'function histTodo(h)');
  return eval('(' + body + ')'); // eslint-disable-line no-eval
}

const histTodo = loadHistTodo();

test('只有候選訊號在等 → 顯示「觀察中」，不得說成「待處理」', () => {
  // 09-15 那一輪的真實形狀：1 條 medium signal、0 條提案
  expect(histTodo({ proposal_count: 1, open_count: 1, watch_count: 1 }).label).toBe('觀察中 1');
});

test('「待處理」的數字只算真提案，不把候選訊號灌進去', () => {
  // 3 條未結案裡有 1 條只是訊號 → 要人決定的其實只有 2 條
  expect(histTodo({ proposal_count: 4, open_count: 3, watch_count: 1 }).label).toBe('待處理 2');
});

test('提案與訊號都結案 → 已處理完', () => {
  expect(histTodo({ proposal_count: 2, open_count: 0, watch_count: 0 }).label).toBe('已處理完');
});

test('這一輪沒產出提案也沒產出訊號 → 這一格不顯示任何狀態', () => {
  expect(histTodo({ proposal_count: 0, open_count: 0, watch_count: 0 })).toBeNull();
});

// 後端沒回 watch_count（舊快取、或有人把那個欄位拿掉）時不得整欄崩掉或算出 NaN：
// 退回「全部當提案」的舊行為，那是保守但不說謊的那一邊。
test('後端沒帶 watch_count 時退回舊行為，不得算出 NaN', () => {
  expect(histTodo({ proposal_count: 1, open_count: 1 }).label).toBe('待處理 1');
});

// 展開的明細也要分得出來：同樣是 medium，提案要動手、訊號只是在看。
test('展開區每一條要標出它是提案還是觀察中', () => {
  const src = read('public/js/ui-next/pages/AdminHealthCheck.js');
  expect(src).toContain('kindLabel(f)');
  expect(src).toMatch(/kindLabel\(f\)\.label/);
});
