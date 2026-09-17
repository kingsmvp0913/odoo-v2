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
    containerName: 'odoo-v2-run-ab', runId: 'ab', kill: jest.fn(), release: jest.fn().mockResolvedValue() };
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

// 意圖（09-15 Q4）：容器結束時一定要比對任務主 clone 的 refs——不管成功、失敗、逾時或被停止。
// 成功那輪有違規就判失敗；失敗那輪照樣還原、保留原本的失敗原因、但違規要講出來（不可默默吞掉）。
// release（收回通行證）要等比對做完。
describe('refs 守衛', () => {
  const { query } = require('../db');
  function guardedRun(verify) {
    const order = [];
    const run = fakeRun();
    run.verifyRefs = jest.fn(async () => { order.push('verify'); return verify(); });
    run.release = jest.fn(async () => { order.push('release'); });
    return { run, order };
  }
  async function start(run, opts = {}) {
    flag._setFlagStateForTesting({ mode: 'all' });
    sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: 7 });
    sr.prepareSandboxRun.mockResolvedValueOnce(run);
    const c = child(); spawn.mockReturnValueOnce(c);
    const p = runClaude('x', { agentType: 'coding', ...opts });
    await tick(); await tick();
    return { c, p };
  }
  let errSpy;
  beforeEach(() => { query.mockClear(); errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errSpy.mockRestore());

  test('exit 0 但動了別的 ref → reject（error），訊息是違規說明；release 在比對之後', async () => {
    const { run, order } = guardedRun(() => 'AI 改動了本任務分支以外的 git ref，已還原：main: refs/heads/testing');
    const { c, p } = await start(run);
    c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
    await expect(p).rejects.toMatchObject({ claudeStatus: 'error', message: expect.stringMatching(/refs\/heads\/testing/) });
    await tick();
    expect(order).toEqual(['verify', 'release']);
  });

  test('exit 0 且 refs 乾淨 → 照常 resolve', async () => {
    const { run } = guardedRun(() => null);
    const { c, p } = await start(run);
    c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
    await expect(p).resolves.toMatchObject({ text: 'done' });
    expect(run.verifyRefs).toHaveBeenCalledTimes(1);
  });

  test('exit 0 但比對本身失敗 → reject（fail closed）', async () => {
    const { run } = guardedRun(() => { throw new Error('git for-each-ref 失敗'); });
    const { c, p } = await start(run);
    c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
    await expect(p).rejects.toMatchObject({ claudeStatus: 'error', message: expect.stringMatching(/for-each-ref/) });
  });

  test('非零退出也要比對還原；保留原本錯誤，違規寫進 console 與時間軸', async () => {
    const { run } = guardedRun(() => 'AI 改動了本任務分支以外的 git ref，已還原：main: refs/heads/testing');
    const { c, p } = await start(run, { taskId: 70 });
    c.stderr.emit('data', 'boom from cli'); c.emit('close', 1);
    await expect(p).rejects.toMatchObject({ claudeStatus: 'error', message: 'boom from cli' });
    expect(run.verifyRefs).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.some(a => /\[SANDBOX\].*refs\/heads\/testing/.test(a.join(' ')))).toBe(true);
    expect(query.mock.calls.some(([sql, params]) => /INSERT INTO task_logs/.test(sql) && params[0] === 70 && /refs\/heads\/testing/.test(params[1]))).toBe(true);
  });

  test('按停止後容器才結束 → 仍比對一次；維持 aborted；release 等比對完才做', async () => {
    const { run, order } = guardedRun(() => 'AI 改動了本任務分支以外的 git ref，已還原：main: refs/heads/main');
    const ctrl = new AbortController();
    const { c, p } = await start(run, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ claudeStatus: 'aborted' });
    await tick();
    expect(run.release).not.toHaveBeenCalled(); // 容器還沒真的停，refs 還可能被動
    c.emit('close', null, 'SIGKILL');
    await tick(); await tick();
    expect(run.verifyRefs).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['verify', 'release']);
    expect(errSpy.mock.calls.some(a => /\[SANDBOX\].*refs\/heads\/main/.test(a.join(' ')))).toBe(true);
  });
});
