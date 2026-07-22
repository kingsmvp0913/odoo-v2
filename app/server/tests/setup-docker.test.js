const { verifyDocker, ensureGatewayImage } = require('../../../scripts/lib/docker');

describe('verifyDocker', () => {
  test('docker info 成功時回報 ok:true', () => {
    const execFileSync = jest.fn(() => '');
    expect(verifyDocker({ execFileSync })).toEqual({ ok: true });
  });

  test('docker 未安裝（ENOENT）時提示安裝', () => {
    const execFileSync = jest.fn(() => { const e = new Error('spawn docker ENOENT'); e.code = 'ENOENT'; throw e; });
    const result = verifyDocker({ execFileSync });
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/安裝.*Docker/);
  });

  test('已安裝但無權存取 socket 時提示加入 docker 群組（非誤報未安裝）', () => {
    const execFileSync = jest.fn(() => { const e = new Error('exit 1'); e.stderr = 'permission denied while trying to connect to the Docker daemon socket'; throw e; });
    const result = verifyDocker({ execFileSync });
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/usermod -aG docker/);
  });

  test('已安裝但 daemon 沒起時提示啟動服務', () => {
    const execFileSync = jest.fn(() => { const e = new Error('exit 1'); e.stderr = 'Cannot connect to the Docker daemon'; throw e; });
    const result = verifyDocker({ execFileSync });
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/daemon 連不上/);
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
