// Docker daemon 沒啟動時，Windows 上用官方 `docker desktop start` 背景起引擎（不跳 GUI 視窗、
// 同步等到就緒）。邏輯住在通用驅動層 docker-env，VPN gateway 與測試區建置共用同一份。
const { ensureDockerRunning } = require('../lib/docker-env');

function fakeDeps(overrides = {}) {
  return {
    execFileSync: jest.fn(() => { throw new Error('daemon not reachable'); }),
    platform: 'win32',
    ...overrides,
  };
}

const isStart = (call) => call[1][0] === 'desktop' && call[1][1] === 'start';
const isRestart = (call) => call[1][0] === 'desktop' && call[1][1] === 'restart';
const isInfo = (call) => call[1][0] === 'info';

test('daemon 已啟動時直接回傳，不呼叫 docker desktop start', async () => {
  const deps = fakeDeps({ execFileSync: jest.fn(() => '') });
  await ensureDockerRunning(deps);
  expect(deps.execFileSync.mock.calls.some(isStart)).toBe(false);
  expect(deps.execFileSync.mock.calls.filter(isInfo)).toHaveLength(1); // 只做一次 daemon 檢查
});

test('Windows 上 daemon 未啟動時，呼叫 docker desktop start --timeout 起引擎後再確認就緒', async () => {
  let started = false;
  const execFileSync = jest.fn((cmd, args) => {
    if (args[0] === 'desktop' && args[1] === 'start') { started = true; return ''; }
    if (args[0] === 'info' && !started) throw new Error('daemon not reachable'); // start 前未就緒
    return ''; // start 後 info 成功
  });
  const deps = fakeDeps({ execFileSync });
  await ensureDockerRunning(deps);

  const startCall = execFileSync.mock.calls.find(isStart);
  expect(startCall).toBeTruthy();
  expect(startCall[1]).toEqual(['desktop', 'start', '--timeout', '120']);
});

test('start 後仍連不上 daemon 時，先試 restart 再放棄；仍不通則丟出明確錯誤', async () => {
  const deps = fakeDeps(); // execFileSync 永遠丟錯（含 start／restart 失敗、info 不通）
  await expect(ensureDockerRunning(deps)).rejects.toThrow(/Docker 引擎啟動失敗/);
  // start 救不回來時，必須再試一次 restart（強制重拉整個後端）才放棄
  expect(deps.execFileSync.mock.calls.some(isRestart)).toBe(true);
});

test('start 秒回但引擎沒起來（App 在跑、WSL2 引擎停）時，改用 restart 重拉後回傳', async () => {
  let restarted = false;
  const execFileSync = jest.fn((cmd, args) => {
    if (args[0] === 'desktop' && args[1] === 'start') return '';                 // start 秒回 already running，卻沒真的起引擎
    if (args[0] === 'desktop' && args[1] === 'restart') { restarted = true; return ''; }
    if (args[0] === 'info' && !restarted) throw new Error('daemon not reachable'); // restart 前引擎不通
    return ''; // restart 後 info 成功
  });
  const deps = fakeDeps({ execFileSync });
  await ensureDockerRunning(deps);

  const restartCall = execFileSync.mock.calls.find(isRestart);
  expect(restartCall).toBeTruthy();
  expect(restartCall[1]).toEqual(['desktop', 'restart', '--timeout', '120']);
});

// 意圖（真事故等級）：平台是單進程常駐。`docker desktop start --timeout 120` 會等到引擎就緒才回，
// 用 execFileSync 跑等於把整個事件迴圈凍住——最壞 start＋restart 兩輪約 4 分鐘，期間所有 HTTP 請求、
// cron、pipeline 全部停擺，而觸發點是「有人按了建立測試區」這種日常操作。
// 鑑別力來源：同時注入同步與非同步兩種 exec，斷言走的是非同步那條，且等待期間 timer 仍會被執行。
// 修法前 deps.execFile 根本不會被看一眼（execFileSync 優先），start 從未發出 → 前兩個斷言即失敗。
test('daemon 啟動指令走非同步 execFile，等待期間不凍結事件迴圈', async () => {
  const pendingStart = [];
  const execFile = jest.fn((cmd, args, opts, cb) => {
    if (args[0] === 'info') return cb(new Error('daemon not reachable'));
    pendingStart.push(cb); // desktop start：模擬引擎冷啟動，先不回呼
  });
  const syncExec = jest.fn(() => { throw new Error('daemon not reachable'); });
  const p = ensureDockerRunning({ execFile, execFileSync: syncExec, platform: 'win32' });

  // 若啟動指令是同步跑的，這個 timer 在 ensureDockerRunning 回來之前不可能被執行。
  let ticked = false;
  await new Promise(r => setTimeout(() => { ticked = true; r(); }, 0));
  expect(pendingStart).toHaveLength(1); // 已發出 start 且仍在等引擎
  expect(ticked).toBe(true);            // 等待期間事件迴圈仍活著
  expect(syncExec).not.toHaveBeenCalled();

  execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '')); // 引擎起來了
  pendingStart[0](null, '');
  await expect(p).resolves.toBeUndefined();
});

test('非 Windows 平台時，daemon 沒啟動直接回中文錯誤，不嘗試自動啟動', async () => {
  const deps = fakeDeps({ platform: 'linux' });
  await expect(ensureDockerRunning(deps)).rejects.toThrow(/Docker 引擎未啟動/);
  expect(deps.execFileSync.mock.calls.some(isStart)).toBe(false);
});
