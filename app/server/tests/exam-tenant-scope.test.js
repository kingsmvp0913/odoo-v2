/**
 * exam-tenant-scope.test.js — 客戶只看得到自己公司的考試場次
 * （規格 `2026-09-24-exam-tenant-scope-design.md` §4）
 *
 * 這一整套的失敗方向是不對稱的：放太寬＝客戶看到內部同事的考卷與答案，**不會有人來說**；
 * 放太嚴＝內部同事的考試不見了，會有人來說。所以兩個方向都要釘，而且「漏接一支新端點」
 * 要能被自動抓到（見最後的靜態守衛）。
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

const mockRunQueue = jest.fn(async () => ({ jobId: null, total: 0, done: 0, failed: 0 }));
jest.mock('../lib/exam/worker', () => ({ runQueue: (...a) => mockRunQueue(...a) }));

process.env.JWT_SECRET = 'test-exam-scope-jwt';
process.env.APP_SECRET = 'test-exam-scope-secret';

const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);
const b64 = jpg.toString('base64');

let app, server, baseUrl, dbModule, dataDir, uploadDir;
// 上傳那條路的身分判斷第一行就是 isLocal（127.0.0.1 免 token）。supertest 的連線一律
// 來自 127.0.0.1，所以「這張圖算誰的」在本機連線上**根本測不到**——一律算成內部。
// 連到 127.0.0.2 還不夠（實測預設來源位址仍是 127.0.0.1），要指定 localAddress。
const outsider = () => new http.Agent({ localAddress: '127.0.0.2' });
let tok = {};
let coA, coB, coInternal;
let bankInternal, bankA, bankB;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-scope-data-'));
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-scope-up-'));
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
  server = app.listen(0, '0.0.0.0');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.2:${server.address().port}`;

  tok.admin = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  // 客戶公司要明確開考試功能，否則 requireFeature 會先把所有端點擋成 404，
  // 那樣測不到「範圍」這件事本身（兩種 404 長得一樣，但成因不同）。
  const mkCo = async (name, isInternal, features) => (await one(
    'INSERT INTO companies (name, is_active, is_internal, features) VALUES ($1, true, $2, $3) RETURNING id',
    [name, isInternal, features])).id;
  coInternal = await mkCo('內部', true, '{}');
  coA = await mkCo('客戶甲', false, '{"exam":true}');
  coB = await mkCo('客戶乙', false, '{"exam":true}');

  const mkUser = async (username, role, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, role, companyId]);
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  tok.internal = await mkUser('internal-user', 'user', coInternal);
  tok.a = await mkUser('a-user', 'user', coA);
  tok.b = await mkUser('b-user', 'user', coB);

  const mkBank = async (label, companyId) => (await one(
    "INSERT INTO exam_banks (label, odoo_version, company_id) VALUES ($1,'19',$2) RETURNING id",
    [label, companyId])).id;
  bankInternal = await mkBank('內部的場次', null);
  bankA = await mkBank('甲的場次', coA);
  bankB = await mkBank('乙的場次', coB);
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  dbModule._setPoolForTesting(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.EXAM_DATA_DIR;
  delete process.env.UPLOAD_DIR;
});

describe('場次清單只看得到自己的', () => {
  const idsFor = async (who) => (await request(app).get('/api/exam/banks').set(as(tok[who])))
    .body.map((b) => b.id).sort();

  test('平台管理員與內部成員看得到全部', async () => {
    const all = [bankInternal, bankA, bankB].sort();
    expect(await idsFor('admin')).toEqual(all);
    expect(await idsFor('internal')).toEqual(all);
  });

  test('甲只看得到甲的；乙只看得到乙的', async () => {
    expect(await idsFor('a')).toEqual([bankA]);
    expect(await idsFor('b')).toEqual([bankB]);
  });
});

describe('拿別家的場次 id 打過去一律 404', () => {
  // 404 而不是 403：403 等於告訴對方「這個 id 存在」，別家公司可以拿
  // 「打到 403 還是 404」當 oracle 掃出場次 id。
  const calls = [
    ['GET  /dashboard', () => request(app).get(`/api/exam/dashboard?bank=${bankB}`)],
    ['POST /run', () => request(app).post('/api/exam/run').send({ bank: bankB })],
    ['POST /banks/:id/pause', () => request(app).post(`/api/exam/banks/${bankB}/pause`).send({ paused: true })],
    ['GET  /banks/:id/archive', () => request(app).get(`/api/exam/banks/${bankB}/archive`)],
    ['POST /banks/:id/archive', () => request(app).post(`/api/exam/banks/${bankB}/archive`).send({})],
    ['DEL  /banks/:id/attempts', () => request(app).delete(`/api/exam/banks/${bankB}/attempts`)],
    ['POST /banks/:id/read-sections', () => request(app).post(`/api/exam/banks/${bankB}/read-sections`)],
    ['GET  /shot/score/:id', () => request(app).get(`/api/exam/shot/score/${bankB}`)],
  ];

  test.each(calls)('甲打 %s（乙的場次）→ 404', async (_label, mk) => {
    const res = await mk().set(as(tok.a));
    expect(res.status).toBe(404);
  });

  // 錯誤訊息也要與「真的不存在」逐字相同，否則訊息本身就是那個 oracle。
  test('看不到與不存在的訊息一模一樣', async () => {
    const unseen = await request(app).get(`/api/exam/dashboard?bank=${bankB}`).set(as(tok.a));
    const missing = await request(app).get('/api/exam/dashboard?bank=999999').set(as(tok.a));
    expect(unseen.body).toEqual(missing.body);
  });

  // 這兩支是清單，別家的場次不該出現，但不是 404（自己的清單本來就可能是空的）
  test('清單類不回 404，但撈不到別家的資料', async () => {
    const jobs = await request(app).get(`/api/exam/jobs?bank=${bankB}`).set(as(tok.a));
    const ups = await request(app).get(`/api/exam/uploads?bank=${bankB}`).set(as(tok.a));
    expect(jobs.status).toBe(200);
    expect(jobs.body).toEqual([]);
    expect(ups.status).toBe(200);
    expect(ups.body).toEqual([]);
  });

  // ⚠ 不帶 bank 時這兩支會列「最近的全部」——限縮不能只做在有帶 bank 那條路上。
  test('不帶 bank 時也只看得到自己的（最容易漏的一格）', async () => {
    await dbModule.query(
      "INSERT INTO exam_jobs (bank_id, status, phase, pages_total) VALUES ($1,'done','x',1)", [bankB]);
    const jobs = await request(app).get('/api/exam/jobs').set(as(tok.a));
    expect(jobs.status).toBe(200);
    expect(jobs.body).toEqual([]);
    // 對照：乙自己看得到那一筆，證明上面的空陣列不是因為資料根本沒建起來
    const mine = await request(app).get('/api/exam/jobs').set(as(tok.b));
    expect(mine.body.map((j) => j.bank_id)).toEqual([bankB]);
  });
});

describe('題庫管理（A 類）限內部', () => {
  const calls = [
    ['GET /versions', () => request(app).get('/api/exam/versions')],
    ['GET /sections', () => request(app).get(`/api/exam/sections?bank=${bankA}`)],
    ['GET /items/:id', () => request(app).get('/api/exam/items/1')],
    ['GET /lookup', () => request(app).get('/api/exam/lookup?q=x')],
    ['PATCH /items/:id/history-wrong', () => request(app).patch('/api/exam/items/1/history-wrong').send({ wrong: true })],
  ];

  // 連自己公司的場次都不行：題庫管理攤開的是**共用題目池**，不是某一場的資料。
  test.each(calls)('客戶打 %s → 404（即使 bank 是自己的）', async (_l, mk) => {
    expect((await mk().set(as(tok.a))).status).toBe(404);
  });

  test('內部進得去（證明上面的 404 不是因為端點壞了）', async () => {
    expect((await request(app).get('/api/exam/versions').set(as(tok.internal))).status).toBe(200);
    expect((await request(app).get('/api/exam/versions').set(as(tok.admin))).status).toBe(200);
  });
});

describe('上傳不會掉進別人的場次（規格 §3.4）', () => {
  // 這是現況最嚴重的那個洞：內部有一場還沒結束，客戶傳的第一張圖就會落進去，
  // 而且沒有任何徵狀——內部同事會在自己的作戰台上看到不認識的題目。
  test('內部有進行中的場次時，客戶上傳另開一場掛在自己公司底下', async () => {
    const res = await request(baseUrl).post('/api/exam/batch')
      .agent(outsider()).set(as(tok.a))
      .send({ items: [{ page: '1', answer: 'A', image: b64 }] });
    expect(res.status).toBe(200);

    const up = await one(
      "SELECT b.id AS bank_id, b.company_id FROM exam_uploads u JOIN exam_banks b ON b.id=u.bank_id WHERE u.page='1'");
    expect(up.bank_id).not.toBe(bankInternal);
    expect(up.company_id).toBe(coA);
  });

  test('帶別家的 bank id 也塞不進去', async () => {
    const res = await request(baseUrl).post('/api/exam/batch')
      .agent(outsider()).set(as(tok.a))
      .send({ bank: String(bankB), items: [{ page: '9', answer: 'A', image: b64 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('找不到題庫');
  });
});

describe('上傳通行碼一家一把（規格 §3.5）', () => {
  const issue = (who) => request(app).post('/api/exam/upload-token').set(as(tok[who])).send({});

  test('甲重產不會把內部與乙的碼作廢', async () => {
    const internalTok = (await issue('internal')).body.token;
    const bTok = (await issue('b')).body.token;
    const aTok = (await issue('a')).body.token;
    expect(new Set([internalTok, bTok, aTok]).size).toBe(3);

    // 三把都還能用。原本是全平台一把，這裡會有兩把變成「通行碼不對」，
    // 而症狀是「我的通行碼昨天還能用」，log 上看不出任何異常。
    for (const t of [internalTok, bTok, aTok]) {
      const res = await request(baseUrl).post('/api/exam/batch').agent(outsider()).set('X-Token', t)
        .send({ items: [{ page: '1', answer: 'A', image: b64 }] });
      expect(res.status).toBe(200);
    }
  });

  test('用甲的碼傳的圖落在甲的場次', async () => {
    const aTok = (await issue('a')).body.token;
    const res = await request(baseUrl).post('/api/exam/batch').agent(outsider()).set('X-Token', aTok)
      .send({ items: [{ page: '77', answer: 'A', image: b64 }] });
    expect(res.status).toBe(200);
    const up = await one(
      "SELECT b.company_id FROM exam_uploads u JOIN exam_banks b ON b.id=u.bank_id WHERE u.page='77'");
    expect(up.company_id).toBe(coA);
  });

  test('亂打的碼一律 401', async () => {
    const res = await request(baseUrl).post('/api/exam/batch').agent(outsider()).set('X-Token', 'not-a-real-token')
      .send({ items: [{ page: '1', answer: 'A', image: b64 }] });
    expect(res.status).toBe(401);
  });
});

/**
 * 靜態守衛：每一支考試端點都必須有某種範圍把關。
 *
 * 為什麼需要它：上面那些逐支測試只證明「今天這 24 支對了」。真正的風險是**明天新增
 * 第 25 支時忘了接**——那種漏接沒有任何徵狀（端點會正常回資料，只是回了別家的），
 * 而且審 diff 時看起來只是「又多一支端點」。
 *
 * 把關方式有四種，都算數：
 *   ensureBankVisible／canSeeBank  單一場次（看不到回 404）
 *   bankScopeClause                清單（WHERE 限縮）
 *   resolveBank                    上傳（以上傳者的公司決定落在哪一場，規格 §3.4）
 *   requireInternal／tokenBucketFor 題庫管理限內部／通行碼一家一把
 */
describe('靜態守衛：新增端點不得漏接範圍檢查', () => {
  const GUARDS = /ensureBankVisible\(|canSeeBank\(|bankScopeClause\(|resolveBank\(|requireInternal|tokenBucketFor\(/;

  const handlersOf = (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const marks = [...src.matchAll(/\n {2}app\.(get|post|put|delete|patch)\('(\/api\/exam[^']*)'/g)];
    return marks.map((m, i) => ({
      name: `${m[1].toUpperCase()} ${m[2]}`,
      body: src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
    }));
  };

  const all = [...handlersOf('exam-routes.js'), ...handlersOf('exam-upload-routes.js')];

  // 掃不到端點時測試會「全過」——那是最糟的失敗方式（守衛在，但守的是空集合）。
  test('真的掃得到端點（防守衛掃空還全綠）', () => {
    expect(all.length).toBeGreaterThanOrEqual(24);
  });

  test.each(all.map((h) => [h.name, h.body]))('%s 有接上範圍檢查', (_name, body) => {
    expect(body).toMatch(GUARDS);
  });
});
