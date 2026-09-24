/**
 * exam-byok-identity.test.js — 上傳時把「這一頁算誰的」記進資料列（規格 §3.1）
 *
 * 為什麼不能只看 token：token 只活在請求那一瞬間，判題活得比它久。平台重啟後的
 * 續跑（index.js 的 reclaimInterrupted → scheduleQueue）完全沒有發起人，而
 * buildClaudeAuthEnv(null) 的行為是「用平台訂閱」——客戶的考試只要遇到一次重啟，
 * 錢就靜靜回到廠商頭上，而且不會報錯，只會在月底帳單上出現。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const request = require('supertest');
const { newDb } = require('pg-mem');

// 判題不在這支的範圍：這裡只驗「身分有沒有落進 DB」。
const mockRunQueue = jest.fn(async () => ({ jobId: null, total: 0, done: 0, failed: 0 }));
jest.mock('../lib/exam/worker', () => ({ runQueue: (...a) => mockRunQueue(...a) }));

process.env.JWT_SECRET = 'test-exam-byok-identity';

const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
const b64 = jpg.toString('base64');

let app, server, dbModule, jwt, adminId, dataDir, uploadDir, baseUrl;

const tokenFile = () => path.join(dataDir, 'exam', 'upload-token.json');
// 來源位址指定成 127.0.0.2，伺服器那側才會看到「非本機」。
const outsider = () => new http.Agent({ localAddress: '127.0.0.2' });
const userIdOfPage = async (page) => (await dbModule.query(
  `SELECT user_id FROM exam_uploads WHERE page = $1`, [page])).rows[0].user_id;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-id-data-'));
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-id-up-'));
  fs.mkdirSync(path.join(dataDir, 'exam'), { recursive: true });
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
  adminId = require('jsonwebtoken').decode(jwt).userId;

  await dbModule.query(`INSERT INTO exam_banks (label, odoo_version) VALUES ('byok','19')`);

  // **刻意不從 127.0.0.1 連。** isLocal 免 token 那條排在最前面，會吃掉所有其他
  // 判斷，於是「JWT 那條有沒有把身分記下來」在 HTTP 層根本測不到（supertest 的
  // 連線一律來自 127.0.0.1）。
  //
  // 光是「連到 127.0.0.2」不夠：實測預設來源位址仍是 127.0.0.1（loopback 的路由
  // 就是這樣挑 src 的），伺服器那側看到的還是本機。必須用 localAddress 指定來源。
  server = app.listen(0, '0.0.0.0');
  await new Promise(r => server.once('listening', r));
  baseUrl = `http://127.0.0.2:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise(r => server.close(r));
  dbModule._setPoolForTesting(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.EXAM_DATA_DIR;
  delete process.env.UPLOAD_DIR;
});

describe('共用通行碼記得是誰產的', () => {
  const { issueUploadToken, peekUploadToken } = require('../lib/exam/upload');

  // 這把碼是給「不想開平台帳號的同事」用的旁路，本身不屬於任何帳號。但它只能由
  // 已登入的人產生，所以「誰產的」就是唯一算得出來的歸屬。同時只有一把有效
  // （重產即失效），因此不會有歧義。
  test('產碼時記下發放者，讀回來拿得到', () => {
    issueUploadToken(dataDir, 7);
    expect(peekUploadToken(dataDir)).toMatchObject({ issuedBy: 7 });
  });

  // 升級前產生的碼沒有這一欄。必須落成 null（＝內部）而不是 undefined 一路流到
  // INSERT——pg 對 undefined 的處理是靠運氣，而這一欄決定誰付錢。
  test('舊格式的碼（沒有 issued_by）當成內部', () => {
    fs.writeFileSync(tokenFile(), JSON.stringify({ token: 'old-shape', expires_at: Date.now() + 3600e3 }));
    expect(peekUploadToken(dataDir).issuedBy).toBeNull();
  });
});

describe('checkExamToken 解出「這一次是誰」', () => {
  const { checkExamToken } = require('../exam-upload-routes');
  const { issueUploadToken } = require('../lib/exam/upload');

  const fakeReq = ({ ip = '10.0.0.9', headers = {} } = {}) => ({
    socket: { remoteAddress: ip }, headers, query: {}, body: {},
    get(n) { return headers[String(n).toLowerCase()]; },
  });
  const run = (req) => new Promise((resolve) => {
    const res = { status(c) { this._c = c; return this; }, json() { resolve(this._c); } };
    checkExamToken(req, res, () => resolve(200));
  });

  test('本機免 token → 算內部（null，用平台訂閱）', async () => {
    const req = fakeReq({ ip: '127.0.0.1' });
    expect(await run(req)).toBe(200);
    expect(req.examUserId).toBeNull();
  });

  test('平台帳號 JWT → 算那個帳號', async () => {
    const req = fakeReq({ headers: { authorization: `Bearer ${jwt}` } });
    expect(await run(req)).toBe(200);
    expect(req.examUserId).toBe(adminId);
  });

  test('共用通行碼 → 算產碼的那個人', async () => {
    const t = issueUploadToken(dataDir, adminId);
    const req = fakeReq({ headers: { 'x-token': t.token } });
    expect(await run(req)).toBe(200);
    expect(req.examUserId).toBe(adminId);
  });

  test('舊格式通行碼 → 算內部（null），不是 undefined', async () => {
    fs.writeFileSync(tokenFile(), JSON.stringify({ token: 'old-shape', expires_at: Date.now() + 3600e3 }));
    const req = fakeReq({ headers: { 'x-token': 'old-shape' } });
    expect(await run(req)).toBe(200);
    expect(req.examUserId).toBeNull();
  });
});

describe('身分落進 exam_uploads.user_id（走真 HTTP）', () => {
  test('批次上傳帶平台 JWT → 記下那個帳號', async () => {
    const res = await request(baseUrl).post('/api/exam/batch')
      .agent(outsider())
      .set('Authorization', `Bearer ${jwt}`)
      .send({ bank: 'byok', items: [{ page: '11', answer: 'A', image: b64 }] });
    expect(res.status).toBe(200);
    expect(await userIdOfPage('11')).toBe(adminId);
  });

  test('單筆上傳（multipart）帶平台 JWT → 記下那個帳號', async () => {
    const res = await request(baseUrl).post('/api/exam/submit')
      .agent(outsider())
      .set('Authorization', `Bearer ${jwt}`)
      .field('page', '12').field('answer', 'B').field('bank', 'byok')
      .attach('screenshot', jpg, 'p.jpg');
    expect(res.status).toBe(200);
    expect(await userIdOfPage('12')).toBe(adminId);
  });

  test('本機上傳 → null（內部，用平台訂閱）', async () => {
    const res = await request(app).post('/api/exam/batch')
      .send({ bank: 'byok', items: [{ page: '13', answer: 'A', image: b64 }] });
    expect(res.status).toBe(200);
    expect(await userIdOfPage('13')).toBeNull();
  });

  // 重啟續跑那條路沒有發起人，它只能靠 DB 這一欄。欄位讀不回來就等於靜默改用
  // 廠商的訂閱——這條測的就是「撐不撐得過重啟」。
  test('身分是從 DB 讀回來的，重跑不依賴記憶體', async () => {
    const { rows } = await dbModule.query(
      `SELECT page, user_id FROM exam_uploads WHERE page IN ('11','13') ORDER BY page`);
    expect(rows).toEqual([
      { page: '11', user_id: adminId },
      { page: '13', user_id: null },
    ]);
  });
});
