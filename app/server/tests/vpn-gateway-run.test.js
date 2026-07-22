const { ensureGatewayRunning } = require('../lib/vpn-gateway');

const baseConn = {
  id: 7, vpn_forward_port: 11007, vpn_container_name: 'vpn-conn-7',
  connect_mode: 'docker', ssh_host: '1.2.3.4', ssh_port: 22,
  vpn_config: 'client\ndev tun\n...', vpn_username: 'u1', vpn_password: 'p1',
};

function fakeDeps(overrides = {}) {
  return {
    execFileSync: jest.fn((cmd, args) => { // 預設：docker daemon 已啟動、image 已 build 過、容器不存在（inspect 失敗），其餘呼叫（如 run）成功
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc123\n';
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: jest.fn(() => 'C:\\tmp\\vpn-7.ovpn'),
    waitReachable: jest.fn().mockResolvedValue(),
    ...overrides,
  };
}

test('容器已在跑時，直接回傳 forwardPort，不重新啟動也不等待', async () => {
  const deps = fakeDeps({ execFileSync: jest.fn(() => 'true\n') }); // docker info/inspect 皆回成功
  const result = await ensureGatewayRunning(baseConn, deps);
  expect(result).toEqual({ forwardPort: 11007 });
  expect(deps.execFileSync).toHaveBeenCalledTimes(2); // docker info（daemon 檢查）+ docker inspect
  expect(deps.execFileSync.mock.calls.some(c => c[1][0] === 'run')).toBe(false);
  expect(deps.waitReachable).not.toHaveBeenCalled();
  expect(deps.writeFileSync).not.toHaveBeenCalled();
});

test('容器不存在時，寫入設定檔、docker run 啟動、等待轉發 port 就緒', async () => {
  const deps = fakeDeps();
  const result = await ensureGatewayRunning(baseConn, deps);

  expect(result).toEqual({ forwardPort: 11007 });
  expect(deps.writeFileSync).toHaveBeenCalledWith('C:\\tmp\\vpn-7.ovpn', 'client\ndev tun\n...', { mode: 0o600 });

  const runCall = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run');
  expect(runCall).toBeTruthy();
  const args = runCall[1];
  expect(args).toContain('--name');
  expect(args).toContain('vpn-conn-7');
  expect(args).toContain('--cap-add=NET_ADMIN');
  // openvpn 在容器內要建立 tun0 必須存取 /dev/net/tun 裝置節點；只給 NET_ADMIN capability
  // 而不掛入該裝置，會在撥通後倒在 "Cannot open TUN/TAP dev /dev/net/tun"，tun0 永遠不出現。
  const devIdx = args.indexOf('--device');
  expect(devIdx).toBeGreaterThanOrEqual(0);
  expect(args[devIdx + 1]).toBe('/dev/net/tun');
  expect(args).toContain('-p');
  expect(args).toContain('127.0.0.1:11007:9999');
  expect(args).toContain('-v');
  expect(args).toContain('C:\\tmp\\vpn-7.ovpn:/config/client.ovpn:ro');
  expect(args).toContain('VPN_USER=u1');
  expect(args).toContain('VPN_PASS=p1');
  expect(args).toContain('TARGET_HOST=1.2.3.4');
  expect(args).toContain('TARGET_PORT=22');

  // 最後一次 rmSync（真正代表「容器已就緒、可以安全清除」的那次）要用 recursive+force，
  // 這樣就算殘留的是目錄（如 docker 曾經把不存在的來源路徑掛成空目錄）也能清乾淨。
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-7.ovpn', { recursive: true, force: true });
  // 就緒判斷改為「隧道真的連得到目標」（docker 模式用 ssh_host/ssh_port），而非只看轉發 port 可連——
  // 後者會被 docker userland proxy 的即時接受騙，導致過早清掉 .ovpn。
  expect(deps.waitReachable).toHaveBeenCalledWith('vpn-conn-7', '1.2.3.4', 22, 40000, expect.anything());
});

test('暫存 .ovpn 檔案要等就緒檢查完成才清除，不能在 docker run 一回傳就刪（避免容器還沒讀到檔案就被清掉）', async () => {
  const callOrder = [];
  const deps = fakeDeps({
    rmSync: jest.fn(() => callOrder.push('rmSync')),
    waitReachable: jest.fn(async () => { callOrder.push('waitReachable'); }),
  });
  await ensureGatewayRunning(baseConn, deps);
  // 第一次 rmSync 是寫入前的殘留物防呆清除，發生在就緒檢查之前很正常；
  // 真正代表「容器已就緒、可以安全刪除」的是最後一次 rmSync，必須排在 waitReachable 之後。
  expect(callOrder[callOrder.length - 1]).toBe('rmSync');
  expect(callOrder[callOrder.length - 2]).toBe('waitReachable');
});

test('direct 模式時，TARGET_HOST/TARGET_PORT 用 db_host/db_port 而非 ssh_host/ssh_port', async () => {
  const directConn = { ...baseConn, connect_mode: 'direct', db_host: 'db.example.com', db_port: 5432 };
  const deps = fakeDeps();
  await ensureGatewayRunning(directConn, deps);

  const runCall = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run');
  const args = runCall[1];
  expect(args).toContain('TARGET_HOST=db.example.com');
  expect(args).toContain('TARGET_PORT=5432');
});

test('VPN 帳密留空時，環境變數仍帶入空字串（不丟出錯誤）', async () => {
  const noAuthConn = { ...baseConn, vpn_username: undefined, vpn_password: undefined };
  const deps = fakeDeps();
  await ensureGatewayRunning(noAuthConn, deps);

  const runCall = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run');
  const args = runCall[1];
  expect(args).toContain('VPN_USER=');
  expect(args).toContain('VPN_PASS=');
});

test('隧道逾時未能連到目標時，錯誤往外拋且訊息含中文提示', async () => {
  const deps = fakeDeps({
    waitReachable: jest.fn().mockRejectedValue(new Error('VPN 連線逾時（40 秒內未能透過隧道連到 1.2.3.4:22），請確認 VPN 帳號密碼與設定檔是否正確')),
  });
  await expect(ensureGatewayRunning(baseConn, deps)).rejects.toThrow(/VPN 連線逾時/);
});

test('暫存設定檔在 docker run 失敗時仍會被清除', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'inspect') throw new Error('No such object');
      if (args[0] === 'run') throw new Error('docker daemon not running');
      return '';
    }),
  });
  await expect(ensureGatewayRunning(baseConn, deps)).rejects.toThrow(/docker daemon not running/);
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-7.ovpn', { recursive: true, force: true });
});

test('image 已存在時（docker images -q 有回傳值），不會再 build', async () => {
  const deps = fakeDeps(); // 預設 fixture 的 images 已回傳 hash，代表已 build 過
  await ensureGatewayRunning(baseConn, deps);
  expect(deps.execFileSync.mock.calls.some(c => c[1][0] === 'build')).toBe(false);
});

test('容器名稱衝突（殘留容器）：docker run 之前會先 docker stop（優雅斷線）再 docker rm -f 同名容器', async () => {
  const deps = fakeDeps();
  await ensureGatewayRunning(baseConn, deps);

  const stopIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'stop');
  const rmIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'rm');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(deps.execFileSync.mock.calls[stopIdx][1]).toEqual(['stop', '-t', '5', 'vpn-conn-7']);
  expect(rmIdx).toBeGreaterThanOrEqual(0);
  expect(deps.execFileSync.mock.calls[rmIdx][1]).toEqual(['rm', '-f', 'vpn-conn-7']);
  expect(stopIdx).toBeLessThan(rmIdx); // 一定先 stop 再 rm
  expect(runIdx).toBeGreaterThan(rmIdx); // 清殘留容器一定發生在 run 之前
});

test('清殘留容器時若容器本來就不存在（stop/rm 皆失敗），不影響後續 docker run', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc123\n';
      if (args[0] === 'inspect') throw new Error('No such object');
      if (args[0] === 'stop') throw new Error('No such container');
      if (args[0] === 'rm') throw new Error('No such container');
      return '';
    }),
  });
  const result = await ensureGatewayRunning(baseConn, deps);
  expect(result).toEqual({ forwardPort: 11007 });
  expect(deps.execFileSync.mock.calls.some(c => c[1][0] === 'run')).toBe(true);
});

test('不注入 waitReachable 時走實際就緒檢查：容器在跑且 nc 探測成功即完成，探測打的是目標 host/port', async () => {
  let started = false;
  const deps = {
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc\n';
      if (args[0] === 'run') { started = true; return ''; }
      // 啟動前的存在性檢查回 false（去啟動）；啟動後的就緒輪詢回 true（在跑）
      if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return started ? 'true\n' : 'false\n';
      return '';
    }),
    execFile: jest.fn((cmd, args, cb) => cb(null)), // nc 探測成功（隧道可達目標）
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: () => 'C:\\tmp\\vpn-7.ovpn',
  };
  const result = await ensureGatewayRunning(baseConn, deps);
  expect(result).toEqual({ forwardPort: 11007 });
  const probe = deps.execFile.mock.calls.find(c => c[1][0] === 'exec');
  expect(probe[1]).toEqual(['exec', 'vpn-conn-7', 'nc', '-z', '-w', '2', '1.2.3.4', '22']);
});

test('不注入 waitReachable 時，容器撥號中途退出：撈 docker logs 併入錯誤訊息，fail loud 不傻等到逾時', async () => {
  const deps = {
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc\n';
      if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return 'false\n'; // 容器不在跑
      if (args[0] === 'logs') return 'AUTH: Received control message: AUTH_FAILED\n';
      return '';
    }),
    execFile: jest.fn((cmd, args, cb) => cb(new Error('nc: bad address'))),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: () => 'C:\\tmp\\vpn-7.ovpn',
  };
  await expect(ensureGatewayRunning(baseConn, deps)).rejects.toThrow(/AUTH_FAILED/);
  // 失敗時暫存檔仍要清掉
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-7.ovpn', { recursive: true, force: true });
});

test('image 不存在時（docker images -q 空字串），docker run 之前會先 build image', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return ''; // 空字串＝尚未 build 過
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
  });
  await ensureGatewayRunning(baseConn, deps);

  const buildIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'build');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  expect(buildIdx).toBeGreaterThanOrEqual(0);
  expect(runIdx).toBeGreaterThan(buildIdx); // build 一定發生在 run 之前
  expect(deps.execFileSync.mock.calls[buildIdx][1]).toEqual(
    expect.arrayContaining(['build', '-t', 'odoo-v2-vpn-gateway:latest'])
  );
});
