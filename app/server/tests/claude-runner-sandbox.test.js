// 意圖（規格 §5、§6）：runner 的解析邏輯不變，只是子行程換成 docker。四件事不能錯：
//  1. 開關 off 時一個字都不變（同步 spawn claude）
//  2. 容器準備失敗必須失敗，絕不偷偷改跑容器外的 claude
//  3. 停止／逾時要 docker kill：SIGKILL 送到 docker CLI 不會轉給容器，容器會繼續跑、繼續燒錢
//  4. 被記憶體上限砍掉要講清楚，不是泛用的 exited with code 137
const { EventEmitter } = require('events');
jest.mock('child_process', () => ({ spawn: jest.fn(), execFile: jest.fn() }));
jest.mock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../pipeline/sandbox-run', () => ({ resolveSandboxPlan: jest.fn(), prepareSandboxRun: jest.fn() }));

const { spawn } = require('child_process');
const sr = require('../pipeline/sandbox-run');
const flag = require('../lib/agent-sandbox-flag');
const { runClaude } = require('../pipeline/claude-runner');

function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  c.kill = jest.fn();
  return c;
}
function fakeRun() {
  return { argv: ['run', '-i', '--rm', 'aidev-agent:x', 'claude', '-p'], childEnv: { PATH: '/bin', AIDEV_AI_TOKEN: 't' },
    containerName: 'odoo-v2-run-ab', runId: 'ab', kill: jest.fn(), attach: jest.fn(c => c), release: jest.fn().mockResolvedValue() };
}
const tick = () => new Promise(r => setImmediate(r));
const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } });

beforeEach(() => { spawn.mockReset(); sr.resolveSandboxPlan.mockReset(); sr.prepareSandboxRun.mockReset(); });
afterEach(() => flag._setFlagStateForTesting({ mode: 'off' }));

test('off：同步 spawn claude（呼叫當下就已 spawn），不碰 sandbox-run', () => {
  flag._setFlagStateForTesting({ mode: 'off' });
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('x', { agentType: 'chat-title' });
  expect(spawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.objectContaining({ env: expect.any(Object) }));
  expect(sr.resolveSandboxPlan).not.toHaveBeenCalled();
  c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
  return expect(p).resolves.toMatchObject({ text: 'done' });
});

test('plan 為 null → 舊路徑 spawn claude', async () => {
  flag._setFlagStateForTesting({ mode: 'internal' });
  sr.resolveSandboxPlan.mockResolvedValueOnce(null);
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('x', { agentType: 'chat-title' });
  await tick(); await tick();
  expect(spawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object));
  c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
  await expect(p).resolves.toMatchObject({ text: 'done' });
});

test('容器路徑：spawn docker、不帶 cwd、解析照舊、結束時 release', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: { scope: 'none', mount: 'none' }, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('prompt-body', { agentType: 'chat-title', cwd: '/should/not/be/used' });
  await tick(); await tick();
  expect(spawn).toHaveBeenCalledWith('docker', run.argv, expect.objectContaining({ env: run.childEnv }));
  expect(spawn.mock.calls[0][2].cwd).toBeUndefined();
  // release 要靠 attach 得知 docker run CLI 何時退出，才判斷得了容器是否真的不會再跑（D1）
  expect(run.attach).toHaveBeenCalledWith(c);
  expect(c.stdin.write).toHaveBeenCalledWith('prompt-body');
  c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
  await expect(p).resolves.toMatchObject({ text: 'done' });
  await tick();
  expect(run.release).toHaveBeenCalledTimes(1);
});

test('準備失敗 → reject，而且從頭到尾沒有 spawn claude', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: { scope: 'none', mount: 'none' }, projectId: null });
  sr.prepareSandboxRun.mockRejectedValueOnce(new Error('AI 映像檔 aidev-agent:x 不存在'));
  await expect(runClaude('x', { agentType: 'chat-title' })).rejects.toMatchObject({ claudeStatus: 'error', message: expect.stringMatching(/映像檔/) });
  expect(spawn).not.toHaveBeenCalled();
});

test('未登記 agentType（resolveSandboxPlan 丟例外）→ reject，不 spawn', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  sr.resolveSandboxPlan.mockRejectedValueOnce(new Error('未登記的 agentType：x'));
  await expect(runClaude('x', { agentType: 'x' })).rejects.toThrow(/未登記/);
  expect(spawn).not.toHaveBeenCalled();
});

test('按停止 → docker kill（run.kill）＋ release', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  const c = child(); spawn.mockReturnValueOnce(c);
  const ctrl = new AbortController();
  const p = runClaude('x', { agentType: 'chat-title', signal: ctrl.signal });
  await tick(); await tick();
  ctrl.abort();
  await expect(p).rejects.toMatchObject({ claudeStatus: 'aborted' });
  expect(run.kill).toHaveBeenCalled();
  await tick();
  expect(run.release).toHaveBeenCalled();
});

test('逾時 → docker kill', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  spawn.mockReturnValueOnce(child());
  await expect(runClaude('x', { agentType: 'chat-title', timeoutMs: 30 })).rejects.toMatchObject({ claudeStatus: 'timeout' });
  expect(run.kill).toHaveBeenCalled();
});

test('準備期間就按停止 → 準備完成後立刻 release，不 spawn', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  let resolvePrep;
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockReturnValueOnce(new Promise(r => { resolvePrep = r; }));
  const ctrl = new AbortController();
  const p = runClaude('x', { agentType: 'chat-title', signal: ctrl.signal });
  await tick();
  ctrl.abort();
  await expect(p).rejects.toMatchObject({ claudeStatus: 'aborted' });
  resolvePrep(run);
  await tick(); await tick();
  expect(spawn).not.toHaveBeenCalled();
  expect(run.release).toHaveBeenCalled();
});

test('容器 exit 137 → oom，訊息寫明記憶體上限', async () => {
  flag._setFlagStateForTesting({ mode: 'all', limits: { memory: '4g', cpus: '2', pids: 512 } });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('x', { agentType: 'chat-title' });
  await tick(); await tick();
  c.emit('close', 137);
  await expect(p).rejects.toMatchObject({ claudeStatus: 'oom', message: expect.stringMatching(/記憶體上限.*4g/) });
});
