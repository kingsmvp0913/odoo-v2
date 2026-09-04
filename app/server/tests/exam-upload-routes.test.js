const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { newDb } = require('pg-mem');

const mockRunQueue = jest.fn(async () => ({ jobId: null, total: 0, done: 0, failed: 0 }));
jest.mock('../lib/exam/worker', () => ({ runQueue: (...args) => mockRunQueue(...args) }));

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

  // 作戰台頁面的瀏覽器來自區網（isLocal 為 false），但它有平台帳號。少了這條，
  // 已登入的使用者上傳一律 401，而畫面上的訊息會指向「通行碼」——離真因很遠。
  test('外部來源帶平台 JWT 放行', async () => {
    expect((await run(fakeReq({ headers: { authorization: `Bearer ${jwt}` } }))).code).toBe(200);
  });

  test('壞掉的 JWT 不放行', async () => {
    expect((await run(fakeReq({ headers: { authorization: 'Bearer not-a-real-token' } }))).code).toBe(401);
  });

  test('本機來源不需要 token', async () => {
    expect((await run(fakeReq({ ip: '127.0.0.1' }))).code).toBe(200);
    expect((await run(fakeReq({ ip: '::ffff:127.0.0.1' }))).code).toBe(200);
  });
});

describe('批次上傳', () => {
  beforeEach(() => mockRunQueue.mockClear());

  test('POST 收下後自動啟動該題庫的 worker', async () => {
    const res = await request(app).post('/api/exam/batch').send({
      bank: '2026-09-04', items: [{ page: '9', answer: 'B', image: b64 }],
    });
    expect(res.status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expect(mockRunQueue).toHaveBeenCalledWith(dbModule, expect.objectContaining({ bankId }));
  });

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
    const rows = await dbModule.query(
      `SELECT batch_key FROM exam_uploads WHERE id=$1 OR id=$2 ORDER BY id`,
      res.body.accepted.map(x => x.id));
    expect(rows.rows.map(x => x.batch_key)).toEqual([res.body.batch, res.body.batch]);
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

  test('工作歷程要平台帳號', async () => {
    await request(app).get('/api/exam/jobs').expect(401);
    await request(app).get('/api/exam/jobs').set('Authorization', `Bearer ${jwt}`).expect(200);
  });
});

describe('觸發佇列', () => {
  const auth = r => r.set('Authorization', `Bearer ${jwt}`);

  test('要平台帳號', async () => {
    await request(app).post('/api/exam/run').send({ bank: bankId }).expect(401);
  });

  test('缺 bank 回 400', async () => {
    await auth(request(app).post('/api/exam/run')).send({}).expect(400);
  });

  test('沒有待處理時回 400 而不是空跑', async () => {
    const b = await dbModule.query(
      `INSERT INTO exam_banks (label, odoo_version) VALUES ('空的','19') RETURNING id`);
    const res = await auth(request(app).post('/api/exam/run')).send({ bank: b.rows[0].id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/沒有待處理/);
  });

  // 只說「還在跑」等於沒說——使用者看不到進度就會再按一次，然後以為壞了
  test('已有工作在跑時的 409 要講得出在跑什麼、多久、進度到哪', async () => {
    await dbModule.query(
      `INSERT INTO exam_jobs (bank_id, status, phase, pages_done, pages_total, started_at)
       VALUES ($1,'running','審查中',3,19, NOW() - INTERVAL '7 minutes')`, [bankId]);
    const res = await auth(request(app).post('/api/exam/run')).send({ bank: bankId });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/審查中/);
    expect(res.body.error).toMatch(/7 分鐘/);
    expect(res.body.error).toMatch(/3\/19/);
    await dbModule.query(`UPDATE exam_jobs SET status='done' WHERE status='running'`);
  });
});

describe('考試結果、投票與最後答案', () => {
  const auth = r => r.set('Authorization', `Bearer ${jwt}`);
  let attemptId, openAttemptId;

  beforeAll(async () => {
    const item = await dbModule.query(
      `INSERT INTO exam_items
         (odoo_version,fingerprint,question_en,options,qtype,answer_official,official_from,confidence)
       VALUES ('19','dashboard-official','Official dashboard question',$1,'single',$2,'manual',100)
       RETURNING id`,
      [JSON.stringify([{ letter: 'A', text: 'One' }, { letter: 'B', text: 'Two' }]), ['B']]);
    const up = await dbModule.query(
      `INSERT INTO exam_uploads (bank_id,batch_key,page,answer_raw,image_path,status)
       VALUES ($1,'batch-dashboard','31','A','exam-test/x.jpg','done') RETURNING id`, [bankId]);
    const attempt = await dbModule.query(
      `INSERT INTO exam_attempts (item_id,bank_id,upload_id,page,no,answer_their,answer_final)
       VALUES ($1,$2,$3,'31',1,$4,NULL) RETURNING id`,
      [item.rows[0].id, bankId, up.rows[0].id, ['A']]);
    attemptId = attempt.rows[0].id;
    await dbModule.query(
      `INSERT INTO exam_votes (attempt_id,voter_key,answer) VALUES
       ($1,'official-v1',$2),($1,'official-v2',$3),($1,'official-v3',$2)`,
      [attemptId, ['B'], ['A']]);

    const openItem = await dbModule.query(
      `INSERT INTO exam_items
         (odoo_version,fingerprint,question_en,options,qtype,confidence)
       VALUES ('19','dashboard-open','Open dashboard question',$1,'single',90)
       RETURNING id`,
      [JSON.stringify([{ letter: 'A', text: 'One' }, { letter: 'B', text: 'Two' }])]);
    const openAttempt = await dbModule.query(
      `INSERT INTO exam_attempts (item_id,bank_id,upload_id,page,no,answer_their,answer_final)
       VALUES ($1,$2,$3,'31',2,$4,$4) RETURNING id`,
      [openItem.rows[0].id, bankId, up.rows[0].id, ['A']]);
    openAttemptId = openAttempt.rows[0].id;
  });

  test('工作台分開回傳輸入、官方審查、投票與可空白最後答案', async () => {
    const res = await auth(request(app).get(`/api/exam/dashboard?bank=${bankId}`)).expect(200);
    const row = res.body.attempts.find(x => x.attempt_id === attemptId);
    expect(row).toMatchObject({
      answer_their: ['A'], answer_final: null,
      review_answer: ['B'], review_source: 'official', review_confidence: 100,
      vote_total: 3, vote_options: { A: 1, B: 2 },
    });
  });

  test('投票不顯示姓名，但同一平台使用者每題只能投一次', async () => {
    await auth(request(app).post(`/api/exam/attempts/${openAttemptId}/vote`))
      .send({ answer: 'A' }).expect(200);
    await auth(request(app).post(`/api/exam/attempts/${openAttemptId}/vote`))
      .send({ answer: 'B' }).expect(409);
    const count = await dbModule.query(
      `SELECT COUNT(*)::int c FROM exam_votes WHERE attempt_id=$1`, [openAttemptId]);
    expect(count.rows[0].c).toBe(1);
    const dashboard = await auth(request(app).get(`/api/exam/dashboard?bank=${bankId}`)).expect(200);
    expect(dashboard.body.attempts.find(x => x.attempt_id === openAttemptId).has_voted).toBe(true);
  });

  test('最後答案可以填入，也可以清回 NULL', async () => {
    let res = await auth(request(app).patch(`/api/exam/attempts/${openAttemptId}/final`))
      .send({ answer: 'B' }).expect(200);
    expect(res.body.answer).toEqual(['B']);
    res = await auth(request(app).patch(`/api/exam/attempts/${openAttemptId}/final`))
      .send({ answer: [] }).expect(200);
    expect(res.body.answer).toBeNull();
    const row = await dbModule.query(
      `SELECT answer_final FROM exam_attempts WHERE id=$1`, [openAttemptId]);
    expect(row.rows[0].answer_final).toBeNull();
  });

  test('官方確認題的投票與正式答案都由 server 鎖定', async () => {
    await auth(request(app).post(`/api/exam/attempts/${attemptId}/vote`))
      .send({ answer: 'A' }).expect(409);
    await auth(request(app).patch(`/api/exam/attempts/${attemptId}/final`))
      .send({ answer: [] }).expect(409);
  });
});
