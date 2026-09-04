const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-exam-upload';

const TOKEN = 'let-me-in-1234';
let app, dbModule, jwt, bankId, dataDir, uploadDir;

const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
const b64 = jpg.toString('base64');

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-data-'));
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-up-'));
  fs.mkdirSync(path.join(dataDir, 'exam'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'exam', 'upload-token.txt'), `${TOKEN}\n`);
  process.env.EXAM_DATA_DIR = dataDir;
  process.env.UPLOAD_DIR = uploadDir;

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const setup = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin' });
  jwt = setup.body.token;

  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('2026-09-04','19') RETURNING id`);
  bankId = b.rows[0].id;
});

afterAll(() => {
  dbModule._setPoolForTesting(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.EXAM_DATA_DIR;
  delete process.env.UPLOAD_DIR;
});

describe('認證（走 HTTP）', () => {
  test('本機來的免 token', async () => {
    const res = await request(app).post('/api/exam/batch')
      .send({ bank: '2026-09-04', items: [{ page: '1', answer: 'B', image: b64 }] });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toHaveLength(1);
  });

  test('帶對的 X-Token 放行', async () => {
    const res = await request(app).post('/api/exam/batch')
      .set('X-Token', TOKEN)
      .send({ bank: '2026-09-04', items: [{ page: '2', answer: 'A', image: b64 }] });
    expect(res.status).toBe(200);
  });
});

// 外部來源的行為直接測 middleware，不走 HTTP。
//
// 理由：supertest 的連線實際來自 127.0.0.1，isLocal 會正確地回 true，
// 所以「非本機該擋下來」這件事在 HTTP 層**根本測不到**。試著用 .set() 偽造
// header 也沒用——isLocal 刻意只看 socket.remoteAddress，那正是它的重點。
// 直接餵假的 req 才驗得到判斷邏輯本身。
describe('認證（直接測 middleware）', () => {
  const { checkExamToken } = require('../exam-upload-routes');

  const fakeReq = ({ ip = '10.0.0.9', headers = {}, query = {}, body = {} } = {}) => ({
    socket: { remoteAddress: ip },
    headers,
    query,
    body,
    get(name) { return headers[String(name).toLowerCase()]; },
  });
  const run = (req) => new Promise((resolve) => {
    const res = {
      status(code) { this._code = code; return this; },
      json(payload) { resolve({ code: this._code, payload }); },
    };
    checkExamToken(req, res, () => resolve({ code: 200, payload: null }));
  });

  test('外部來源沒帶 token 擋下', async () => {
    expect((await run(fakeReq())).code).toBe(401);
  });

  test('外部來源帶對 token 放行', async () => {
    expect((await run(fakeReq({ headers: { 'x-token': TOKEN } }))).code).toBe(200);
  });

  test('?token= 也認', async () => {
    expect((await run(fakeReq({ query: { token: TOKEN } }))).code).toBe(200);
  });

  // 同網段誰都設得出 X-Forwarded-For，看它等於把免驗證後門開放給整個網段
  test('偽造 X-Forwarded-For 不會被當成本機', async () => {
    const req = fakeReq({ headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } });
    expect((await run(req)).code).toBe(401);
  });

  // body 要等 multer／express.json 解析完才有，那時檔案已經落地了
  test('把 token 塞在 body 不算數', async () => {
    expect((await run(fakeReq({ body: { token: TOKEN } }))).code).toBe(401);
  });

  test('本機來源不需要 token', async () => {
    expect((await run(fakeReq({ ip: '127.0.0.1' }))).code).toBe(200);
    expect((await run(fakeReq({ ip: '::ffff:127.0.0.1' }))).code).toBe(200);
  });
});

describe('批次上傳', () => {
  test('單筆壞掉不讓整批失敗，具名回報', async () => {
    const res = await request(app).post('/api/exam/batch').send({
      bank: '2026-09-04',
      items: [
        { page: '10', answer: 'B', image: b64 },
        { page: '11', answer: '', image: b64 },          // 缺答案
        { page: '12', answer: 'C', image: '這不是圖片' },  // 圖片壞掉
        { page: '13', answer: 'D', image: b64 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted.map(a => a.page)).toEqual(['10', '13']);
    expect(res.body.rejected).toHaveLength(2);
    expect(res.body.rejected[0]).toMatchObject({ index: 1, page: '11' });
    expect(res.body.rejected[1].reason).toMatch(/圖片/);
  });

  test('找不到題庫回 400', async () => {
    const res = await request(app).post('/api/exam/batch')
      .send({ bank: '不存在的題庫', items: [{ page: '1', answer: 'B', image: b64 }] });
    expect(res.status).toBe(400);
  });

  test('空 items 回 400', async () => {
    const res = await request(app).post('/api/exam/batch').send({ bank: '2026-09-04', items: [] });
    expect(res.status).toBe(400);
  });

  test('超過批次上限回 400 且不寫入任何一筆', async () => {
    const before = (await dbModule.query('SELECT COUNT(*)::int c FROM exam_uploads')).rows[0].c;
    const many = Array.from({ length: 51 }, (_, i) => ({ page: String(i), answer: 'A', image: b64 }));
    const res = await request(app).post('/api/exam/batch').send({ bank: '2026-09-04', items: many });
    expect(res.status).toBe(400);
    const after = (await dbModule.query('SELECT COUNT(*)::int c FROM exam_uploads')).rows[0].c;
    expect(after).toBe(before);
  });
});

describe('落檔與紀錄', () => {
  test('圖片真的寫進磁碟，DB 存相對路徑', async () => {
    const res = await request(app).post('/api/exam/batch')
      .send({ bank: '2026-09-04', items: [{ page: '20', answer: 'B', image: b64, name: '小王' }] });
    const id = res.body.accepted[0].id;
    const row = (await dbModule.query(
      'SELECT image_path, responder, status, is_test FROM exam_uploads WHERE id = $1', [id])).rows[0];

    expect(row.responder).toBe('小王');
    expect(row.status).toBe('pending');
    expect(row.is_test).toBe(false);
    // 相對路徑，不得是絕對路徑（專案硬規則）
    expect(path.isAbsolute(row.image_path)).toBe(false);
    expect(fs.existsSync(path.join(uploadDir, row.image_path))).toBe(true);
  });

  test('test 旗標收得到', async () => {
    const res = await request(app).post('/api/exam/batch')
      .send({ bank: '2026-09-04', test: '1', items: [{ page: '21', answer: 'B', image: b64 }] });
    const row = (await dbModule.query(
      'SELECT is_test FROM exam_uploads WHERE id = $1', [res.body.accepted[0].id])).rows[0];
    expect(row.is_test).toBe(true);
  });
});

describe('佇列現況', () => {
  test('要平台帳號才看得到', async () => {
    await request(app).get('/api/exam/uploads').expect(401);
    const res = await request(app).get('/api/exam/uploads')
      .set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('status');
  });
});
