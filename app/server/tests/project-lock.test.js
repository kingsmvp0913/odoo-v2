// 意圖：同專案的短變動操作（merge/deploy/worktree/analysis-checkout）必須一次一個，
// 避免同時寫壞共用主 clone／測試 env；不同專案互不阻擋（併發）。
const { withProjectLock } = require('../pipeline/project-lock');

const tick = () => new Promise(r => setImmediate(r));

test('同 projectId 序列化：第二個等第一個完成才開始', async () => {
  const order = [];
  let release1;
  const p1 = withProjectLock(1, async () => {
    order.push('1-start');
    await new Promise(r => { release1 = r; });
    order.push('1-end');
  });
  const p2 = withProjectLock(1, async () => { order.push('2-start'); });

  await tick();
  expect(order).toEqual(['1-start']);   // 2 還沒開始
  release1();
  await Promise.all([p1, p2]);
  expect(order).toEqual(['1-start', '1-end', '2-start']); // 嚴格序列
});

test('不同 projectId 平行：互不阻擋', async () => {
  const order = [];
  let release1;
  const p1 = withProjectLock(1, async () => {
    order.push('A-start');
    await new Promise(r => { release1 = r; });
  });
  const p2 = withProjectLock(2, async () => { order.push('B-start'); });

  await tick();
  expect(order).toContain('B-start'); // B（不同專案）不必等 A
  release1();
  await Promise.all([p1, p2]);
});

test('前一個 reject 不卡住後一個（不論成敗都接續）', async () => {
  const p1 = withProjectLock(3, async () => { throw new Error('boom'); });
  await expect(p1).rejects.toThrow('boom');
  const p2 = withProjectLock(3, async () => 'ok');
  await expect(p2).resolves.toBe('ok');
});

test('回傳 fn 的結果', async () => {
  await expect(withProjectLock(4, async () => 42)).resolves.toBe(42);
});
