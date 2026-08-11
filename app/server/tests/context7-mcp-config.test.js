// 意圖：pipeline 子行程帶 --strict-mcp-config，MCP server 由 claude CLI 另行 spawn，不保證繼承
// 平台行程的環境變數——API key 必須顯式寫進 MCP 設定檔的 env，否則 context7 靜默退回匿名額度
// （配額用盡時不報錯，各關改用 WebSearch 抓 Odoo 原始碼，見 lib/context7-auth）。
//
// writeFileSync 一律 mock：真的落檔會覆蓋常駐 server 正在用的 context7.local.json，
// 而 runner 的路徑快取讓它直到 key 再變一次才會重寫 → 測試把假 key 留給正式 pipeline 用。
const fs = require('fs');

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../notify', () => ({}));

let mcpConfigPath, context7Auth, writeSpy;

beforeAll(() => {
  context7Auth = require('../lib/context7-auth');
  ({ mcpConfigPath } = require('../pipeline/claude-runner'));
});

beforeEach(() => {
  writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  context7Auth._setForTesting(null);
});

afterEach(() => { writeSpy.mockRestore(); });

// 取出最後一次寫出的 MCP 設定內容
function lastWrittenConfig() {
  const call = writeSpy.mock.calls.at(-1);
  return JSON.parse(call[1]).mcpServers.context7;
}

test('已設 key → 寫進 MCP 設定的 env（CLI 不繼承平台行程的環境變數，必須顯式帶）', () => {
  context7Auth._setForTesting('ctx7-live-key');
  mcpConfigPath('coding');
  expect(lastWrittenConfig().env).toEqual({ CONTEXT7_API_KEY: 'ctx7-live-key' });
});

// 寫 { CONTEXT7_API_KEY: '' } 會蓋掉手動設定的環境變數，等於把可用的 key 關掉
test('未設 key → 設定裡完全沒有 env 欄位，不得寫空字串', () => {
  mcpConfigPath('coding');
  expect(lastWrittenConfig().env).toBeUndefined();
});

// 這是「管理員在後台換 key 不必重啟 server」的實作依據：路徑快取必須連 key 一起比對，
// 只比對路徑的話換完 key 仍會沿用上一份設定檔，直到下次重啟。
test('換 key → 下一次取設定就重寫（快取要連 key 一起失效）', () => {
  context7Auth._setForTesting('old-key');
  mcpConfigPath('coding');
  expect(lastWrittenConfig().env).toEqual({ CONTEXT7_API_KEY: 'old-key' });

  context7Auth._setForTesting('new-key');
  mcpConfigPath('coding');
  expect(lastWrittenConfig().env).toEqual({ CONTEXT7_API_KEY: 'new-key' });
});

test('key 沒變 → 不重複寫檔（每次 spawn 都重寫是白費 IO）', () => {
  context7Auth._setForTesting('same-key');
  mcpConfigPath('coding');
  const countAfterFirst = writeSpy.mock.calls.length;
  mcpConfigPath('qa');
  expect(writeSpy.mock.calls.length).toBe(countAfterFirst);
});

// 不掛 context7 的關卡不該被這條路徑影響
test('NO_MCP 關卡 → 回 none.json，不寫任何設定檔', () => {
  context7Auth._setForTesting('ctx7-live-key');
  expect(mcpConfigPath('merge')).toMatch(/none\.json$/);
  expect(writeSpy).not.toHaveBeenCalled();
});
