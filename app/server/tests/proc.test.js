// 意圖：pid 存 DB、app 重啟後 OS 可能把同一 pid 派給無關行程；kill 前必須核對行程身分指紋
// （Linux /proc starttime），不符即拒殺——否則會殺錯無辜行程。
const { processAlive, pidStartTime, killPidGracefully } = require('../lib/proc');

test('processAlive：自己的 pid 為 true、不存在的 pid 為 false', () => {
  expect(processAlive(process.pid)).toBe(true);
  expect(processAlive(999999999)).toBe(false);
});

test('pidStartTime：Linux 上讀得到自己行程的 starttime（字串）', () => {
  const st = pidStartTime(process.pid);
  if (process.platform === 'linux') {
    expect(typeof st).toBe('string');
    expect(Number(st)).toBeGreaterThan(0);
  } else {
    expect(st).toBeNull(); // 非 Linux best-effort：回 null、呼叫端放行
  }
});

test('killPidGracefully：expectedStart 不符 → 拒殺（pid 已被重用的防護）', async () => {
  if (process.platform !== 'linux') return; // 指紋僅 Linux 可驗證
  const spy = jest.spyOn(process, 'kill');
  // 以自己的 pid 測：指紋不符時絕不能送出任何訊號（否則測試行程會被自己殺掉）
  await killPidGracefully(process.pid, { expectedStart: 'not-the-real-starttime' });
  expect(spy.mock.calls.filter(c => c[0] === process.pid && c[1] !== 0)).toHaveLength(0);
  spy.mockRestore();
});

test('killPidGracefully：expectedStart 相符 → 照常送 SIGTERM', async () => {
  if (process.platform !== 'linux') return;
  const { spawn } = require('child_process');
  const child = spawn('sleep', ['30']);
  await new Promise(r => setTimeout(r, 50)); // 等 /proc 條目就緒
  const st = pidStartTime(child.pid);
  await killPidGracefully(child.pid, { expectedStart: st, graceMs: 2000 });
  expect(processAlive(child.pid)).toBe(false);
});
