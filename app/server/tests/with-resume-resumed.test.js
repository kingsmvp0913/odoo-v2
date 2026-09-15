// 意圖：withResume 的「續接失敗靜默降級 fresh」是對的，但降級＝整包重讀，是最貴的路徑。
// 它不回報這一輪實際走哪條路，呼叫端就寫不出 token_usage.resumed，欄位一律 NULL——
// 而 NULL 的定義是「這關沒有 resume 概念」，於是連「chat 到底有沒有在續接」都分辨不出來（健檢提案 164）。
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn() }));
jest.mock('../pipeline/agent-loader', () => ({ promptVersion: jest.fn().mockReturnValue('V') }));

const { newDb } = require('pg-mem');
const { runClaude } = require('../pipeline/claude-runner');
const { withResume } = require('../pipeline/with-resume');

function makeOpts(sess) {
  return {
    freshAgentName: 'f', retryAgentName: 'r',
    getSession: jest.fn().mockResolvedValue(sess),
    setSession: jest.fn(), clearSession: jest.fn(),
    renderFresh: () => 'FRESH', renderRetry: () => 'RETRY',
    model: 'opus', runOpts: {}
  };
}
const LIVE = { sessionId: 's-1', promptVer: 'V.V' };

beforeEach(() => runClaude.mockReset());

test('續接成功 → resumed=true', async () => {
  runClaude.mockResolvedValue({ text: 'ok', sessionId: 's-1' });
  const res = await withResume(makeOpts(LIVE));
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBe('s-1');
  expect(res).toMatchObject({ text: 'ok', resumed: true });
});

test('本來就 fresh（無 session）→ resumed=false', async () => {
  runClaude.mockResolvedValue({ text: 'ok', sessionId: 's-new' });
  const res = await withResume(makeOpts(null));
  expect(res).toMatchObject({ text: 'ok', resumed: false });
});

// 接反的代價是方向相反、看起來又合理的資料：以為續接率高而去砍降級護欄，直接傷到 chat 的穩定性
test('續接失敗降級 fresh → 這一輪的回覆來自 fresh，resumed=false，且使用者仍拿得到回覆', async () => {
  runClaude
    .mockRejectedValueOnce(Object.assign(new Error('session gone'), { claudeStatus: 'error' }))
    .mockResolvedValueOnce({ text: 'ok from fresh', sessionId: 's-new' });
  const res = await withResume(makeOpts(LIVE));
  expect(runClaude).toHaveBeenCalledTimes(2);
  expect(res).toMatchObject({ text: 'ok from fresh', resumed: false });
});

describe('logFailedUsage 的 resumed 落地', () => {
  let dbModule, logFailedUsage;
  beforeAll(async () => {
    const { Pool } = newDb().adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    ({ logFailedUsage } = require('../pipeline/token-logger'));
  });
  afterAll(() => { dbModule._setPoolForTesting(null); });

  // 第 5 個參數若傳錯位（logTokenUsage 的第 6 個是 status），失敗列的 status 會被蓋掉、報表失敗數跟著錯
  test('續接失敗列傳 true → 落 true 且 status 仍是 error；未傳 → 仍是 NULL，不可退成 false', async () => {
    const err = Object.assign(new Error('session gone'), { claudeStatus: 'error', durationMs: 55 });
    await logFailedUsage({ taskId: 'tk-rf' }, null, 'chat', err, true);
    await logFailedUsage({ taskId: 'tk-plain' }, null, 'chat', err);
    const { rows } = await dbModule.query(
      "SELECT task_id, status, resumed, error_message FROM token_usage WHERE task_id IN ('tk-rf','tk-plain') ORDER BY task_id"
    );
    expect(rows).toEqual([
      { task_id: 'tk-plain', status: 'error', resumed: null, error_message: 'session gone' },
      { task_id: 'tk-rf', status: 'error', resumed: true, error_message: 'session gone' }
    ]);
  });
});
