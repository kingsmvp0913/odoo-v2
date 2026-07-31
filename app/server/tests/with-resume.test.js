// 意圖：對話式閘門的 session 續接護欄。resume 只在「有 session ＋ 指紋相符」時發生；
// 任何失敗都必須能落回 fresh，唯獨手動暫停（abort）不得清掉 session——否則使用者一暫停就失去續接。
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn() }));
jest.mock('../pipeline/agent-loader', () => ({ promptVersion: jest.fn() }));

const { runClaude } = require('../pipeline/claude-runner');
const { promptVersion } = require('../pipeline/agent-loader');
const { withResume } = require('../pipeline/with-resume');

// promptVersion 依 agent 名回不同值 → 組合指紋 'F1.R1'
function stubVersions(fresh = 'F1', retry = 'R1') {
  promptVersion.mockImplementation(n => (n === 'fresh-agent' ? fresh : retry));
}

function makeOpts(over = {}) {
  return {
    freshAgentName: 'fresh-agent',
    retryAgentName: 'retry-agent',
    getSession: jest.fn().mockResolvedValue(null),
    setSession: jest.fn().mockResolvedValue(undefined),
    clearSession: jest.fn().mockResolvedValue(undefined),
    renderFresh: () => 'FRESH_PROMPT',
    renderRetry: () => 'RETRY_PROMPT',
    model: 'opus',
    runOpts: { taskId: 1, userId: 2 },
    ...over
  };
}

beforeEach(() => {
  runClaude.mockReset();
  promptVersion.mockReset();
  stubVersions();
});

test('無 session → 走 fresh，且成功後存下 session 與組合指紋', async () => {
  runClaude.mockResolvedValue({ text: 'ok', sessionId: 's-new' });
  const o = makeOpts();

  await withResume(o);

  expect(runClaude.mock.calls[0][0]).toBe('FRESH_PROMPT');
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined();
  expect(o.setSession).toHaveBeenCalledWith({ sessionId: 's-new', promptVer: 'F1.R1' });
});

test('有 session 且指紋相符 → 走 retry 並帶 --resume 的 session id', async () => {
  runClaude.mockResolvedValue({ text: 'ok', sessionId: 's-1' });
  const o = makeOpts({ getSession: jest.fn().mockResolvedValue({ sessionId: 's-1', promptVer: 'F1.R1' }) });

  await withResume(o);

  expect(runClaude.mock.calls[0][0]).toBe('RETRY_PROMPT');
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBe('s-1');
  expect(o.clearSession).not.toHaveBeenCalled();
});

test('指紋不符（agent prompt 改過）→ 不 resume，走 fresh', async () => {
  runClaude.mockResolvedValue({ text: 'ok', sessionId: 's-new' });
  // 存的是舊指紋，現行是 F1.R1
  const o = makeOpts({ getSession: jest.fn().mockResolvedValue({ sessionId: 's-old', promptVer: 'F0.R0' }) });

  await withResume(o);

  expect(runClaude.mock.calls[0][0]).toBe('FRESH_PROMPT');
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined();
});

test('retry 失敗（session 遺失）→ 清 session 並在同一輪內降級跑 fresh', async () => {
  runClaude
    .mockRejectedValueOnce(Object.assign(new Error('session gone'), { claudeStatus: 'error' }))
    .mockResolvedValueOnce({ text: 'ok', sessionId: 's-new' });
  const o = makeOpts({ getSession: jest.fn().mockResolvedValue({ sessionId: 's-dead', promptVer: 'F1.R1' }) });

  const res = await withResume(o);

  expect(o.clearSession).toHaveBeenCalled();
  expect(runClaude).toHaveBeenCalledTimes(2);                  // 同一輪內重跑
  expect(runClaude.mock.calls[1][0]).toBe('FRESH_PROMPT');
  expect(res.text).toBe('ok');                                  // 使用者拿得到結果
});

test('手動暫停（err.aborted）→ 原樣拋出，且不得清 session', async () => {
  runClaude.mockRejectedValue(Object.assign(new Error('aborted'), { aborted: true }));
  const o = makeOpts({ getSession: jest.fn().mockResolvedValue({ sessionId: 's-1', promptVer: 'F1.R1' }) });

  await expect(withResume(o)).rejects.toThrow('aborted');
  expect(o.clearSession).not.toHaveBeenCalled();                // 解除暫停後還要能續接
  expect(runClaude).toHaveBeenCalledTimes(1);                   // 不降級重跑
});

test('retry timeout → 清 session 並拋出，不在同一輪重跑（避免連兩次逾時）', async () => {
  runClaude.mockRejectedValue(Object.assign(new Error('timeout'), { claudeStatus: 'timeout' }));
  const o = makeOpts({ getSession: jest.fn().mockResolvedValue({ sessionId: 's-1', promptVer: 'F1.R1' }) });

  await expect(withResume(o)).rejects.toThrow('timeout');
  expect(o.clearSession).toHaveBeenCalled();
  expect(runClaude).toHaveBeenCalledTimes(1);
});

test('retry 失敗且提供 onRetryFailed → 呼叫 callback 並傳原始 error，fresh 仍執行並回傳結果', async () => {
  const onRetryFailed = jest.fn().mockResolvedValue(undefined);
  runClaude
    .mockRejectedValueOnce(Object.assign(new Error('session gone'), { claudeStatus: 'error' }))
    .mockResolvedValueOnce({ text: 'ok from fresh', sessionId: 's-new' });
  const o = makeOpts({
    getSession: jest.fn().mockResolvedValue({ sessionId: 's-dead', promptVer: 'F1.R1' }),
    onRetryFailed
  });

  const res = await withResume(o);

  expect(onRetryFailed).toHaveBeenCalledTimes(1);
  expect(onRetryFailed.mock.calls[0][0]).toHaveProperty('claudeStatus', 'error');
  expect(runClaude).toHaveBeenCalledTimes(2);
  expect(runClaude.mock.calls[1][0]).toBe('FRESH_PROMPT');
  expect(res.text).toBe('ok from fresh');
});
