const {
  checkCli, ensureLogin, ensureMcpServer, ensurePlugins, ensureClaudeEnv,
} = require('../../../scripts/lib/claude-env');

describe('checkCli', () => {
  test('claude --version 成功時跳過安裝', () => {
    const execFileSync = jest.fn(() => 'claude 1.0.0');
    const result = checkCli({ execFileSync });
    expect(result).toEqual({ name: 'cli', status: 'skipped' });
  });

  test('claude --version 失敗時執行 npm i -g 安裝 CLI', () => {
    const execFileSync = jest.fn((cmd) => {
      if (cmd === 'claude') throw new Error('not found');
      return '';
    });
    const result = checkCli({ execFileSync });
    expect(result).toEqual({ name: 'cli', status: 'done' });
    expect(execFileSync).toHaveBeenCalledWith('npm', ['i', '-g', '@anthropic-ai/claude-code'], expect.any(Object));
  });
});

describe('ensureLogin', () => {
  test('claude mcp list 成功時視為已登入，跳過互動登入', () => {
    const execFileSync = jest.fn(() => '');
    const spawnSync = jest.fn();
    const result = ensureLogin({ execFileSync, spawnSync });
    expect(result).toEqual({ name: 'login', status: 'skipped' });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('未登入時跑互動登入，成功後回報 done', () => {
    let attempt = 0;
    const execFileSync = jest.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('not logged in');
      return '';
    });
    const spawnSync = jest.fn(() => ({ status: 0 }));
    const result = ensureLogin({ execFileSync, spawnSync });
    expect(result).toEqual({ name: 'login', status: 'done' });
    expect(spawnSync).toHaveBeenCalledWith('claude', [], { stdio: 'inherit' });
  });

  test('互動登入後仍偵測不到登入狀態時丟出錯誤', () => {
    const execFileSync = jest.fn(() => { throw new Error('not logged in'); });
    const spawnSync = jest.fn(() => ({ status: 0 }));
    expect(() => ensureLogin({ execFileSync, spawnSync })).toThrow(/登入未完成/);
  });
});

describe('ensureMcpServer', () => {
  test('serena 已在 claude mcp list 中時跳過註冊', () => {
    const execFileSync = jest.fn(() => 'serena  connected');
    const result = ensureMcpServer({ execFileSync });
    expect(result).toEqual({ name: 'mcp-serena', status: 'skipped' });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  test('serena 不在清單中時執行 claude mcp add', () => {
    const execFileSync = jest.fn((cmd, args) => (args[0] === 'mcp' && args[1] === 'list') ? '' : '');
    const result = ensureMcpServer({ execFileSync });
    expect(result).toEqual({ name: 'mcp-serena', status: 'done' });
    expect(execFileSync).toHaveBeenCalledWith('claude', expect.arrayContaining(['mcp', 'add', '--scope', 'user', 'serena']), expect.any(Object));
  });
});

describe('ensurePlugins', () => {
  test('marketplace 與全部 plugin 都已安裝時全部 skipped', () => {
    const installed = [
      'claude-plugins-official',
      'superpowers@claude-plugins-official',
      'hookify@claude-plugins-official',
      'code-review@claude-plugins-official',
      'context7@claude-plugins-official',
      'security-guidance@claude-plugins-official',
    ].join('\n');
    const execFileSync = jest.fn(() => installed);
    const results = ensurePlugins({ execFileSync });
    expect(results.every(r => r.status === 'skipped')).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1); // 只查詢一次 plugin list
  });

  test('缺 marketplace 與部分 plugin 時補裝', () => {
    const execFileSync = jest.fn((cmd, args) => {
      if (args[0] === 'plugin' && args[1] === 'list') return 'superpowers@claude-plugins-official';
      return '';
    });
    const results = ensurePlugins({ execFileSync });
    const calls = execFileSync.mock.calls.map(c => c[1].join(' '));
    expect(calls.some(c => c.includes('marketplace add anthropics/claude-plugins-official'))).toBe(true);
    expect(results.find(r => r.name === 'hookify@claude-plugins-official').status).toBe('done');
    expect(results.find(r => r.name === 'superpowers@claude-plugins-official').status).toBe('skipped');
  });
});

describe('ensureClaudeEnv', () => {
  test('全部條件已就緒時依序回報四個 skipped 步驟', async () => {
    const execFileSync = jest.fn((cmd, args) => {
      if (cmd === 'claude' && args[0] === '--version') return 'claude 1.0.0';
      if (args[0] === 'mcp' && args[1] === 'list') return 'serena  connected';
      if (args[0] === 'plugin' && args[1] === 'list') {
        return [
          'claude-plugins-official',
          'superpowers@claude-plugins-official',
          'hookify@claude-plugins-official',
          'code-review@claude-plugins-official',
          'context7@claude-plugins-official',
          'security-guidance@claude-plugins-official',
        ].join('\n');
      }
      return '';
    });
    const spawnSync = jest.fn();
    const result = await ensureClaudeEnv({ execFileSync, spawnSync });
    expect(result.steps.map(s => s.name)).toEqual(['cli', 'login', 'mcp-serena', 'superpowers@claude-plugins-official', 'hookify@claude-plugins-official', 'code-review@claude-plugins-official', 'context7@claude-plugins-official', 'security-guidance@claude-plugins-official']);
    expect(result.steps.every(s => s.status === 'skipped')).toBe(true);
  });
});
