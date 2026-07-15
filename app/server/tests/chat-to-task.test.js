// 意圖：draftTaskFromChat 把整串排障對話摘要成「任務草稿」，但只回草稿、不落地建任務
// （human-in-the-loop：前端拿草稿讓使用者編輯確認後才走既有 POST /api/tasks）。
// 鎖定三件事：①用整串對話（非只最後 N 筆）②回傳解析後 {title, original_text} ③絕不 INSERT 任務。
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...a) => mockRunClaude(...a) }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

// agent-loader 用假 agent 隔離：本測試驗 draftTaskFromChat 的組裝/解析/守門邏輯，非 prompt 文字內容。
const mockRender = jest.fn(({ history }) => `SUMMARIZE:\n${history}`);
jest.mock('../pipeline/agent-loader', () => ({
  loadAgent: () => ({ model: 'sonnet', render: mockRender })
}));

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));

const { draftTaskFromChat } = require('../pipeline/chat-to-task');

beforeEach(() => {
  mockRunClaude.mockReset();
  mockRender.mockClear();
  mockQuery.mockReset();
});

// 便利：mock 對話訊息回傳
function withMessages(rows) {
  mockQuery.mockImplementation((sql) => {
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

test('回傳解析後的 {title, original_text}，且整串對話（非只最後 10 筆）都進 prompt', async () => {
  // 12 則訊息，最早一則必須出現在 prompt（證明沒有 LIMIT 10）
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push({ role: i % 2 ? 'user' : 'ai', content: `第${i}句` });
  withMessages(rows);
  mockRunClaude.mockResolvedValue({
    text: '好的，我整理成任務：\n<result>{"title":"金額計算錯誤","original_text":"正式區某張單金額算錯，需檢查稅額計算"}</result>',
    usage: {}, durationMs: 1
  });

  const draft = await draftTaskFromChat(1, 2, 99);

  expect(draft).toEqual({ title: '金額計算錯誤', original_text: '正式區某張單金額算錯，需檢查稅額計算' });
  const prompt = mockRender.mock.calls[0][0].history;
  expect(prompt).toContain('第1句');   // 最早訊息在內
  expect(prompt).toContain('第12句');  // 最後訊息也在
});

test('絕不 INSERT 任務（只回草稿）', async () => {
  withMessages([{ role: 'user', content: '有問題' }]);
  mockRunClaude.mockResolvedValue({
    text: '<result>{"title":"t","original_text":"o"}</result>', usage: {}, durationMs: 1
  });

  await draftTaskFromChat(1, 2, 99);

  const insertedTask = mockQuery.mock.calls.some(([sql]) => /INSERT\s+INTO\s+tasks/i.test(sql));
  expect(insertedTask).toBe(false);
});

test('空對話 → throw 且 status 400', async () => {
  withMessages([]);
  await expect(draftTaskFromChat(1, 2, 99)).rejects.toMatchObject({ status: 400 });
  expect(mockRunClaude).not.toHaveBeenCalled(); // 空對話不該白燒 token
});
