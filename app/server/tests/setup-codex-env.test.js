const { ensureCodexCli } = require('../../../scripts/lib/codex-env');

describe('ensureCodexCli', () => {
  test('codex --version 成功時跳過安裝', () => {
    const execFileSync = jest.fn(() => 'codex 1.0.0');

    expect(ensureCodexCli({ execFileSync })).toEqual({ name: 'cli', status: 'skipped' });
    expect(execFileSync).toHaveBeenCalledWith('codex', ['--version'], { stdio: 'pipe' });
  });

  test('找不到 Codex CLI 時以官方 npm 套件補裝', () => {
    const execFileSync = jest.fn((cmd) => {
      if (cmd === 'codex') throw new Error('not found');
      return '';
    });

    expect(ensureCodexCli({ execFileSync })).toEqual({ name: 'cli', status: 'done' });
    expect(execFileSync).toHaveBeenCalledWith('npm', ['i', '-g', '@openai/codex'], { stdio: 'inherit' });
  });
});
