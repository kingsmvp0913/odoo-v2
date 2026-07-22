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

test('start 後仍連不上 daemon 時，丟出中文逾時錯誤', async () => {
  const deps = fakeDeps(); // execFileSync 永遠丟錯（含 start 失敗、info 不通）
  await expect(ensureDockerRunning(deps)).rejects.toThrow(/Docker 引擎啟動逾時/);
});

test('非 Windows 平台時，daemon 沒啟動直接回中文錯誤，不嘗試自動啟動', async () => {
  const deps = fakeDeps({ platform: 'linux' });
  await expect(ensureDockerRunning(deps)).rejects.toThrow(/Docker 引擎未啟動/);
  expect(deps.execFileSync.mock.calls.some(isStart)).toBe(false);
});
