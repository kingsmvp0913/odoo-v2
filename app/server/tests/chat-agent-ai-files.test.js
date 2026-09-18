// 意圖：chatReply 與收貨的接線。收貨本身在 chat-ai-files.test.js 驗；這支驗會在接線處靜默壞掉的事：
//   ① AI 真的拿得到本對話的出貨箱路徑（拿不到＝它不知道檔要放哪，功能整個不存在，而測試全綠）
//   ② 檔案掛在「這一輪的 AI 訊息」上（掛到使用者訊息或上一則，按鈕出現在錯的地方）
//   ③ 沒附上的檔要寫進回覆（DB 那則與 return 給前端的都要有）
//   ④ 上一輪殘留不被這輪誤收
//   ⑤ 收貨整個炸掉，回覆照樣送出、並講明附件失敗
//   ⑥ 中斷時已做好的檔掛到收尾訊息，原本的錯誤照樣往外拋
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-chat-agent-files-'));
process.env.UPLOAD_DIR = tmpRoot;

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

const { chatReply, CHAT_INTERRUPTED_MSG } = require('../pipeline/chat-agent');

const USER_MSG_ID = 500;
const AI_MSG_ID = 501;
let chatSeq = 0;
let chatId;
let outbox;
let calls;

const put = (name, content) => { fs.mkdirSync(outbox, { recursive: true }); fs.writeFileSync(path.join(outbox, name), content); };
const attachInserts = () => calls.filter(c => /INSERT INTO project_chat_attachments/.test(c[0]));
const contentUpdates = () => calls.filter(c => /UPDATE project_chat_messages SET content/.test(c[0]));

beforeEach(() => {
  chatId = String(++chatSeq);
  outbox = path.join(tmpRoot, `chat_${chatId}`, 'ai', 'outbox');
  calls = [];
  mockRunClaude.mockReset();
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql, params) => {
    calls.push([sql, params]);
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    if (/INSERT INTO project_chat_messages/.test(sql)) {
      return Promise.resolve({ rows: [{ id: params[1] === 'ai' ? AI_MSG_ID : USER_MSG_ID }] });
    }
    if (/INSERT INTO project_chat_attachments/.test(sql)) return Promise.resolve({ rows: [{ id: 1, filename: params[2], mimetype: params[3] }] });
    return Promise.resolve({ rows: [] });
  });
});

afterAll(() => {
  delete process.env.UPLOAD_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('fresh prompt 帶本對話的出貨箱路徑與 chatFiles skill 指引，沒有殘留 placeholder', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '好', usage: {}, durationMs: 1 });
  await chatReply('1', chatId, '做個報表', 99);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain(outbox);
  expect(prompt).toContain('chatFiles');
  expect(prompt).not.toContain('{{chat_files_dir}}');
});

test('AI 這輪做的檔掛到這一輪的 AI 訊息，不是使用者訊息', async () => {
  // 模擬 agent 執行途中寫檔（也順便證明本輪開頭的殘留隔離不會吃掉它們——隔離在 agent 起跑前）
  mockRunClaude.mockImplementationOnce(async () => {
    put('明細.csv', '品名,數量\n螺絲,3\n');
    return { text: '已做好明細表。', usage: {}, durationMs: 1 };
  });
  const { reply } = await chatReply('1', chatId, '做個明細', 99);

  expect(reply).toBe('已做好明細表。');
  const [ins] = attachInserts();
  expect(ins[1][0]).toBe(chatId);
  expect(ins[1][1]).toBe(AI_MSG_ID);
  expect(ins[1][2]).toBe('明細.csv');
  expect(contentUpdates()).toHaveLength(0);  // 全部合格就不動回覆內容
});

test('有沒附上的檔 → DB 那則與回傳給前端的回覆都帶 ⚠ 與原因', async () => {
  mockRunClaude.mockImplementationOnce(async () => {
    put('報表.xlsx', '其實是文字');
    return { text: '附上報表。', usage: {}, durationMs: 1 };
  });
  const { reply } = await chatReply('1', chatId, '做報表', 99);

  expect(reply).toContain('附上報表。');
  expect(reply).toContain('⚠ 以下檔案沒有附上');
  expect(reply).toContain('報表.xlsx');
  const [upd] = contentUpdates();
  expect(upd[1]).toEqual([AI_MSG_ID, reply]);
});

test('上一輪殘留在出貨箱 → 不會掛到這一輪', async () => {
  put('上一輪的.csv', 'x\n');
  mockRunClaude.mockResolvedValueOnce({ text: '好', usage: {}, durationMs: 1 });
  await chatReply('1', chatId, '新問題', 99);
  expect(attachInserts()).toHaveLength(0);
  expect(fs.readdirSync(path.dirname(outbox)).some(n => n.startsWith('_stale_'))).toBe(true);
});

test('收貨整個炸掉 → 回覆照樣送出，並寫明檔案附加失敗', async () => {
  // 出貨箱路徑被一個一般檔案佔住：隔離與收貨的 readdir 都會丟 ENOTDIR
  fs.mkdirSync(path.dirname(outbox), { recursive: true });
  fs.writeFileSync(outbox, 'not a dir');
  mockRunClaude.mockResolvedValueOnce({ text: '回覆本文', usage: {}, durationMs: 1 });

  const { reply } = await chatReply('1', chatId, '問題', 99);

  expect(reply).toContain('回覆本文');
  expect(reply).toContain('檔案附加失敗');
  expect(calls.some(c => /reply_pending = false/.test(c[0]))).toBe(true);
});

test('agent 中斷但已做好檔 → 掛到中斷收尾訊息，原本的錯誤照樣往外拋', async () => {
  mockRunClaude.mockImplementationOnce(async () => {
    put('半路做好的.csv', 'a\n');
    throw new Error('boom');
  });
  await expect(chatReply('1', chatId, '做檔', 99)).rejects.toThrow('boom');

  const [ins] = attachInserts();
  expect(ins[1][1]).toBe(AI_MSG_ID);
  const aiMsg = calls.find(c => /INSERT INTO project_chat_messages/.test(c[0]) && c[1][1] === 'ai');
  expect(aiMsg[1][2]).toBe(CHAT_INTERRUPTED_MSG);
});
