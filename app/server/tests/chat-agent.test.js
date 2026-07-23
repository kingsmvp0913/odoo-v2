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
  // 依 SQL 內容分派回傳：wiki_pages(專案備註) / project_chat_messages(history) / projects.name / INSERT
  mockQuery.mockImplementation((sql) => {
    // getProjectNotes 查 project-notes 頁；此測試專案未寫備註 → 回空（不注入）
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] }); // 無 repo → repo_paths 走 fallback
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] }); // INSERT 等
  });
});

test('prompt 帶入專案名、指示按需查 wiki，不預載 wiki 內容', async () => {
  await chatReply('1', '2', '正式區某張單金額算錯', 99);
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('鴻久');                 // 專案名帶入
  expect(prompt).toContain('/ai/wiki/pages');       // 按需查 wiki 指引
  expect(prompt).not.toContain('請根據以下 Wiki 資料回答'); // 無舊 wiki 優先框架
  expect(prompt).not.toContain('# 專案備註（人工維護，優先遵循）'); // 未寫備註 → 不注入備註區塊
  expect(prompt).toContain('無 repo');   // 未 clone repo → 走 fallback 文案
});

test('專案有備註 → 注入 prompt（供 chat 優先遵循，免再 curl）', async () => {
  mockQuery.mockImplementation((sql) => {
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [{ content: '部署到 8069 埠，窗口 Amy' }] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });
  await chatReply('1', '2', '部署在哪個埠', 99);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('# 專案備註（人工維護，優先遵循）');
  expect(prompt).toContain('部署到 8069 埠，窗口 Amy');
});

test('Branch A：prompt 指示資料類問題用 getSQL（skill 原生可達）', async () => {
  await chatReply('1', '2', '正式區 res_partner 有幾筆', 99);
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('getSQL');
  expect(prompt).toContain('唯讀');
});

test('回覆含 <memory> → 結論寫回 wiki 疑難排解、且存檔的回覆已剝除側通道', async () => {
  mockRunClaude.mockResolvedValueOnce({
    text: '確認了：稅率沒帶到才算錯。\n<memory>{"slug":"tax-missing","title":"稅率漏帶","content":"# 原因\\n稅率欄空"}</memory>',
    usage: {}, durationMs: 1
  });
  mockQuery.mockImplementation((sql) => {
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/SELECT id FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [{ id: 7 }] }); // 容器 id
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });                     // 專案備註：無
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });

  const reply = await chatReply('1', '2', '金額為何算錯', 99);

  // 寫回：ts- 前綴、掛容器、upsert
  const upsert = mockQuery.mock.calls.find(c => /INSERT INTO wiki_pages[\s\S]*DO UPDATE/.test(c[0]));
  expect(upsert).toBeTruthy();
  expect(upsert[1]).toEqual(['1', 7, 'ts-tax-missing', '稅率漏帶', '# 原因\n稅率欄空']);

  // 顯示／存檔的回覆不含機器側通道
  expect(reply).toBe('確認了：稅率沒帶到才算錯。');
  const replyInsert = mockQuery.mock.calls.find(c => /INSERT INTO project_chat_messages/.test(c[0]) && c[1] && c[1][1] === 'ai');
  expect(replyInsert[1][2]).toBe('確認了：稅率沒帶到才算錯。');
  expect(replyInsert[1][2]).not.toContain('<memory>');
});
