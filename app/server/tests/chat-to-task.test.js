// 意圖：draftTaskFromChat 把排障對話摘要成「任務草稿」，但只回草稿、不落地建任務
// （human-in-the-loop：前端拿草稿讓使用者編輯確認後才走既有 POST /api/tasks）。
// 鎖定：①第一次轉任務用整串對話（非只最後 N 筆）②回傳解析後 {title, original_text}
// ③絕不 INSERT 任務 ④第二次轉任務時，上次已轉過的內容只當背景、不再被摘進需求。
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

// 便利：mock 對話訊息回傳。upto＝project_chats.converted_upto_message_id（上次轉任務的分界線）。
function withMessages(rows, upto = null, attachments = []) {
  mockQuery.mockImplementation((sql) => {
    if (/FROM project_chat_attachments/.test(sql)) return Promise.resolve({ rows: attachments });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows });
    if (/FROM project_chats/.test(sql)) return Promise.resolve({ rows: [{ converted_upto_message_id: upto }] });
    return Promise.resolve({ rows: [] });
  });
}

// id 必須是遞增實值：分界線比對的是訊息 id，fixture 缺 id 會讓每則都落在「分界線之後」的反面，
// 測試靠 fallback 巧合變綠，實際上什麼都沒驗到。
function msg(i) { return { id: i, role: i % 2 ? 'user' : 'ai', content: `第${i}句` }; }

test('回傳解析後的 {title, original_text}，且整串對話（非只最後 10 筆）都進 prompt', async () => {
  // 12 則訊息，最早一則必須出現在 prompt（證明沒有 LIMIT 10）
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push(msg(i));
  withMessages(rows);
  mockRunClaude.mockResolvedValue({
    text: '好的，我整理成任務：\n<result>{"title":"金額計算錯誤","original_text":"正式區某張單金額算錯，需檢查稅額計算"}</result>',
    usage: {}, durationMs: 1
  });

  const draft = await draftTaskFromChat(1, 2, 99);

  expect(draft).toEqual({ title: '金額計算錯誤', original_text: '正式區某張單金額算錯，需檢查稅額計算', attachments: [] });
  const prompt = mockRender.mock.calls[0][0].history;
  expect(prompt).toContain('第1句');   // 最早訊息在內
  expect(prompt).toContain('第12句');  // 最後訊息也在
  expect(mockRender.mock.calls[0][0].prior_history).toContain('無'); // 首次轉任務：沒有舊議題
});

// 同一場對話談完一件事轉成任務後，繼續談下一件事再轉一次——舊議題已經有任務在處理，
// 再摘一次會把兩件事混成同一張單（實測 chat 31：安庫請購綁定＋報價品用料，兩個不同的 bug）。
test('第二次轉任務：分界線之前只當背景，只有之後的內容進本次需求', async () => {
  const rows = [];
  for (let i = 1; i <= 6; i++) rows.push(msg(i));
  withMessages(rows, 4); // 前四則上次已轉成任務
  mockRunClaude.mockResolvedValue({
    text: '<result>{"title":"t","original_text":"o"}</result>', usage: {}, durationMs: 1
  });

  await draftTaskFromChat(1, 2, 99);

  const { history, prior_history } = mockRender.mock.calls[0][0];
  expect(history).toContain('第5句');       // 分界線之後＝本次要轉的
  expect(history).toContain('第6句');
  expect(history).not.toContain('第4句');   // 已轉過的不得混進本次需求
  expect(history).not.toContain('第1句');
  expect(prior_history).toContain('第1句'); // 但仍給得到背景（新議題常回指舊的）
  expect(prior_history).toContain('第4句');
});

// 分界線之後一則都沒有＝使用者想重轉同一件事。此時若照切，history 會是空字串，
// agent 拿不到任何內容只能憑空編一張需求出來——退回整串重摘才是安全的降級。
test('分界線之後沒有新訊息 → 退回整串重摘，不拿空白去問 agent', async () => {
  const rows = [msg(1), msg(2)];
  withMessages(rows, 2); // 分界線就在最後一則
  mockRunClaude.mockResolvedValue({
    text: '<result>{"title":"t","original_text":"o"}</result>', usage: {}, durationMs: 1
  });

  await draftTaskFromChat(1, 2, 99);

  const { history, prior_history } = mockRender.mock.calls[0][0];
  expect(history).toContain('第1句');
  expect(history).toContain('第2句');
  expect(prior_history).toContain('無'); // 不重複塞一份到背景區
});

test('絕不 INSERT 任務（只回草稿）', async () => {
  withMessages([{ id: 1, role: 'user', content: '有問題' }]);
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

// ── 挑圖 ────────────────────────────────────────────────────────────────────
// 「有需要的圖才進任務」是刻意的設計：全部照搬會讓分診／分析／開發帶著一堆只佐證當下一句話的
// 截圖跑，反而稀釋真正該看的那張。挑選交給 agent，但它回的編號一概不信——下面三支守的就是
// 「agent 說了算」與「agent 說什麼都照做」之間的那條線。
const att = (id, message_id, filename) => ({ id, message_id, filename, mimetype: 'image/png', file_path: `chat_9/${filename}` });

function resultWith(attachments) {
  return {
    text: `<result>{"title":"T","original_text":"O","attachments":${JSON.stringify(attachments)}}</result>`,
    usage: {}, durationMs: 1
  };
}

test('agent 挑中的標 chosen，沒挑中的也一併回傳（使用者要能勾回來）', async () => {
  withMessages([msg(1), msg(2)], null, [att(11, 1, 'a.png'), att(12, 2, 'b.png')]);
  mockRunClaude.mockResolvedValue(resultWith([11]));

  const draft = await draftTaskFromChat(1, 9, 99);

  expect(draft.attachments).toEqual([
    { id: 11, filename: 'a.png', chosen: true },
    { id: 12, filename: 'b.png', chosen: false }
  ]);
});

test('agent 回了清單上沒有的編號一律濾掉（模型編號是常態，不是例外）', async () => {
  withMessages([msg(1)], null, [att(11, 1, 'a.png')]);
  mockRunClaude.mockResolvedValue(resultWith([11, 999]));

  const draft = await draftTaskFromChat(1, 9, 99);

  expect(draft.attachments.map(a => a.id)).toEqual([11]);
  expect(draft.attachments[0].chosen).toBe(true);
});

test('分界線之前（已轉過任務）的圖不進候選——那些圖已跟著上一張任務走了', async () => {
  // msg 1~2 已轉過，msg 3 是本次；att 11 掛在舊訊息上、att 13 掛在本次訊息上
  withMessages([msg(1), msg(2), msg(3)], 2, [att(11, 1, 'old.png'), att(13, 3, 'new.png')]);
  mockRunClaude.mockResolvedValue(resultWith([11, 13]));

  const draft = await draftTaskFromChat(1, 9, 99);

  expect(draft.attachments.map(a => a.filename)).toEqual(['new.png']);
  // 連 prompt 都不該看到舊圖，否則 agent 每次都會想把它挑回來
  expect(mockRender.mock.calls[0][0].attachments).not.toContain('old.png');
  expect(mockRender.mock.calls[0][0].attachments).toContain('new.png');
});

test('沒有附圖時 prompt 明說「無」，不是留空洞', async () => {
  withMessages([msg(1)], null, []);
  mockRunClaude.mockResolvedValue(resultWith([]));

  await draftTaskFromChat(1, 9, 99);

  expect(mockRender.mock.calls[0][0].attachments).toContain('無');
});
