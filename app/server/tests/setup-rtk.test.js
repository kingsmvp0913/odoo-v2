const path = require('path');
const { ensureRtk, assetFor } = require('../../../scripts/lib/rtk');

function makeDeps(overrides = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    home: '/home/tester',
    mkdirSync: jest.fn(),
    chmodSync: jest.fn(),
    ...overrides,
  };
}

describe('ensureRtk', () => {
  test('已裝好的不重裝', () => {
    const execFileSync = jest.fn(() => 'saved 1000 tokens');

    expect(ensureRtk(makeDeps({ execFileSync }))).toEqual({ name: 'rtk', status: 'skipped', detail: '已安裝' });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  test('用 rtk gain 驗身分，不是只看指令在不在——同名的 Rust Type Kit 沒有這個子指令', () => {
    const execFileSync = jest.fn(() => '');

    ensureRtk(makeDeps({ execFileSync }));

    expect(execFileSync).toHaveBeenCalledWith('rtk', ['gain'], { stdio: 'pipe' });
  });

  test('沒裝時下載官方預編譯檔到 ~/.local/bin 並給執行權限', () => {
    const chmodSync = jest.fn();
    const execFileSync = jest.fn((cmd) => {
      if (cmd === 'rtk') throw new Error('not found');
      return '';
    });

    const r = ensureRtk(makeDeps({ execFileSync, chmodSync }));

    expect(r.status).toBe('done');
    const script = execFileSync.mock.calls[1][1][1];
    expect(script).toContain('rtk-x86_64-unknown-linux-musl.tar.gz');
    // pipefail 少了會讓 curl 失敗仍回 0，裝出「成功但沒有檔案」的假象
    expect(script).toContain('set -o pipefail');
    expect(chmodSync).toHaveBeenCalledWith(path.join('/home/tester', '.local', 'bin', 'rtk'), 0o755);
  });

  test('下載失敗只回報，不讓整個安裝中斷——rtk 缺了平台照樣能跑', () => {
    const execFileSync = jest.fn(() => { throw new Error('network down'); });

    const r = ensureRtk(makeDeps({ execFileSync }));

    expect(r.status).toBe('failed');
    expect(r.detail).toContain('github.com/rtk-ai/rtk');
  });

  test('沒有官方預編譯檔的平台（如 Windows）給連結後跳過', () => {
    const execFileSync = jest.fn(() => { throw new Error('not found'); });

    const r = ensureRtk(makeDeps({ execFileSync, platform: 'win32' }));

    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('win32-x64');
  });

  test('依平台與架構挑對應的預編譯檔', () => {
    expect(assetFor('darwin', 'arm64')).toBe('rtk-aarch64-apple-darwin.tar.gz');
    expect(assetFor('linux', 'arm64')).toBe('rtk-aarch64-unknown-linux-gnu.tar.gz');
    expect(assetFor('win32', 'x64')).toBeNull();
  });
});
