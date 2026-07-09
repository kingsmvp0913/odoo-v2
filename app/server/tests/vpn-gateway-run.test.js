const { ensureGatewayRunning } = require('../lib/vpn-gateway');

const baseConn = {
  id: 7, vpn_forward_port: 11007, vpn_container_name: 'vpn-conn-7',
  connect_mode: 'docker', ssh_host: '1.2.3.4', ssh_port: 22,
  vpn_config: 'client\ndev tun\n...', vpn_username: 'u1', vpn_password: 'p1',
};

function fakeDeps(overrides = {}) {
  return {
    execFileSync: jest.fn((cmd, args) => { // 預設：容器不存在（inspect 失敗），其餘呼叫（如 run）成功
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: jest.fn(() => 'C:\\tmp\\vpn-7.ovpn'),
    waitForPort: jest.fn().mockResolvedValue(),
    ...overrides,
  };
}

test('容器已在跑時，直接回傳 forwardPort，不重新啟動也不等待', async () => {
  const deps = fakeDeps({ execFileSync: jest.fn(() => 'true\n') }); // docker inspect 回 running
  const result = await ensureGatewayRunning(baseConn, deps);
  expect(result).toEqual({ forwardPort: 11007 });
  expect(deps.execFileSync).toHaveBeenCalledTimes(1); // 只有 inspect
  expect(deps.waitForPort).not.toHaveBeenCalled();
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
  expect(args).toContain('-p');
  expect(args).toContain('127.0.0.1:11007:9999');
  expect(args).toContain('-v');
  expect(args).toContain('C:\\tmp\\vpn-7.ovpn:/config/client.ovpn:ro');
  expect(args).toContain('VPN_USER=u1');
  expect(args).toContain('VPN_PASS=p1');
  expect(args).toContain('TARGET_HOST=1.2.3.4');
  expect(args).toContain('TARGET_PORT=22');

  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-7.ovpn', { force: true });
  expect(deps.waitForPort).toHaveBeenCalledWith(11007, 25000);
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

test('轉發 port 逾時未就緒時，錯誤往外拋且訊息含中文提示', async () => {
  const deps = fakeDeps({
    waitForPort: jest.fn().mockRejectedValue(new Error('VPN 連線逾時（25 秒內轉發 port 未就緒），請確認 VPN 帳號密碼與設定檔是否正確')),
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
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-7.ovpn', { force: true });
});
