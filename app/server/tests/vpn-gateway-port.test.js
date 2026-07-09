const { allocateForwardPort, containerName } = require('../lib/vpn-gateway');

describe('allocateForwardPort', () => {
  test('沒有已佔用 port 時回傳範圍起點 11000', () => {
    expect(allocateForwardPort([])).toBe(11000);
  });

  test('挑選未被佔用的最小 port', () => {
    expect(allocateForwardPort([11000, 11001, 11003])).toBe(11002);
  });

  test('未傳入 usedPorts 時視為空陣列', () => {
    expect(allocateForwardPort()).toBe(11000);
  });

  test('範圍全滿時丟出中文錯誤', () => {
    const all = Array.from({ length: 1000 }, (_, i) => 11000 + i);
    expect(() => allocateForwardPort(all)).toThrow(/沒有可用的 VPN 轉發 port/);
  });
});

describe('containerName', () => {
  test('依連線 id 產生固定容器名稱', () => {
    expect(containerName(42)).toBe('vpn-conn-42');
  });
});
