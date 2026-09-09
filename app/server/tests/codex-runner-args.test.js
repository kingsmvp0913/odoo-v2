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

// codex-cli 0.149.1 的 `exec resume` 不接受 --sandbox（unexpected argument、exit 2）。
// 帶著它送出＝每個續接輪必定死在 CLI 參數解析，with-resume 靜默降級成 fresh 重送整包，
// 外部零徵狀但續接從未成立。read-only 模式本身不得放寬，故改走等價的 -c 設定。
test('runCodex：resume 輪不得送出 --sandbox，改以 -c 設同一個 read-only', async () => {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runCodex } = require('../pipeline/codex-runner');
  const p = runCodex('續接', { resumeSessionId: 'sess-1', model: 'gpt-5.6-terra' });
  c.emit('close', 0);
  await p;

  const args = spawn.mock.calls.at(-1)[1];
  expect(args.slice(0, 5)).toEqual(['exec', 'resume', 'sess-1', '-', '--json']);
  expect(args).not.toContain('--sandbox');
  expect(args).toContain('sandbox_mode="read-only"');
  // resume 子指令接受這兩個，仍須帶著
  expect(args).toContain('--dangerously-bypass-hook-trust');
  expect(args).toContain('--model');
});

test('runCodex：fresh 輪仍以 --sandbox read-only 執行（保護未放寬）', async () => {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runCodex } = require('../pipeline/codex-runner');
  const p = runCodex('全新', {});
  c.emit('close', 0);
  await p;

  const args = spawn.mock.calls.at(-1)[1];
  expect(args).not.toContain('resume');
  expect(args.join(' ')).toContain('--sandbox read-only');
  expect(args).not.toContain('sandbox_mode="read-only"');
});

// 沙箱建不起 namespace 時，每個工具呼叫都在啟動階段失敗、agent 只能回「查不到」，
// 但 CLI 仍 exit 0。無條件 resolve 會讓 token-logger 記成 completed＝整條路徑零失敗訊號。
test('runCodex：沙箱起不來時即使 exit 0 也必須失敗，不得記成成功', async () => {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runCodex } = require('../pipeline/codex-runner');
  const p = runCodex('查一下', {});

  c.stdout.emit('data', [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-9' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls /tmp', exit_code: 1, aggregated_output: "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.\n" } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '查不到相關資料' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } })
  ].join('\n') + '\n');
  c.emit('close', 0);

  const err = await p.then(() => null, e => e);
  expect(err).not.toBeNull();
  expect(err.message).toContain('沙箱啟動失敗');
  expect(err.message).toContain('new namespace');
  expect(err.claudeStatus).toBe('error');
  expect(err.sessionId).toBe('thread-9');
});

test('runCodex：工具指令正常執行時不受影響，照常 resolve', async () => {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runCodex } = require('../pipeline/codex-runner');
  const p = runCodex('查一下', {});

  c.stdout.emit('data', [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls /tmp', exit_code: 0, aggregated_output: 'a.txt\nb.txt\n' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '有兩個檔' } })
  ].join('\n') + '\n');
  c.emit('close', 0);

  await expect(p).resolves.toMatchObject({ text: '有兩個檔' });
});
