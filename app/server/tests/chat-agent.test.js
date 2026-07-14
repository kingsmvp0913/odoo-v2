// 意圖：chat 不再是「wiki 優先」——wiki 只是來源之一，由助理按問題性質自選來源。
// 這裡鎖定 prompt 建構：帶入專案名、wiki 被明示為「參考來源之一」、且不再出現舊的
// 「請根據以下 Wiki 資料回答」這種把 wiki 當唯一權威的框架。
const mockRunClaude = jest.fn().mockResolvedValue({ text: '回覆', usage: {}, durationMs: 1 });
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...a) => mockRunClaude(...a) }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));

const { chatReply } = require('../pipeline/chat-agent');

beforeEach(() => {
  mockRunClaude.mockClear();
  mockQuery.mockReset();
  // 依 SQL 內容分派回傳：wiki_pages / project_chat_messages(history) / projects.name / INSERT
  mockQuery.mockImplementation((sql) => {
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [{ title: 'W', content: '維基內容' }] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] }); // INSERT 等
  });
});

test('prompt 帶入專案名、wiki 降為參考來源之一，且無「wiki 優先」框架', async () => {
  await chatReply('1', '2', '正式區某張單金額算錯', 99);
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('鴻久');                       // 專案名帶入
  expect(prompt).toContain('來源之一');                    // wiki 被降級標示
  expect(prompt).not.toContain('請根據以下 Wiki 資料回答'); // 舊的 wiki 優先框架已移除
});
