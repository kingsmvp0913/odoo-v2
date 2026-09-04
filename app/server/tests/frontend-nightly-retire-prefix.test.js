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

// 從前端來源檔字串解析 isMachineRetired 用的 startsWith 字面值。刻意用來源檔字串解析而不是
// require：那支檔是瀏覽器全域腳本（頂層就 window.XXX = Vue.defineComponent），在 node 裡載不起來。
function frontendPrefix() {
  const src = read('public/js/ui-next/pages/AdminHealthCheck.js');
  const m = src.match(/isMachineRetired\(f\)\s*\{[\s\S]*?startsWith\('([^']*)'\)/);
  if (!m) throw new Error('找不到 isMachineRetired 的 startsWith 前綴——寫法改了，這條守衛要跟著改');
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
