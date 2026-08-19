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
let userId, projectId, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('imguser', 'x', 'Img') RETURNING id"
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('ImgProj', '17.0') RETURNING id"
  );
  projectId = proj.id;

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
  const { rows: [stranger] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('stranger', 'x', 'Stranger') RETURNING id"
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
