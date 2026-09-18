const { verifyDocker, ensureGatewayImage, ensureAgentImage } = require('../../../scripts/lib/docker');

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

// 一鍵安裝原本只建 VPN gateway 映像，AI 沙盒映像全 repo 沒人建——新機器裝完，沙盒模式不是 off
// 就每一次 AI 呼叫都失敗。這組守住「安裝時會建、而且 tag 與 build-arg 都對」。
describe('ensureAgentImage', () => {
  const okDeps = (over = {}) => ({
    readFileSync: () => JSON.stringify({ version: '3.2.3' }),
    dockerfileDir: '/repo/docker/agent',
    ...over,
  });

  test('映像已存在 → 不 build，只讀 claude 版本與查一次 images', () => {
    const execFileSync = jest.fn((cmd) => (cmd === 'claude' ? '2.1.267 (Claude Code)\n' : 'sha256:abc\n'));
    expect(ensureAgentImage(okDeps({ execFileSync }))).toEqual({ built: false, image: 'aidev-agent:2.1.267' });
    expect(execFileSync.mock.calls.some(c => c[1][0] === 'build')).toBe(false);
  });

  // tag 綁 claude 版本：版本讀錯就會建出一顆執行期永遠找不到的映像
  test('映像不存在 → 用 claude 版本當 tag，並把 claude／context7 版本都帶進 build-arg', () => {
    const execFileSync = jest.fn((cmd, args) => {
      if (cmd === 'claude') return '2.1.267 (Claude Code)\n';
      if (args[0] === 'images') return '';
      return '';
    });
    expect(ensureAgentImage(okDeps({ execFileSync }))).toEqual({ built: true, image: 'aidev-agent:2.1.267' });
    const build = execFileSync.mock.calls.find(c => c[1][0] === 'build')[1];
    expect(build).toEqual(expect.arrayContaining([
      '-f', '/repo/docker/agent/Dockerfile',
      '--build-arg', 'CLAUDE_CODE_VERSION=2.1.267',
      '--build-arg', 'CONTEXT7_MCP_VERSION=3.2.3',
      '-t', 'aidev-agent:2.1.267',
    ]));
  });

  test('讀不到 claude 版本 → 丟錯，不 build（不可以拿空字串當 tag 建出一顆沒人用的映像）', () => {
    const execFileSync = jest.fn(() => 'command not found');
    expect(() => ensureAgentImage(okDeps({ execFileSync }))).toThrow(/claude 版本/);
    expect(execFileSync.mock.calls.some(c => c[1][0] === 'build')).toBe(false);
  });
});
