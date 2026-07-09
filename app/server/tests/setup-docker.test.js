const { verifyDocker, ensureGatewayImage } = require('../../../scripts/lib/docker');

describe('verifyDocker', () => {
  test('docker info 成功時回報 ok:true', () => {
    const execFileSync = jest.fn(() => '');
    expect(verifyDocker({ execFileSync })).toEqual({ ok: true });
  });

  test('docker info 失敗時回報 ok:false 並附安裝提示', () => {
    const execFileSync = jest.fn(() => { throw new Error('not found'); });
    const result = verifyDocker({ execFileSync });
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/docker/i);
  });
});

describe('ensureGatewayImage', () => {
  test('image 已存在時跳過 build，只查詢一次', () => {
    const execFileSync = jest.fn(() => 'sha256:abc123\n');
    const result = ensureGatewayImage({ execFileSync });
    expect(result).toEqual({ built: false });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  test('image 不存在時執行 docker build', () => {
    const execFileSync = jest.fn((cmd, args) => (args[0] === 'images' ? '' : ''));
    const result = ensureGatewayImage({ execFileSync });
    expect(result).toEqual({ built: true });
    expect(execFileSync).toHaveBeenCalledWith('docker', expect.arrayContaining(['build', '-t', 'odoo-v2-vpn-gateway:latest']), expect.any(Object));
  });
});
