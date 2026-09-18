// 意圖：AI 做好的檔要變成「掛在產生它的那則回覆底下的下載按鈕」。這支守住收貨那一段會靜默壞掉的事：
//   ① 合格檔真的掛到指定的 message_id（掛錯則按鈕出現在別則、或根本不出現）
//   ② 同名檔跨輪不互蓋（舊回覆的按鈕不能變成下載新檔）
//   ③ 不合格的檔不收、但有原因回報（呼叫端要寫進回覆，不可安靜消失）
//   ④ symlink 不收，也不動到它指向的檔（否則 AI 一個連結就能把設定檔變成下載）
//   ⑤ 上一輪崩潰的殘留要隔離，不能被下一輪誤收
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-chat-ai-files-'));
process.env.UPLOAD_DIR = tmpRoot;

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));

const { chatAiDir, chatAiOutbox, collectChatAiFiles, quarantineStaleOutbox } = require('../lib/chat-ai-files');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// sniffFile 認 xlsx 只看 zip 檔頭＋前段含 xl/（測的是收貨行為，不是解碼器）
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....xl/workbook.xml')]);

let chatSeq = 0;
let chatId;
let outbox;
const put = (name, buf) => { fs.mkdirSync(outbox, { recursive: true }); fs.writeFileSync(path.join(outbox, name), buf); };
const inserts = () => mockQuery.mock.calls.filter(c => /INSERT INTO project_chat_attachments/.test(c[0]));

beforeEach(() => {
  chatId = String(++chatSeq);
  outbox = chatAiOutbox(chatId);
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql, params) => Promise.resolve({ rows: [{ id: 100, filename: params[2], mimetype: params[3] }] }));
});

afterAll(() => {
  delete process.env.UPLOAD_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('出貨箱在 uploadRoot 底下的 chat_<id>/ai/outbox（刪對話的 deleteChatDir 才收得掉）', () => {
  expect(outbox).toBe(path.join(tmpRoot, `chat_${chatId}`, 'ai', 'outbox'));
});

test('出貨箱不存在（AI 這輪沒做檔）→ 什麼都不做', async () => {
  expect(await collectChatAiFiles(chatId, 7)).toEqual({ attached: [], rejected: [] });
  expect(mockQuery).not.toHaveBeenCalled();
});

test('合格的 xlsx／csv／png 搬進 msg_<訊息id>/ 並掛到那則回覆', async () => {
  put('銷售報表.xlsx', XLSX);
  put('明細.csv', Buffer.from('品名,數量\n螺絲,3\n'));
  put('圖表.png', PNG);

  const { attached, rejected } = await collectChatAiFiles(chatId, 42);

  expect(rejected).toEqual([]);
  expect(attached).toHaveLength(3);
  const rows = inserts().map(c => c[1]);
  for (const [cid, mid, , , filePath] of rows) {
    expect(cid).toBe(chatId);
    expect(mid).toBe(42);
    // DB 存相對 uploadRoot 的路徑，既有下載端點用 readAttachmentFile 讀得到
    expect(fs.existsSync(path.join(tmpRoot, filePath))).toBe(true);
    expect(filePath.startsWith(path.join(`chat_${chatId}`, 'ai', 'msg_42'))).toBe(true);
  }
  // 顯示用檔名保留 AI 取的原名（中文），mime 以內容為準
  expect(rows.map(r => r[2]).sort()).toEqual(['圖表.png', '明細.csv', '銷售報表.xlsx'].sort());
  expect(rows.find(r => r[2] === '圖表.png')[3]).toBe('image/png');
  // 出貨箱清空了，下一輪不會重複收
  expect(fs.readdirSync(outbox)).toEqual([]);
});

// 容器只把出貨箱掛成可寫（lib/agent-mounts.js）。已交付的檔若留在出貨箱裡，AI 就能改掉或刪掉
// 舊回覆的下載檔——那是靜默的，使用者點下去才發現內容變了。
test('已收貨的 msg_* 落在出貨箱的上一層，不在出貨箱裡', async () => {
  put('報表.csv', Buffer.from('a\n'));
  await collectChatAiFiles(chatId, 42);
  expect(fs.existsSync(path.join(chatAiDir(chatId), 'msg_42'))).toBe(true);
  expect(fs.existsSync(path.join(outbox, 'msg_42'))).toBe(false);
});

test('兩個中文檔名不會在磁碟上撞成同一個檔（safeSeg 會把中文換成底線）', async () => {
  put('報表.csv', Buffer.from('a\n'));
  put('銷售.csv', Buffer.from('b\n'));
  await collectChatAiFiles(chatId, 5);
  const paths = inserts().map(c => c[1][4]);
  expect(new Set(paths).size).toBe(2);
  const contents = paths.map(p => fs.readFileSync(path.join(tmpRoot, p), 'utf8')).sort();
  expect(contents).toEqual(['a\n', 'b\n']);
});

test('兩輪做同名檔 → 各自一份實體檔，第一輪的按鈕下載到的仍是第一輪的內容', async () => {
  put('報表.csv', Buffer.from('第一版\n'));
  await collectChatAiFiles(chatId, 1);
  put('報表.csv', Buffer.from('第二版\n'));
  await collectChatAiFiles(chatId, 2);

  const [first, second] = inserts().map(c => c[1][4]);
  expect(first).not.toBe(second);
  expect(fs.readFileSync(path.join(tmpRoot, first), 'utf8')).toBe('第一版\n');
  expect(fs.readFileSync(path.join(tmpRoot, second), 'utf8')).toBe('第二版\n');
});

test('副檔名與內容不符 → 不收、有原因、檔案從出貨箱移除', async () => {
  put('假的.xlsx', Buffer.from('其實是文字'));
  put('執行檔.exe', PNG);
  const { attached, rejected } = await collectChatAiFiles(chatId, 3);
  expect(attached).toEqual([]);
  expect(rejected.map(r => r.filename).sort()).toEqual(['假的.xlsx', '執行檔.exe'].sort());
  expect(rejected.every(r => r.reason)).toBe(true);
  expect(inserts()).toHaveLength(0);
  expect(fs.readdirSync(outbox)).toEqual([]);
});

test('.jpeg 與 .jpg 視為同一種', async () => {
  put('photo.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
  const { attached, rejected } = await collectChatAiFiles(chatId, 3);
  expect(rejected).toEqual([]);
  expect(attached).toHaveLength(1);
});

test('symlink 不收，而且它指向的檔毫髮無傷', async () => {
  const secret = path.join(tmpRoot, `secret-${chatId}.json`);
  fs.writeFileSync(secret, '{"password":"x"}');
  fs.mkdirSync(outbox, { recursive: true });
  fs.symlinkSync(secret, path.join(outbox, 'config.json'));

  const { attached, rejected } = await collectChatAiFiles(chatId, 9);

  expect(attached).toEqual([]);
  expect(rejected).toEqual([{ filename: 'config.json', reason: expect.stringContaining('連結') }]);
  expect(fs.readFileSync(secret, 'utf8')).toBe('{"password":"x"}');
  expect(fs.existsSync(path.join(outbox, 'config.json'))).toBe(false);
});

test('AI 開了子資料夾 → 不收，並講清楚要放在這一層', async () => {
  fs.mkdirSync(path.join(outbox, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(outbox, 'reports', 'a.csv'), 'x\n');
  const { rejected } = await collectChatAiFiles(chatId, 9);
  expect(rejected).toEqual([{ filename: 'reports', reason: expect.stringContaining('這一層') }]);
});

test('6 個合格檔 → 前 5 個掛上，第 6 個回報超過上限', async () => {
  for (let i = 1; i <= 6; i++) put(`f${i}.txt`, Buffer.from(`${i}\n`));
  const { attached, rejected } = await collectChatAiFiles(chatId, 4);
  expect(attached).toHaveLength(5);
  expect(rejected).toEqual([{ filename: 'f6.txt', reason: expect.stringContaining('上限') }]);
});

test('前幾輪已收貨的 msg_* 不會被重複收', async () => {
  put('舊.csv', Buffer.from('old\n'));
  await collectChatAiFiles(chatId, 1);
  mockQuery.mockClear();
  const result = await collectChatAiFiles(chatId, 2);
  expect(result).toEqual({ attached: [], rejected: [] });
  expect(inserts()).toHaveLength(0);
});

test('INSERT 失敗 → 以原因回報，不往外拋（對話回覆不能因為附件失敗而失敗）', async () => {
  put('a.csv', Buffer.from('a\n'));
  mockQuery.mockRejectedValueOnce(new Error('db down'));
  const { attached, rejected } = await collectChatAiFiles(chatId, 1);
  expect(attached).toEqual([]);
  expect(rejected).toEqual([{ filename: 'a.csv', reason: expect.stringContaining('db down') }]);
});

test('上一輪殘留 → 整批隔離到上一層的 _stale_*，之後收貨收不到它們', async () => {
  put('殘留.csv', Buffer.from('x\n'));
  expect(quarantineStaleOutbox(chatId)).toBe(1);
  const stale = fs.readdirSync(chatAiDir(chatId)).find(n => n.startsWith('_stale_'));
  expect(stale).toBeTruthy();
  expect(fs.existsSync(path.join(chatAiDir(chatId), stale, '殘留.csv'))).toBe(true);
  expect(fs.readdirSync(outbox)).toEqual([]);
  expect(await collectChatAiFiles(chatId, 8)).toEqual({ attached: [], rejected: [] });
});

test('出貨箱是空的或不存在 → 隔離什麼都不做', () => {
  expect(quarantineStaleOutbox(chatId)).toBe(0);
  fs.mkdirSync(outbox, { recursive: true });
  expect(quarantineStaleOutbox(chatId)).toBe(0);
  expect(fs.readdirSync(outbox)).toEqual([]);
});
