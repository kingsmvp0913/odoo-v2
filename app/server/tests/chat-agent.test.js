// 意圖：chat 不再是「wiki 優先」——wiki 只是來源之一，由助理按問題性質自選來源。
// 這裡鎖定 prompt 建構：帶入專案名、wiki 被明示為「參考來源之一」、且不再出現舊的
// 「請根據以下 Wiki 資料回答」這種把 wiki 當唯一權威的框架。
const mockRunClaude = jest.fn().mockResolvedValue({ text: '回覆', usage: {}, durationMs: 1 });
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...a) => mockRunClaude(...a) }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));

const { chatReply, recoverInterruptedChats, CHAT_INTERRUPTED_MSG } = require('../pipeline/chat-agent');

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
  expect(upsert[1]).toEqual(['1', 7, 'ts-tax-missing', '稅率漏帶', '# 原因\n稅率欄空', null]);

  // 顯示／存檔的回覆不含機器側通道
  expect(reply).toBe('確認了：稅率沒帶到才算錯。');
  const replyInsert = mockQuery.mock.calls.find(c => /INSERT INTO project_chat_messages/.test(c[0]) && c[1] && c[1][1] === 'ai');
  expect(replyInsert[1][2]).toBe('確認了：稅率沒帶到才算錯。');
  expect(replyInsert[1][2]).not.toContain('<memory>');
});

test('回覆含 <wiki-drift> → 入漂移佇列、回覆剝除側通道（不自動改文件）', async () => {
  mockRunClaude.mockResolvedValueOnce({
    text: '這頁寫錯了。\n<wiki-drift>{"slug":"sale-flow","reason":"頁面說自動確認，程式要手動"}</wiki-drift>',
    usage: {}, durationMs: 1
  });
  mockQuery.mockImplementation((sql) => {
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO wiki_drift/.test(sql)) return Promise.resolve({ rows: [{ id: 9 }] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });

  const reply = await chatReply('1', '2', '這功能頁對嗎', 99);

  const enqueue = mockQuery.mock.calls.find(c => /INSERT INTO wiki_drift/.test(c[0]));
  expect(enqueue).toBeTruthy();
  // params: [projectId, taskId, userId, source, slug, reason]
  expect(enqueue[1][3]).toBe('chat');
  expect(enqueue[1][4]).toBe('sale-flow');
  expect(enqueue[1][5]).toBe('頁面說自動確認，程式要手動');
  expect(reply).toBe('這頁寫錯了。');
  expect(reply).not.toContain('<wiki-drift>');
});

// #3：回覆進行中要有 server 端旗標（持久動畫）；中斷時 AI 方要留訊息（計未讀）。
test('成功回覆 → reply_pending 先設 true、finally 清為 false', async () => {
  const calls = [];
  mockQuery.mockImplementation((sql) => {
    calls.push([sql]);
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });
  await chatReply('1', '2', '正常問題', 99);
  expect(calls.some(c => /reply_pending = true/.test(c[0]))).toBe(true);
  expect(calls.some(c => /reply_pending = false/.test(c[0]))).toBe(true);
});

test('claude 出錯 → 補寫 AI 中斷訊息（role=ai 計未讀）＋清 reply_pending＋re-throw', async () => {
  mockRunClaude.mockRejectedValueOnce(new Error('boom'));
  const calls = [];
  mockQuery.mockImplementation((sql, params) => {
    calls.push([sql, params]);
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });
  await expect(chatReply('1', '2', '會壞的問題', 99)).rejects.toThrow('boom');
  const aiMsg = calls.find(c => /INSERT INTO project_chat_messages/.test(c[0]) && c[1] && c[1][1] === 'ai');
  expect(aiMsg).toBeTruthy();
  expect(aiMsg[1][2]).toBe(CHAT_INTERRUPTED_MSG);
  expect(calls.some(c => /reply_pending = false/.test(c[0]))).toBe(true); // finally 有清
});

test('recoverInterruptedChats → 每個卡住的對話補中斷訊息並清 pending', async () => {
  const calls = [];
  mockQuery.mockImplementation((sql, params) => {
    calls.push([sql, params]);
    if (/SELECT id FROM project_chats WHERE reply_pending = true/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 5 }, { id: 8 }] });
    }
    return Promise.resolve({ rows: [] });
  });
  const n = await recoverInterruptedChats();
  expect(n).toBe(2);
  const aiInserts = calls.filter(c =>
    /INSERT INTO project_chat_messages/.test(c[0]) && c[1] && c[1][1] === 'ai' && c[1][2] === CHAT_INTERRUPTED_MSG
  );
  expect(aiInserts.length).toBe(2);
  expect(calls.filter(c => /reply_pending = false/.test(c[0])).length).toBe(2);
});

// --- session 續接（with-resume）---
// 意圖：chat 的成本 98.8% 在 agentic 調查迴圈（prompt 僅佔 0.9%），而無狀態讓同一個問題被反覆
// 完整調查——實測一場九輪對話裡 AI 四次自我推翻，正是因為上一輪讀到的 code／DB／log 沒留在
// context 裡。續接輪必須只送「使用者這輪的話」，先前的探索靠 session 帶，不重送也不重查。
test('已有 session 且指紋相符 → 走續接輪，只送新發言、不重送 cs-capability 與 history', async () => {
  // 指紋除了兩支 agent 的版本，還折進「專案備註＋repo 清單」的雜湊——那兩樣只出現在 fresh prompt，
  // 不折進來的話備註改了也不會降級，同一場對話往後每輪都拿第一輪的快照回答。
  // 測試不複製那段算式（複製了就變成「自己對自己」）：先跑一輪 fresh 把它實際存下來的指紋撈出來，
  // 再拿同一個值驗續接，順帶把 round-trip 一起測到。
  const rows = (sql) => {
    if (/project_repos/.test(sql)) return { rows: [] };
    if (/FROM wiki_pages/.test(sql)) return { rows: [] };
    if (/FROM project_chat_messages/.test(sql)) return { rows: [{ role: 'user', content: '前一輪問題' }] };
    if (/FROM projects/.test(sql)) return { rows: [{ name: '鴻久' }] };
    return { rows: [] };
  };
  let storedVer = null;
  mockRunClaude.mockResolvedValueOnce({ text: '回覆', usage: {}, durationMs: 1, sessionId: 'sess-abc' });
  mockQuery.mockImplementation((sql, params) => {
    if (/chat_prompt_ver=\$3/.test(sql)) { storedVer = params[2]; return Promise.resolve({ rows: [] }); }
    return Promise.resolve(rows(sql));                      // 這一輪沒有 session → 走 fresh
  });
  await chatReply('1', '2', '第一輪問題', 99);
  expect(storedVer).toBeTruthy();

  mockRunClaude.mockClear();
  mockQuery.mockImplementation((sql) => {
    if (/FROM project_chats/.test(sql)) return Promise.resolve({ rows: [{ chat_session_id: 'sess-abc', chat_prompt_ver: storedVer }] });
    return Promise.resolve(rows(sql));
  });
  await chatReply('1', '2', '那 NAS 掛載斷過嗎', 99);

  const [prompt, opts] = mockRunClaude.mock.calls[0];
  expect(opts.resumeSessionId).toBe('sess-abc');      // 真的續接，不是 fresh
  expect(prompt).toContain('那 NAS 掛載斷過嗎');       // 只送這輪的話
  expect(prompt).toContain('不要重查已經查過的東西');   // 續接輪 prompt
  expect(prompt).not.toContain('/ai/wiki/pages');     // cs-capability 不重送（session 裡已有）
  expect(prompt).not.toContain('前一輪問題');          // history 不重送
});

// 意圖：專案備註只出現在 fresh prompt（chat-retry 只有 {{user_message}}）。續接輪不重讀的話，
// 使用者補上「本專案已客製出庫流程」之後，同一場對話往後每輪還是照原生行為回答——而且無聲。
// agent prompt 的版本指紋擋不住這種：備註變了，prompt 檔沒變。
test('專案備註改過 → 指紋不符，降級 fresh 重讀（不得沿用第一輪的快照）', async () => {
  const rows = (sql, notes) => {
    if (/project_repos/.test(sql)) return { rows: [] };
    if (/FROM wiki_pages/.test(sql)) return { rows: notes ? [{ content: notes }] : [] };
    if (/FROM project_chat_messages/.test(sql)) return { rows: [] };
    if (/FROM projects/.test(sql)) return { rows: [{ name: '鴻久' }] };
    return { rows: [] };
  };
  let storedVer = null;
  mockRunClaude.mockResolvedValueOnce({ text: '回覆', usage: {}, durationMs: 1, sessionId: 'sess-x' });
  mockQuery.mockImplementation((sql, params) => {
    if (/chat_prompt_ver=\$3/.test(sql)) { storedVer = params[2]; return Promise.resolve({ rows: [] }); }
    return Promise.resolve(rows(sql, null));               // 第一輪：還沒有備註
  });
  await chatReply('1', '2', '第一輪', 99);

  // 使用者這時候才補上專案備註
  mockRunClaude.mockClear();
  mockQuery.mockImplementation((sql) => {
    if (/FROM project_chats/.test(sql)) return Promise.resolve({ rows: [{ chat_session_id: 'sess-x', chat_prompt_ver: storedVer }] });
    return Promise.resolve(rows(sql, '本專案已客製出庫流程'));
  });
  await chatReply('1', '2', '出庫怎麼跑', 99);

  const [prompt, opts] = mockRunClaude.mock.calls[0];
  expect(opts.resumeSessionId).toBeUndefined();            // 不可續接舊 session
  expect(prompt).toContain('本專案已客製出庫流程');          // 新備註真的被讀進去
});

// 指紋是唯一擋得住「prompt 改了卻續用舊 session」的護欄——不比對就會讓新規則整場對話都不生效。
test('session 指紋不符（agent prompt 改過）→ 降級 fresh，不續接舊 session', async () => {
  mockQuery.mockImplementation((sql) => {
    if (/FROM project_chats/.test(sql)) return Promise.resolve({ rows: [{ chat_session_id: 'sess-old', chat_prompt_ver: 'stale-version' }] });
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });
  await chatReply('1', '2', '問題', 99);

  const [prompt, opts] = mockRunClaude.mock.calls[0];
  expect(opts.resumeSessionId).toBeUndefined();  // 不續接
  expect(prompt).toContain('/ai/wiki/pages');    // 走 fresh 完整 prompt
});

// session id 必須落地，否則下一則又是 fresh——整個機制等於沒接。
test('首輪回覆帶 session_id → 寫回 project_chats 供下一則續接', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '回覆', usage: {}, durationMs: 1, sessionId: 'sess-new' });
  await chatReply('1', '2', '第一個問題', 99);

  const saved = mockQuery.mock.calls.find(c => /UPDATE project_chats SET chat_session_id/.test(c[0]));
  expect(saved).toBeTruthy();
  expect(saved[1]).toEqual(['2', 'sess-new', expect.any(String)]);
});

// --- wiki 查法：中文專案名的 URL 編碼 ---
// 意圖：cs-capability 教 agent 用 curl 打 /ai/wiki?project=<X>。若 X 是未編碼的中文，Node 的
// HTTP parser 直接判 400——連 Express 都到不了，agent 只看到「wiki 查不到」，完全不指向網址問題。
// 實測受害：鴻久／北群醫／慈雲寶塔（有中文 name 的專案）。修法是傳已編碼的 folder_name。
test('中文專案名 → curl 指引用已編碼的 folder_name，不是原始中文', async () => {
  mockQuery.mockImplementation((sql) => {
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久', folder_name: 'odoo17_hungjou' }] });
    return Promise.resolve({ rows: [] });
  });
  await chatReply('1', '2', 'NAS 補寫沒在跑', 99);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('project=odoo17_hungjou');       // 用 folder_name
  expect(prompt).not.toContain('/ai/wiki/pages?project=鴻久'); // 不得出現未編碼中文網址
  expect(prompt).toContain('鴻久');                          // 顯示名仍在（對話正文要用）
});

// 沒設 folder_name 的專案會退回用 name。此時 name 若是中文，仍必須是編碼後的形式才不會 400。
test('無 folder_name 且 name 是中文 → 退回 name 但仍經過 URL 編碼', async () => {
  mockQuery.mockImplementation((sql) => {
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '慈雲寶塔', folder_name: null }] });
    return Promise.resolve({ rows: [] });
  });
  await chatReply('1', '2', 'q', 99);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain(`project=${encodeURIComponent('慈雲寶塔')}`);
  expect(prompt).not.toContain('/ai/wiki/pages?project=慈雲寶塔');
});

// --- 訊息附圖 ---
// 意圖：附圖註記必須同時出現在 fresh 與續接兩條 render 路徑。chat-retry.md 只有 {{user_message}}
// 這一個變數，所以註記若另開 placeholder 或只接在 fresh，續接的那些輪就完全看不到圖——
// 而那是零訊號的：畫面上圖好好的、對話照常回，只是 AI 沒看過那張圖。
const IMG = [{ id: 5, filename: 'err.png', mimetype: 'image/png', file_path: 'chat_2/err.png' }];

function withUserMsgInsert(base) {
  return (sql, params) => {
    if (/INSERT INTO project_chat_messages/.test(sql)) return Promise.resolve({ rows: [{ id: 77 }] });
    return base(sql, params);
  };
}

test('附圖 → fresh prompt 帶路徑與唯讀授權（少了授權那句 agent 會照規則跳過不讀）', async () => {
  const prev = mockQuery.getMockImplementation();
  mockQuery.mockImplementation(withUserMsgInsert(prev));

  await chatReply('1', '2', '這畫面怎麼了', 99, IMG);

  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('err.png');
  expect(prompt).toContain('明確授權');
});

test('附圖 → 續接輪同樣帶得到（chat-retry 只有 {{user_message}}，接錯地方這裡就會紅）', async () => {
  const rows = (sql) => {
    if (/project_repos/.test(sql)) return { rows: [] };
    if (/FROM wiki_pages/.test(sql)) return { rows: [] };
    if (/FROM project_chat_messages/.test(sql)) return { rows: [] };
    if (/FROM projects/.test(sql)) return { rows: [{ name: '鴻久' }] };
    return { rows: [] };
  };
  let storedVer = null;
  mockRunClaude.mockResolvedValueOnce({ text: '回覆', usage: {}, durationMs: 1, sessionId: 'sess-img' });
  mockQuery.mockImplementation(withUserMsgInsert((sql, params) => {
    if (/chat_prompt_ver=\$3/.test(sql)) { storedVer = params[2]; return Promise.resolve({ rows: [] }); }
    return Promise.resolve(rows(sql));
  }));
  await chatReply('1', '2', '第一輪', 99);

  mockRunClaude.mockClear();
  mockQuery.mockImplementation(withUserMsgInsert((sql) => {
    if (/FROM project_chats/.test(sql)) return Promise.resolve({ rows: [{ chat_session_id: 'sess-img', chat_prompt_ver: storedVer }] });
    return Promise.resolve(rows(sql));
  }));
  await chatReply('1', '2', '看這張', 99, IMG);

  const [prompt, opts] = mockRunClaude.mock.calls[0];
  expect(opts.resumeSessionId).toBe('sess-img');   // 確認真的是續接輪，否則這支測不到東西
  expect(prompt).toContain('err.png');
  expect(prompt).toContain('明確授權');
});

test('附圖路徑只進 prompt，不進存進 DB 的訊息內容（畫面上不該冒出一串本機路徑）', async () => {
  const prev = mockQuery.getMockImplementation();
  const inserts = [];
  mockQuery.mockImplementation((sql, params) => {
    if (/INSERT INTO project_chat_messages/.test(sql)) {
      inserts.push(params);
      return Promise.resolve({ rows: [{ id: 77 }] });
    }
    return prev(sql, params);
  });

  await chatReply('1', '2', '這畫面怎麼了', 99, IMG);

  const userInsert = inserts.find(p => p[1] === 'user');
  expect(userInsert[2]).toBe('這畫面怎麼了');
  expect(userInsert[2]).not.toContain('err.png');
});

test('附圖 → message_id 回填到剛插入的那則使用者訊息（不回填的話圖永遠不會出現在畫面上）', async () => {
  const prev = mockQuery.getMockImplementation();
  const binds = [];
  mockQuery.mockImplementation((sql, params) => {
    if (/INSERT INTO project_chat_messages/.test(sql)) return Promise.resolve({ rows: [{ id: 77 }] });
    if (/UPDATE project_chat_attachments SET message_id/.test(sql)) { binds.push(params); return Promise.resolve({ rows: [] }); }
    return prev(sql, params);
  });

  await chatReply('1', '2', 'x', 99, IMG);

  expect(binds).toEqual([[5, 77]]);
});
