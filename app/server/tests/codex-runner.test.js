const { EventEmitter } = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));

function child() {
  const c = new EventEmitter();
  c.pid = 88;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  c.kill = jest.fn();
  return c;
}

test('runCodex：JSONL 事件轉成共用回傳形狀，並傳遞 model/effort', async () => {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runCodex } = require('../pipeline/codex-runner');
  const p = runCodex('請回覆', { model: 'gpt-5.6-terra', effort: 'high', agentType: 'workflow_health' });

  c.stdout.emit('data', [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<result>{"ok":true}</result>' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 2, output_tokens: 4 } })
  ].join('\n') + '\n');
  c.emit('close', 0);

  const out = await p;
  expect(spawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['exec', '-', '--json', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="high"']), expect.any(Object));
  // 訂閱模式不得因正式機殘留的 API key 靜默轉成按量計費。
  expect(spawn.mock.calls[0][2].env.OPENAI_API_KEY).toBeUndefined();
  expect(spawn.mock.calls[0][2].env.CODEX_API_KEY).toBeUndefined();
  expect(out.sessionId).toBe('thread-1');
  expect(out.assistantText).toContain('<result>');
  expect(out.usage).toMatchObject({ model: 'gpt-5.6-terra', provider: 'codex', cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
});

test('runCodex：turn.failed 無 usage 不會被當成成功', async () => {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runCodex } = require('../pipeline/codex-runner');
  const p = runCodex('p', {});
  c.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { message: '401 Unauthorized: Missing bearer or basic authentication' } }) + '\n');
  c.emit('close', 1);
  const err = await p.then(() => null, e => e);
  expect(err.claudeStatus).toBe('auth');
  expect(err.message).toContain('401 Unauthorized');
});
