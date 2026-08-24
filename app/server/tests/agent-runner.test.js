jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn(), abortError: jest.fn(), stopReason: jest.fn() }));
jest.mock('../pipeline/codex-runner', () => ({ runCodex: jest.fn() }));

test('runAgent：依 provider 分派，省略時維持 Claude', () => {
  const { runClaude } = require('../pipeline/claude-runner');
  const { runCodex } = require('../pipeline/codex-runner');
  runClaude.mockReturnValue('claude'); runCodex.mockReturnValue('codex');
  const { runAgent } = require('../pipeline/agent-runner');
  expect(runAgent('a', {})).toBe('claude');
  expect(runAgent('b', { provider: 'codex' })).toBe('codex');
  expect(() => runAgent('c', { provider: 'unknown' })).toThrow('不支援的 provider');
});
