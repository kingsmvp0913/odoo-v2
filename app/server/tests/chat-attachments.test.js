// 意圖：對話上傳圖片這條路，「後端回 200」完全不構成證據——路徑存錯、message_id 沒回填、
// 下載端點沒驗歸屬、刪對話留孤兒檔，任何一項壞掉上傳本身都照樣成功。這支逐項守住。
// 附件真的傳到 agent 手上（chatReply 的第 5 個參數）是其中最關鍵的一項：少了它，畫面上圖好好的、
// AI 卻是瞎回，而且沒有任何訊號。
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = 'test-secret';
// 圖片會真的落地，導到暫存目錄（uploadRoot() 每次讀 env，設在 require 之前最保險）
const tmpUploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-chat-upload-'));
process.env.UPLOAD_DIR = tmpUploadRoot;

// sniffFile 只看前 4 個 byte，這串就足以被判成 image/png（測的是路由行為，不是解碼器）
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const mockChatReply = jest.fn();
jest.mock('../pipeline/chat-agent', () => ({ chatReply: (...a) => mockChatReply(...a) }));
jest.mock('../pipeline/chat-to-task', () => ({ draftTaskFromChat: jest.fn() }));
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));

let dbModule, app;
let userId, projectId, token, coId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  // Task 3 在每支對話端點前面加了 loadProjectForActor 範圍檢查：一般使用者必須綁公司、
  // 專案必須綁同一家公司才看得到（見 tenant-access.js canSeeProject）。這支測的是
  // 附件上傳／下載/歸屬，不是多租戶範圍，所以造一家公司、把測試用的專案綁給它、再把使用者的
  // company_id 指過去，讓新查核照它原本的判斷邏輯放行——使用者仍是一般 user，範圍檢查真的
  // 有跑；改成平台管理員只會讓檢查被短路，等於沒測到。
  const { rows: [co] } = await dbModule.query(
    "INSERT INTO companies (name, is_active, is_internal) VALUES ('ImgCo', true, false) RETURNING id"
  );
  coId = co.id;
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, company_id) VALUES ('imguser', 'x', 'Img', $1) RETURNING id",
    [coId]
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('ImgProj', '17.0') RETURNING id"
  );
  projectId = proj.id;
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [projectId, co.id]);

  const expressApp = express();
  expressApp.use(express.json());
  require('../chat-routes').registerRoutes(expressApp);
  app = expressApp;
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  delete process.env.UPLOAD_DIR;
  fs.rmSync(tmpUploadRoot, { recursive: true, force: true });
});

beforeEach(() => { mockChatReply.mockReset(); });

const auth = () => ({ Authorization: `Bearer ${token}` });
const chatDir = id => path.join(tmpUploadRoot, `chat_${id}`);

async function newChat(title = 'IMG') {
  const { rows: [chat] } = await dbModule.query(
    'INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,$2,$3) RETURNING id',
    [projectId, title, userId]
  );
  return chat;
}

function postImage(chatId, content, filename = 'shot.png', buf = PNG) {
  const req = request(app).post(`/api/projects/${projectId}/chats/${chatId}/messages`).set(auth());
  if (content !== null) req.field('content', content);
  return req.attach('files', buf, filename);
}

test('圖片落地、寫入附件列，並整包傳給 chatReply', async () => {
  const chat = await newChat();
  mockChatReply.mockResolvedValue('看到了');
  const res = await postImage(chat.id, '這是錯誤畫面');

  expect(res.status).toBe(200);
  const passed = mockChatReply.mock.calls[0][4];
  expect(passed).toHaveLength(1);
  // agent 讀得到圖的兩個前提：mimetype 由 magic bytes 判定、實體檔真的躺在磁碟上
  expect(passed[0].mimetype).toBe('image/png');
  expect(fs.existsSync(path.join(tmpUploadRoot, passed[0].file_path))).toBe(true);
});

test('純 JSON 呼叫仍是既有行為（附件參數為空陣列）', async () => {
  const chat = await newChat();
  mockChatReply.mockResolvedValue('ok');
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '純文字' });
  expect(res.status).toBe(200);
  expect(mockChatReply.mock.calls[0][4]).toEqual([]);
});

test('附件掛在送出它的那則使用者訊息上（message_id 有回填）', async () => {
  const chat = await newChat();
  // 真正的回填在 chat-agent 內，這裡被 mock 掉了 → 照它的契約模擬同一段
  mockChatReply.mockImplementation(async (pid, cid, content, uid, atts) => {
    const { rows: [m] } = await dbModule.query(
      "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'user',$2) RETURNING id",
      [cid, content]
    );
    for (const a of atts) {
      await dbModule.query('UPDATE project_chat_attachments SET message_id = $2 WHERE id = $1', [a.id, m.id]);
    }
    return 'ok';
  });
  await postImage(chat.id, '看這張', 'a.png');

  const res = await request(app).get(`/api/projects/${projectId}/chats/${chat.id}/messages`).set(auth());
  expect(res.status).toBe(200);
  const userMsg = res.body.find(m => m.role === 'user');
  expect(userMsg.attachments).toHaveLength(1);
  expect(userMsg.attachments[0].filename).toBe('a.png');
});

test('只貼一張圖、一個字都不打，也算一則訊息', async () => {
  const chat = await newChat();
  mockChatReply.mockResolvedValue('嗯');
  const res = await postImage(chat.id, null, 'only.png');
  expect(res.status).toBe(200);
});

test('文字與圖都沒有才是空訊息（400）', async () => {
  const chat = await newChat();
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '   ' });
  expect(res.status).toBe(400);
  expect(mockChatReply).not.toHaveBeenCalled();
});

test('非圖檔即使宣告成 image/png 也擋掉（判準是 magic bytes，不是 client 說什麼）', async () => {
  const chat = await newChat();
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).field('content', 'x')
    .attach('files', Buffer.from('MZ this is an exe'), { filename: 'evil.png', contentType: 'image/png' });
  expect(res.status).toBe(400);
  expect(mockChatReply).not.toHaveBeenCalled();
});

// 意圖：對話從「只收圖」開放成也收辦公室／ERP 文件。這幾支守的是使用者實際會傳的那幾種，
// 而且 mimetype 必須是後端自己判出來的——存錯的話 agent 那邊會照錯的型別選錯讀法。
test('PDF／Excel／CSV 都收得下，mimetype 由後端判定而非採信 client', async () => {
  const cases = [
    { filename: 'spec.pdf', buf: Buffer.from('%PDF-1.7 ...'), mime: 'application/pdf' },
    {
      filename: '出貨明細.xlsx',
      buf: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('..xl/workbook.xml..')]),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    { filename: 'export.csv', buf: Buffer.from('品號,數量\nA001,3\n'), mime: 'text/csv' },
    { filename: 'odoo.log', buf: Buffer.from('2026-09-09 ERROR something'), mime: 'text/plain' }
  ];
  for (const c of cases) {
    const chat = await newChat();
    mockChatReply.mockResolvedValue('收到');
    const res = await request(app)
      .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
      .set(auth()).field('content', '看一下這個')
      // client 一律宣告成 octet-stream：後端不該採信它
      .attach('files', c.buf, { filename: c.filename, contentType: 'application/octet-stream' });
    expect(res.status).toBe(200);
    const passed = mockChatReply.mock.calls.at(-1)[4];
    expect(passed[0].mimetype).toBe(c.mime);
    expect(fs.existsSync(path.join(tmpUploadRoot, passed[0].file_path))).toBe(true);
  }
});

// 純文字類沒有 magic bytes，是唯一必須信副檔名的一類——所以要確認副檔名不是繞過嗅測的後門。
test('二進位內容套個 .csv 副檔名一樣擋掉；未開放的檔型（.zip）也擋掉', async () => {
  const chat = await newChat();
  const binaryAsCsv = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).field('content', 'x')
    .attach('files', Buffer.from([0x41, 0x00, 0x42]), { filename: 'evil.csv' });
  expect(binaryAsCsv.status).toBe(400);

  const chat2 = await newChat();
  const zip = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat2.id}/messages`)
    .set(auth()).field('content', 'x')
    .attach('files', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x11]), { filename: 'pack.zip' });
  expect(zip.status).toBe(400);
  expect(mockChatReply).not.toHaveBeenCalled();
});

test('回覆進行中被擋下時不留孤兒檔（落地必須在搶佔之後）', async () => {
  const chat = await newChat();
  await dbModule.query('UPDATE project_chats SET reply_pending = true WHERE id = $1', [chat.id]);
  const res = await postImage(chat.id, 'x', 'race.png');
  expect(res.status).toBe(409);
  expect(fs.existsSync(chatDir(chat.id))).toBe(false);
  const { rows } = await dbModule.query('SELECT id FROM project_chat_attachments WHERE chat_id = $1', [chat.id]);
  expect(rows).toHaveLength(0);
});

test('下載：本人拿得到；同一人的另一場對話拿不到（附件 id 有綁 chat_id）', async () => {
  const chat = await newChat();
  mockChatReply.mockResolvedValue('ok');
  await postImage(chat.id, 'x', 'dl.png');
  const { rows: [att] } = await dbModule.query(
    'SELECT id FROM project_chat_attachments WHERE chat_id = $1', [chat.id]
  );

  let res = await request(app)
    .get(`/api/projects/${projectId}/chats/${chat.id}/attachments/${att.id}/download`).set(auth());
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/image\/png/);

  const other = await newChat('OTHER');
  res = await request(app)
    .get(`/api/projects/${projectId}/chats/${other.id}/attachments/${att.id}/download`).set(auth());
  expect(res.status).toBe(404);
});

test('下載：別人的對話一律 404', async () => {
  const chat = await newChat();
  mockChatReply.mockResolvedValue('ok');
  await postImage(chat.id, 'x', 'mine.png');
  const { rows: [att] } = await dbModule.query(
    'SELECT id FROM project_chat_attachments WHERE chat_id = $1 ORDER BY id DESC', [chat.id]
  );
  // stranger 也要綁進同一家公司：沒公司的話下面這支 404 會在 loadProjectForActor
  // 那層（看不到專案）就先擋下來，永遠到不了 getOwnedChat（這支真正要驗的「不是這場對話
  // 的人下載不到」）。綁了同一家公司後，範圍檢查放行、後面的 404 才是歸屬檢查真的擋下的。
  const { rows: [stranger] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, company_id) VALUES ('stranger', 'x', 'Stranger', $1) RETURNING id",
    [coId]
  );
  const strangerToken = jwt.sign({ userId: stranger.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const res = await request(app)
    .get(`/api/projects/${projectId}/chats/${chat.id}/attachments/${att.id}/download`)
    .set({ Authorization: `Bearer ${strangerToken}` });
  expect(res.status).toBe(404);
});

test('刪除對話連磁碟上的圖一起清掉（附件列靠 CASCADE，實體檔沒人管就成孤兒）', async () => {
  const chat = await newChat();
  mockChatReply.mockResolvedValue('ok');
  await postImage(chat.id, 'x', 'gone.png');
  expect(fs.existsSync(chatDir(chat.id))).toBe(true);

  const res = await request(app).delete(`/api/projects/${projectId}/chats/${chat.id}`).set(auth());
  expect(res.status).toBe(200);
  expect(fs.existsSync(chatDir(chat.id))).toBe(false);
});
