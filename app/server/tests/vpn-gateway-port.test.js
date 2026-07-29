const { allocateForwardPort, projectContainerName, targetHostPort } = require('../lib/vpn-gateway');

describe('allocateForwardPort', () => {
  test('沒有已佔用 port 時回傳範圍起點 22000', () => {
    expect(allocateForwardPort([])).toBe(22000);
  });

  test('挑選未被佔用的最小 port', () => {
    expect(allocateForwardPort([22000, 22001, 22003])).toBe(22002);
  });

  test('未傳入 usedPorts 時視為空陣列', () => {
    expect(allocateForwardPort()).toBe(22000);
  });

  // 這是本次改動的核心：同專案打去同一台機器的連線必須共用同一個轉發埠，
  // 否則每加一條連線就多一個 publish port，容器得重建（＝斷線重撥）。
  test('同專案已有連線指向同一個 host:port 時，沿用它的埠而不是配新的', () => {
    const projectTargets = [{ host: '192.168.1.233', port: 22, forwardPort: 22000 }];
    const got = allocateForwardPort([22000], projectTargets, { host: '192.168.1.233', port: 22 });
    expect(got).toBe(22000);
  });

  test('目標的 port 型別不同（字串 vs 數字）仍視為同一個目標', () => {
    const projectTargets = [{ host: '192.168.1.240', port: 1433, forwardPort: 22001 }];
    const got = allocateForwardPort([22001], projectTargets, { host: '192.168.1.240', port: '1433' });
    expect(got).toBe(22001);
  });

  test('同專案沒有相同目標時，配一個全域未使用的新埠', () => {
    const projectTargets = [{ host: '192.168.1.233', port: 22, forwardPort: 22000 }];
    const got = allocateForwardPort([22000], projectTargets, { host: '192.168.1.240', port: 1433 });
    expect(got).toBe(22001);
  });

  test('範圍全滿時丟出中文錯誤', () => {
    const all = Array.from({ length: 1000 }, (_, i) => 22000 + i);
    expect(() => allocateForwardPort(all)).toThrow(/沒有可用的 VPN 轉發 port/);
  });
});

describe('projectContainerName', () => {
  test('依專案 id 產生固定容器名稱', () => {
    expect(projectContainerName(2)).toBe('vpn-proj-2');
  });
});

describe('targetHostPort', () => {
  test('docker 模式取 ssh_host/ssh_port', () => {
    expect(targetHostPort({ connect_mode: 'docker', ssh_host: '1.2.3.4', ssh_port: 22 }))
      .toEqual({ host: '1.2.3.4', port: 22 });
  });

  test('direct 模式取 db_host/db_port', () => {
    expect(targetHostPort({ connect_mode: 'direct', db_host: '5.6.7.8', db_port: 1433 }))
      .toEqual({ host: '5.6.7.8', port: 1433 });
  });
});
