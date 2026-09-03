// 意圖：截圖預覽伺服器絕不能在 worktree 起完整的 app server（cron 會被兩份同時啟動，
// 見 pipeline/ui-preview.js 開頭的事故記錄）。這一支釘住「route 為空 → 完全不起任何伺服器」，
// 並驗證有 route 時走的是靜態檔案伺服器（http.createServer），不是 require('../index')。
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCreateServer = jest.fn();
jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    createServer: (...args) => mockCreateServer(...args),
  };
});

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));

const mockLaunch = jest.fn();
jest.mock('playwright', () => ({ chromium: { launch: (...args) => mockLaunch(...args) } }), { virtual: true });

const { captureBeforeAfter } = require('../pipeline/ui-preview');

beforeEach(() => {
  mockCreateServer.mockReset();
  mockQuery.mockReset();
  mockLaunch.mockReset();
});

describe('route 為空', () => {
  test.each([undefined, null, ''])('route=%p → 回 null 且不起任何伺服器', async (route) => {
    const result = await captureBeforeAfter('/some/worktree', route);
    expect(result).toBeNull();
    expect(mockCreateServer).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('token 簽發失敗（缺 JWT_SECRET 或 cli_push_user_id）', () => {
  test('查無 cli_push_user_id → 回 null，不起伺服器', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cli_push_user_id: null }] });
    const result = await captureBeforeAfter('/some/worktree', '#/tasks');
    expect(result).toBeNull();
  });
});

describe('playwright 載入或啟動失敗 → 走無截圖路徑', () => {
  test('chromium.launch 拋錯時 captureBeforeAfter 回 null（不拋出）', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cli_push_user_id: 1 }] });
    // 讓 createServer 回一個可用的假 server，讓流程走到 launch 那一步再炸
    mockCreateServer.mockImplementation((handler) => {
      const net = jest.requireActual('net');
      const actualHttp = jest.requireActual('http');
      const srv = actualHttp.createServer(handler);
      return srv;
    });
    mockLaunch.mockRejectedValue(new Error('Executable doesn\'t exist'));
    const result = await captureBeforeAfter(os.tmpdir(), '#/tasks');
    expect(result).toBeNull();
  });
});
