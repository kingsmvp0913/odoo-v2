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
    `${src.slice(from, to)}\nreturn { showToast, toasts };`);
  const { showToast, toasts } = factory(
    (v) => ({ value: v }),
    (fn) => { timers.push(fn); },
    { now: () => 1700000000000 } // 凍結：模擬「同一毫秒內連發」
  );
  return { showToast, toasts, timers };
}

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
