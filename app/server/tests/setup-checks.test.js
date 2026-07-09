// app/server/tests/setup-checks.test.js
const { verifyRuntimeDeps } = require('../../../scripts/lib/checks');

describe('verifyRuntimeDeps', () => {
  test('git/python/uv/chrome 都在時回報 ok:true、missing 為空', () => {
    const result = verifyRuntimeDeps({
      commandExists: () => true,
      findChrome: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    expect(result).toEqual({ ok: true, missing: [] });
  });

  test('缺 git 時列出 git 與安裝指引', () => {
    const result = verifyRuntimeDeps({
      commandExists: (cmd) => cmd !== 'git',
      findChrome: () => 'chrome.exe',
    });
    expect(result.ok).toBe(false);
    expect(result.missing.find(m => m.name === 'git')).toBeTruthy();
  });

  test('找不到 chrome 時列在 missing', () => {
    const result = verifyRuntimeDeps({
      commandExists: () => true,
      findChrome: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.missing.find(m => m.name === 'chrome')).toBeTruthy();
  });

  test('缺 psql 時列出 psql 與安裝指引', () => {
    const result = verifyRuntimeDeps({
      commandExists: (cmd) => cmd !== 'psql',
      findChrome: () => 'chrome.exe',
    });
    expect(result.ok).toBe(false);
    expect(result.missing.find(m => m.name === 'psql')).toBeTruthy();
  });
});
