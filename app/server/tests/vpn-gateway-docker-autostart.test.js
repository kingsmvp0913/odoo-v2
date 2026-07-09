// Docker daemon 沒啟動時，Windows 上自動背景啟動 Docker Desktop 並輪詢等待就緒。
const { ensureDockerRunning } = require('../lib/vpn-gateway');

function fakeDeps(overrides = {}) {
  return {
    execFileSync: jest.fn(() => { throw new Error('daemon not reachable'); }),
    spawn: jest.fn(() => ({ unref: jest.fn() })),
    sleep: jest.fn().mockResolvedValue(),
    platform: 'win32',
    ...overrides,
  };
}

test('daemon 已啟動時直接回傳，不嘗試啟動、不輪詢', async () => {
  const deps = fakeDeps({ execFileSync: jest.fn(() => '') });
  await ensureDockerRunning(deps);
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(deps.sleep).not.toHaveBeenCalled();
});

test('Windows 上 daemon 未啟動時，背景啟動 Docker Desktop 並輪詢直到成功', async () => {
  let calls = 0;
  const execFileSync = jest.fn(() => {
    calls += 1;
    if (calls <= 2) throw new Error('daemon not reachable'); // 前兩次檢查仍未就緒
    return ''; // 第三次成功
  });
  const deps = fakeDeps({ execFileSync });
  await ensureDockerRunning(deps);

  expect(deps.spawn).toHaveBeenCalledWith('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', [], expect.objectContaining({ detached: true }));
  expect(deps.sleep).toHaveBeenCalledTimes(2); // 輪詢兩次後第三次才成功
});

test('90 秒內都沒就緒時，丟出中文逾時錯誤', async () => {
  const deps = fakeDeps(); // execFileSync 永遠丟錯，sleep 直接 resolve（不真的等）
  await expect(ensureDockerRunning(deps)).rejects.toThrow(/Docker 引擎啟動逾時/);
});

test('非 Windows 平台時，daemon 沒啟動直接回中文錯誤，不嘗試自動啟動', async () => {
  const deps = fakeDeps({ platform: 'linux' });
  await expect(ensureDockerRunning(deps)).rejects.toThrow(/Docker 引擎未啟動/);
  expect(deps.spawn).not.toHaveBeenCalled();
});
