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

// duration 傳 0 的意圖是「這則不要自己消失」（規格 §4.6：錯誤訊息預設不可自動消失）。
// 原本的 showToast 無條件 setTimeout(…, duration)，於是 0 變成「0ms 後移除」——
// 訊息等於沒出現過。ui-next 有 30 幾處錯誤路徑是 showToast(msg, "error", 0)，全部靜默失效，
// 使用者只看到操作沒反應、看不到原因。這是「參數值剛好把行為反轉」的那種 bug，
// 靜態檢查與截圖都看不到。
test('duration 傳 0 代表不自動關閉，不得排定移除', () => {
  const { showToast, toasts, timers } = loadToast();
  showToast('這是錯誤訊息', 'error', 0);
  expect(toasts.value).toHaveLength(1);
  expect(timers).toHaveLength(0);   // 沒有任何排定的移除
  expect(toasts.value[0].sticky).toBe(true);   // 由它決定要不要畫關閉鈕
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
