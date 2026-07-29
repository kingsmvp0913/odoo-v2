const { ensureGatewayRunning } = require('../lib/vpn-gateway');

// 鴻久的真實形狀：兩個目標（Odoo 那台走 ssh、SM 那台走 mssql），共用一條隧道。
const baseGw = {
  containerName: 'vpn-proj-2',
  config: 'client\ndev tun\n...',
  username: 'u1',
  password: 'p1',
  targets: [
    { forwardPort: 22000, host: '192.168.1.233', port: 22 },
    { forwardPort: 22001, host: '192.168.1.240', port: 1433 },
  ],
  staleContainers: [],
};
const SPEC = '22000:192.168.1.233:22,22001:192.168.1.240:1433';

function fakeDeps(overrides = {}) {
  return {
    // 預設：daemon 已啟動、image 已 build、容器不存在（inspect 失敗）
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc123\n';
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: jest.fn(() => 'C:\\tmp\\vpn-proj-2.ovpn'),
    waitReachable: jest.fn().mockResolvedValue(),
    ...overrides,
  };
}

// 容器在跑、且 label 指紋等於現在需要的目標集合 → 直接沿用（inspect 兩次：Running + Labels）
function runningWithSpec(spec) {
  return jest.fn((cmd, args) => {
    if (args[0] === 'info') return '';
    if (args[0] === 'images') return 'sha256:abc123\n';
    if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return 'true\n';
    if (args[0] === 'inspect' && String(args[2] || '').includes('Labels')) return `${spec}\n`;
    return '';
  });
}

test('容器已在跑且目標指紋相同時，直接沿用，不重建也不等待', async () => {
  const deps = fakeDeps({ execFileSync: runningWithSpec(SPEC) });
  const result = await ensureGatewayRunning(baseGw, deps);
  expect(result).toEqual({ containerName: 'vpn-proj-2', targetsSpec: SPEC });
  expect(deps.execFileSync.mock.calls.some(c => c[1][0] === 'run')).toBe(false);
  expect(deps.waitReachable).not.toHaveBeenCalled();
  expect(deps.writeFileSync).not.toHaveBeenCalled();
});

// 這是共用容器方案唯一「必須重建」的情境：使用者新增了打去第三台機器的連線。
test('容器在跑但目標指紋不同時（多了新目標），先 stop+rm 再重建', async () => {
  const deps = fakeDeps({ execFileSync: runningWithSpec('22000:192.168.1.233:22') });
  await ensureGatewayRunning(baseGw, deps);

  const stopIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'stop');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(runIdx).toBeGreaterThan(stopIdx);
});

test('容器不存在時：寫設定檔、多目標 docker run、等待就緒', async () => {
  const deps = fakeDeps();
  const result = await ensureGatewayRunning(baseGw, deps);

  expect(result).toEqual({ containerName: 'vpn-proj-2', targetsSpec: SPEC });
  expect(deps.writeFileSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', 'client\ndev tun\n...', { mode: 0o600 });

  const args = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run')[1];
  expect(args).toContain('--name');
  expect(args).toContain('vpn-proj-2');
  expect(args).toContain('--cap-add=NET_ADMIN');
  // openvpn 要建 tun0 必須掛 /dev/net/tun；只給 NET_ADMIN 會倒在 "Cannot open TUN/TAP dev"。
  // 這是既有的血淚修正（commit 4044c5e），改多目標時不可退化。
  const devIdx = args.indexOf('--device');
  expect(devIdx).toBeGreaterThanOrEqual(0);
  expect(args[devIdx + 1]).toBe('/dev/net/tun');
  // 每個目標各 publish 一個埠，且容器內 listen 埠＝主機埠（省掉對照層）
  expect(args).toContain('127.0.0.1:22000:22000');
  expect(args).toContain('127.0.0.1:22001:22001');
  expect(args).toContain('-v');
  expect(args).toContain('C:\\tmp\\vpn-proj-2.ovpn:/config/client.ovpn:ro');
  expect(args).toContain('VPN_USER=u1');
  expect(args).toContain('VPN_PASS=p1');
  expect(args).toContain(`TARGETS=${SPEC}`);
  expect(args).toContain(`targets=${SPEC}`);
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', { recursive: true, force: true });
});

test('指紋與 TARGETS 依 forwardPort 排序，與 targets 陣列的傳入順序無關', async () => {
  const reversed = { ...baseGw, targets: [...baseGw.targets].reverse() };
  const deps = fakeDeps();
  const result = await ensureGatewayRunning(reversed, deps);
  expect(result.targetsSpec).toBe(SPEC);
});

// 遷移的關鍵一步：舊的 vpn-conn-* 若留著，會用同一組帳號一直掛著一個 openvpn session，
// 新容器再撥就是同帳號雙重撥號，VPN 伺服器可能把兩邊都踢掉。
test('起容器前會先清掉 staleContainers 列出的舊容器', async () => {
  const gw = { ...baseGw, staleContainers: ['vpn-conn-1', 'vpn-conn-3'] };
  const deps = fakeDeps();
  await ensureGatewayRunning(gw, deps);

  const rmNames = deps.execFileSync.mock.calls.filter(c => c[1][0] === 'rm').map(c => c[1][2]);
  expect(rmNames).toContain('vpn-conn-1');
  expect(rmNames).toContain('vpn-conn-3');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  const lastRmIdx = deps.execFileSync.mock.calls.map(c => c[1][0]).lastIndexOf('rm');
  expect(runIdx).toBeGreaterThan(lastRmIdx);
});

test('清舊容器時容器本來就不存在（stop/rm 皆失敗），不影響後續 docker run', async () => {
  const gw = { ...baseGw, staleContainers: ['vpn-conn-1'] };
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc123\n';
      if (args[0] === 'inspect') throw new Error('No such object');
      if (args[0] === 'stop' || args[0] === 'rm') throw new Error('No such container');
      return '';
    }),
  });
  const result = await ensureGatewayRunning(gw, deps);
  expect(result.containerName).toBe('vpn-proj-2');
  expect(deps.execFileSync.mock.calls.some(c => c[1][0] === 'run')).toBe(true);
});

test('暫存 .ovpn 要等就緒檢查完成才清除（太早刪會讓 openvpn 開檔撲空）', async () => {
  const callOrder = [];
  const deps = fakeDeps({
    rmSync: jest.fn(() => callOrder.push('rmSync')),
    waitReachable: jest.fn(async () => { callOrder.push('waitReachable'); }),
  });
  await ensureGatewayRunning(baseGw, deps);
  expect(callOrder[callOrder.length - 1]).toBe('rmSync');
  expect(callOrder[callOrder.length - 2]).toBe('waitReachable');
});

test('VPN 帳密留空時，環境變數仍帶入空字串（不丟錯）', async () => {
  const deps = fakeDeps();
  await ensureGatewayRunning({ ...baseGw, username: undefined, password: undefined }, deps);
  const args = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run')[1];
  expect(args).toContain('VPN_USER=');
  expect(args).toContain('VPN_PASS=');
});

test('暫存設定檔在 docker run 失敗時仍會被清除', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'inspect') throw new Error('No such object');
      if (args[0] === 'run') throw new Error('docker daemon not running');
      return '';
    }),
  });
  await expect(ensureGatewayRunning(baseGw, deps)).rejects.toThrow(/docker daemon not running/);
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', { recursive: true, force: true });
});

test('image 不存在時，docker run 之前會先 build', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return '';
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
  });
  await ensureGatewayRunning(baseGw, deps);
  const buildIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'build');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  expect(buildIdx).toBeGreaterThanOrEqual(0);
  expect(runIdx).toBeGreaterThan(buildIdx);
});

// 就緒＝「任一目標可達」。若要求全部可達，SM 那台關機就會害整個 gateway 起不來，
// 連 Odoo 那條也不能查——個別目標不通應該留給該連線自己的查詢去報錯。
test('不注入 waitReachable 時：只要有一個目標 nc 探測成功就算就緒', async () => {
  let started = false;
  const deps = {
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc\n';
      if (args[0] === 'run') { started = true; return ''; }
      if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return started ? 'true\n' : 'false\n';
      if (args[0] === 'inspect' && String(args[2] || '').includes('Labels')) return '\n';
      return '';
    }),
    // 第一個目標不通、第二個通 → 仍算就緒
    execFile: jest.fn((cmd, args, cb) => cb(args[6] === '192.168.1.240' ? null : new Error('nc fail'))),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: () => 'C:\\tmp\\vpn-proj-2.ovpn',
  };
  const result = await ensureGatewayRunning(baseGw, deps);
  expect(result.containerName).toBe('vpn-proj-2');
  const probes = deps.execFile.mock.calls.filter(c => c[1][0] === 'exec').map(c => c[1]);
  expect(probes).toContainEqual(['exec', 'vpn-proj-2', 'nc', '-z', '-w', '2', '192.168.1.233', '22']);
  expect(probes).toContainEqual(['exec', 'vpn-proj-2', 'nc', '-z', '-w', '2', '192.168.1.240', '1433']);
});

test('不注入 waitReachable 時，容器撥號中途退出：撈 docker logs 併入錯誤，不傻等到逾時', async () => {
  const deps = {
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc\n';
      if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return 'false\n';
      if (args[0] === 'inspect' && String(args[2] || '').includes('Labels')) return '\n';
      if (args[0] === 'logs') return 'AUTH: Received control message: AUTH_FAILED\n';
      return '';
    }),
    execFile: jest.fn((cmd, args, cb) => cb(new Error('nc: bad address'))),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: () => 'C:\\tmp\\vpn-proj-2.ovpn',
  };
  await expect(ensureGatewayRunning(baseGw, deps)).rejects.toThrow(/AUTH_FAILED/);
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', { recursive: true, force: true });
});

test('逾時錯誤訊息要列出所有目標，方便判斷是哪台不通', async () => {
  const deps = fakeDeps({
    waitReachable: jest.fn().mockRejectedValue(
      new Error('VPN 連線逾時（40 秒內未能透過隧道連到 192.168.1.233:22、192.168.1.240:1433），請確認 VPN 帳號密碼與設定檔是否正確')
    ),
  });
  await expect(ensureGatewayRunning(baseGw, deps)).rejects.toThrow(/192\.168\.1\.240:1433/);
});
