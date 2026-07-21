// 意圖：pid 存 DB、app 重啟後 OS 可能把同一 pid 派給無關行程；kill 前必須核對行程身分指紋
// （Linux /proc starttime），不符即拒殺——否則會殺錯無辜行程。
const { processAlive, pidStartTime, killPidGracefully, killChildGracefully } = require('../lib/proc');

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

// 意圖：Windows 上殺 claude 子行程時，必須連它 Bash 出去的孫程序（如 find.exe）一起收，
// 否則孫程序變孤兒常駐吃資源。這正是本次修的核心——用「父→孫」兩層行程樹釘住這個行為。
test('killChildGracefully（win32）：連孫程序一起收，不留孤兒', async () => {
  if (process.platform !== 'win32') return;
  const { spawn } = require('child_process');
  // 父行程 spawn 一個長命孫行程，把孫的 pid 印到 stdout 供測試核對
  const parent = spawn(process.execPath, ['-e',
    "const{spawn}=require('child_process');" +
    "const g=spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});" +
    "process.stdout.write(String(g.pid));setInterval(()=>{},1e9);"
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  parent.stdout.on('data', d => { out += d.toString(); });
  // 等孫 pid 印出
  for (let i = 0; i < 40 && !out; i++) await new Promise(r => setTimeout(r, 50));
  const grandPid = parseInt(out.trim(), 10);
  expect(processAlive(grandPid)).toBe(true); // 前提：孫確實還活著

  killChildGracefully(parent); // 只殺父：舊行為會漏掉孫，taskkill /T 應連根收
  // taskkill 是 spawn 出去非同步，輪詢等它把整棵樹收乾淨
  for (let i = 0; i < 60 && processAlive(grandPid); i++) await new Promise(r => setTimeout(r, 50));
  expect(processAlive(grandPid)).toBe(false);
});
