// 意圖：showToast 產生的 id 同時是 Vue 的 :key，也是「時間到把自己移除」那段 filter 的依據
//（toasts = toasts.filter(t => t.id !== id)）。id 取 Date.now() 的話，同一輪同步程式碼裡連發的
// 多個 toast 會拿到同一個毫秒值，於是：先到期的那一筆會把同 id 的其他 toast 一起濾掉——訊息互相吃掉，
// 使用者只看到一則就整排消失。socket 事件批次抵達（task:synced 後面跟著數筆 task:updated）
// 正是這個情境，而且不會有任何錯誤訊息。
//
// 這支測試把 Date.now() 凍住再跑真的 showToast，所以「今天會紅」是必然而不是碰運氣。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/app.js');

// app.js 整支依賴 Vue／VueRouter 全域，無法直接 require；只取 toast 這一小段來跑。
function loadToast() {
  const src = fs.readFileSync(SRC, 'utf8');
  const from = src.indexOf('const toasts = ref(');
  const to = src.indexOf('window.showToast = showToast;');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);

  const timers = [];
  const factory = new Function('ref', 'setTimeout', 'Date',
    `${src.slice(from, to)}\nreturn { showToast, toasts, dismissToast };`);
  const { showToast, toasts, dismissToast } = factory(
    (v) => ({ value: v }),
    (fn) => { timers.push(fn); },
    { now: () => 1700000000000 } // 凍結：模擬「同一毫秒內連發」
  );
  return { showToast, toasts, timers, dismissToast };
}

// duration 傳 0 的意圖是「這則不要一閃即逝」（規格 §4.6：錯誤訊息不可用一般秒數）。
// 原本的 showToast 無條件 setTimeout(…, duration)，於是 0 變成「0ms 後移除」——
// 訊息等於沒出現過。ui-next 有 30 幾處錯誤路徑是 showToast(msg, "error", 0)，全部靜默失效，
// 使用者只看到操作沒反應、看不到原因。這是「參數值剛好把行為反轉」的那種 bug，
// 靜態檢查與截圖都看不到。
//
// 但另一個極端同樣是缺陷：完全不排定移除的話，沒人按 × 的錯誤訊息會一路疊在右下角擋畫面、
// 換頁也不會消。所以要同時成立兩件事——有排定移除（不會永久黏著）、而且那個秒數遠大於
// 一般 toast 的 4 秒（使用者來得及讀完、複製錯誤內容）。
test('duration 傳 0 ＝ 久一點才關，但仍必須排定移除（不可永久黏著）', () => {
  const { showToast, toasts, timers } = loadToast();
  showToast('這是錯誤訊息', 'error', 0);
  expect(toasts.value).toHaveLength(1);
  expect(timers).toHaveLength(1);              // 有排定移除
  expect(toasts.value[0].sticky).toBe(true);   // 由它決定要不要畫關閉鈕
  timers[0]();
  expect(toasts.value).toHaveLength(0);
});

// 上面那支只證明「有排定」，不會在有人把秒數改回 4 秒時紅。秒數本身才是意圖：
// 錯誤訊息要留得比一般訊息久得多。
test('錯誤 toast 的存活秒數遠長於一般 toast（不可被改回 4 秒）', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = src.match(/const STICKY_TOAST_MS = (\d+);/);
  expect(m).not.toBeNull();
  expect(Number(m[1])).toBeGreaterThanOrEqual(15000);
});

test('一般 toast 仍然會自動關閉（不可為了修上面那條就全部改成不消失）', () => {
  const { showToast, toasts, timers } = loadToast();
  showToast('一般訊息');
  expect(timers).toHaveLength(1);
  expect(toasts.value[0].sticky).toBe(false);
  timers[0]();
  expect(toasts.value).toHaveLength(0);
});

test('dismissToast 只關掉指定的那一則', () => {
  const { showToast, toasts, dismissToast } = loadToast();
  const first = showToast('第一則錯誤', 'error', 0);
  showToast('第二則錯誤', 'error', 0);
  dismissToast(first);
  expect(toasts.value.map((t) => t.message)).toEqual(['第二則錯誤']);
});

test('同一毫秒連發的 toast 拿到不同 id（id 也是 Vue 的 :key，重複會渲染錯亂）', () => {
  const { showToast, toasts } = loadToast();
  showToast('第一則');
  showToast('第二則');
  showToast('第三則');
  expect(new Set(toasts.value.map((t) => t.id)).size).toBe(3);
});

test('第一則到期只移除自己，不會把同批其他 toast 一起吃掉', () => {
  const { showToast, toasts, timers } = loadToast();
  showToast('第一則');
  showToast('第二則');
  showToast('第三則');
  timers[0](); // 第一則的 duration 到了
  expect(toasts.value.map((t) => t.message)).toEqual(['第二則', '第三則']);
});
