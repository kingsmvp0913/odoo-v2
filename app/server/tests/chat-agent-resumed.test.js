// 意圖：chat 一週 $34 的成本裡有多少是「續接失敗→整包重讀」白付的，只能靠 token_usage.resumed 算。
// withResume 回報了走哪條路還不夠，chat-agent 必須真的把它傳進記帳——少傳一個參數欄位就回到全 NULL，
// 而且沒有任何其他徵狀。三條路各驗一次：續接成功記 true、fresh 記 false、降級時失敗列 true＋成功列 false。
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...a) => mockRunClaude(...a) }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../lib/odoo-core-src', () => ({
  coreSourceGuidance: jest.fn().mockReturnValue(''),
  ensureOdooCoreSrc: jest.fn().mockResolvedValue(''),
  majorOf: jest.fn().mockReturnValue(''),
  CORE_SRC_ROOT: '/core-src'
}));
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));
// chatReply 每輪會看一次出貨箱（uploadRoot/chat_<id>/ai）：導到暫存目錄，免得動到真的 app/uploads
const tmpUploadRoot = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'aidev-chat-resumed-'));
process.env.UPLOAD_DIR = tmpUploadRoot;
afterAll(() => { delete process.env.UPLOAD_DIR; require('fs').rmSync(tmpUploadRoot, { recursive: true, force: true }); });

const { logTokenUsage, logFailedUsage } = require('../pipeline/token-logger');
const { chatReply } = require('../pipeline/chat-agent');

const baseRows = (sql) => {
  if (/FROM projects/.test(sql)) return { rows: [{ name: '鴻久' }] };
  return { rows: [] };
};

// 指紋不自己算（算式複製過來就變成自己對自己）：先跑一輪 fresh，把實際存下的指紋撈出來
async function freshRoundStoresVer() {
  let storedVer = null;
  mockRunClaude.mockResolvedValueOnce({ text: '回覆', usage: {}, durationMs: 1, sessionId: 'sess-a' });
  mockQuery.mockImplementation((sql, params) => {
    if (/chat_prompt_ver=\$3/.test(sql)) { storedVer = params[2]; return Promise.resolve({ rows: [] }); }
    return Promise.resolve(baseRows(sql));
  });
  await chatReply('1', '2', '第一輪', 99);
  return storedVer;
}

function withLiveSession(ver) {
  mockQuery.mockImplementation((sql) => {
    if (/FROM project_chats/.test(sql)) return Promise.resolve({ rows: [{ chat_session_id: 'sess-a', chat_prompt_ver: ver }] });
    return Promise.resolve(baseRows(sql));
  });
}

beforeEach(() => {
  mockRunClaude.mockReset();
  mockQuery.mockReset();
  logTokenUsage.mockClear();
  logFailedUsage.mockClear();
});

test('無 session → 記帳 resumed=false（不是 NULL），status 仍是 completed', async () => {
  await freshRoundStoresVer();
  expect(logTokenUsage).toHaveBeenCalledTimes(1);
  const call = logTokenUsage.mock.calls[0];
  expect(call[2]).toBe('chat');
  expect(call[5]).toBe('completed');
  expect(call[6]).toBe(false);
});

test('續接成功 → 記帳 resumed=true', async () => {
  const ver = await freshRoundStoresVer();
  expect(ver).toBeTruthy();
  logTokenUsage.mockClear();
  withLiveSession(ver);
  mockRunClaude.mockResolvedValueOnce({ text: '續接回覆', usage: {}, durationMs: 1, sessionId: 'sess-a' });
  await chatReply('1', '2', '第二輪', 99);
  expect(mockRunClaude.mock.calls[1][1].resumeSessionId).toBe('sess-a');
  expect(logTokenUsage.mock.calls[0][6]).toBe(true);
});

test('續接失敗降級 fresh → 失敗列 resumed=true、降級後的成功列 resumed=false', async () => {
  const ver = await freshRoundStoresVer();
  logTokenUsage.mockClear();
  withLiveSession(ver);
  const retryErr = Object.assign(new Error('session gone'), { claudeStatus: 'error' });
  mockRunClaude
    .mockRejectedValueOnce(retryErr)
    .mockResolvedValueOnce({ text: '重讀後回覆', usage: {}, durationMs: 1, sessionId: 'sess-b' });
  await chatReply('1', '2', '第二輪', 99);

  const failed = logFailedUsage.mock.calls.find(c => c[3] === retryErr);
  expect(failed).toBeDefined();
  expect(failed[4]).toBe(true);
  expect(logTokenUsage).toHaveBeenCalledTimes(1);
  expect(logTokenUsage.mock.calls[0][6]).toBe(false);
});
