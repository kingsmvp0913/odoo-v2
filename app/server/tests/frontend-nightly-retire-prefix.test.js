// 意圖：釘住「夜間批次機器退場的標記前綴」在後端（retire-prefix.js 的 MACHINE_RETIRE_PREFIX）
// 與前端（AdminHealthCheck.js 的 isMachineRetired）之間那條縫。
//
// 這條縫是實際踩過的類型（見 frontend-health-check-status.test.js）：兩邊各寫死一份字面值，
// 零守衛。任一邊改字（含把全形冒號 U+FF1A 打成半形）會讓 pill 靜默消失、測試全綠、零訊號——
// 不抽全域常數是 controller 已裁決的取捨（前後端無共用模組機制，為單一字串串全域常數要過
// CDN 載入順序關，機械成本高於風險），防漂移改交給這支測試。
//
// 常數本體已抽到 retire-prefix.js（葉節點模組，見 R1(b)）：nightly-fix.js 與
// health-check-runner.js 互相 require 會有循環依賴風險，抽出去斷開那條邊。
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

// 從後端來源檔字串解析 MACHINE_RETIRE_PREFIX 的字面值。
function backendPrefix() {
  const src = read('server/pipeline/retire-prefix.js');
  const m = src.match(/const MACHINE_RETIRE_PREFIX\s*=\s*'([^']*)'/);
  if (!m) throw new Error('找不到 MACHINE_RETIRE_PREFIX——常數改名或搬家了，這條守衛要跟著改');
  return m[1];
}

// 從前端來源檔字串解析狀態判斷用的 startsWith 字面值。刻意用來源檔字串解析而不是 require：
// 那支檔是瀏覽器全域腳本（頂層就 window.XXX = Vue.defineComponent），在 node 裡載不起來。
//
// ⚠ 2026-09-05 搬家：原本釘的是 AdminHealthCheck.js 的 isMachineRetired（提案卡片上那顆
// 「🤖 夜間批次自動退場」pill）。健檢頁已依使用者裁決收斂成純 log，提案的狀態與處置全部
// 集中到「改善提案」頁，這條守衛跟著指到新家 AdminFeedback.js 的 stateOf。
function frontendPrefix() {
  const src = read('public/js/ui-next/pages/AdminFeedback.js');
  const m = src.match(/stateOf\(r\)\s*\{[\s\S]*?startsWith\('([^']*)'\)/);
  if (!m) throw new Error('找不到 stateOf 的 startsWith 前綴——寫法改了，這條守衛要跟著改');
  return m[1];
}

// 解析不到就等於守衛失效，而失效的守衛全綠——先確認兩邊都真的抓到東西（且非空字串，
// 否則 startsWith('') 恆為 true，比對「相等」也會恆為真），這條測試才有鑑別力。
test('後端與前端的機器退場前綴都解析得到（解析失敗或空字串時不得靜默變成恆真比較）', () => {
  expect(backendPrefix().length).toBeGreaterThan(0);
  expect(frontendPrefix().length).toBeGreaterThan(0);
});

test('前端 pill 判斷用的前綴，與後端實際寫進 note 的前綴逐字相同', () => {
  expect(frontendPrefix()).toBe(backendPrefix());
});

// 同一條縫的第二處：`last_attempt_note`（夜間批次寫「上次試到哪、為什麼沒過」的欄位）。
// 後端 nightly-fix.js 寫它、前端 AdminFeedback.js 的 stateOf 讀它，中間一樣是零守衛的字面值。
// 欄位改名時的症狀與前綴那條完全一樣：測試全綠、畫面上那個狀態靜默消失，使用者又回到
// 「已核准的意見一直停在已核准，不知道昨晚試過沒過」——也就是本欄一開始要解決的那件事。
test('last_attempt_note：後端會寫、前端會讀（欄位改名時兩邊必須一起改）', () => {
  const backend = read('server/pipeline/nightly-fix.js');
  const frontend = read('public/js/ui-next/pages/AdminFeedback.js');
  // 後端：UPDATE 語句裡真的有設這一欄（只 SELECT 不算——那不會讓畫面有東西看）
  expect(backend).toMatch(/UPDATE\s+feedback\s+SET[\s\S]{0,200}?last_attempt_note\s*=/);
  // 前端：stateOf 裡真的讀得到它
  expect(frontend).toMatch(/stateOf\(r\)\s*\{[\s\S]*?r\.last_attempt_note/);
});
