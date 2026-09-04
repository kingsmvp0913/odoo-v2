const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-exam';

let app, dbModule, token, bankId, itemCertain, itemLow;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const setup = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin' });
  token = setup.body.token;

  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version, status) VALUES ('B1','19','ready') RETURNING id`);
  bankId = b.rows[0].id;

  const { fingerprint } = require('../lib/exam/fingerprint');
  const qCertain = 'How can you share a customer across companies?';
  const c = await dbModule.query(
    `INSERT INTO exam_items (odoo_version, fingerprint, question_en, question_zh, options, qtype,
                             section_title, answer_official, official_from, certain, confidence, confidence_why)
     VALUES ('19',$1,$2,'共用客戶？',$3,'single','Introduction',$4,'section-all-correct',true,100,'官方確認正確')
     RETURNING id`,
    [fingerprint(qCertain), qCertain,
     JSON.stringify([{ letter: 'A', text: 'No', text_zh: '否' }, { letter: 'B', text: 'Leave empty', text_zh: '留空' }]),
     ['B']]);
  itemCertain = c.rows[0].id;

  const qLow = 'Where is the Reordering Rule defined?';
  const l = await dbModule.query(
    `INSERT INTO exam_items (odoo_version, fingerprint, question_en, options, qtype,
                             section_title, confidence, confidence_why, calibrated)
     VALUES ('19',$1,$2,'[]'::jsonb,'single','Inventory',45,'審查認為應該選 A，但講不出根據',true)
     RETURNING id`, [fingerprint(qLow), qLow]);
  itemLow = l.rows[0].id;

  await dbModule.query(
    `INSERT INTO exam_attempts (item_id, bank_id, page, no, answer_their, answer_final)
     VALUES ($1,$2,'1',1,$3,$3), ($4,$2,'17',8,$5,$5)`,
    [itemCertain, bankId, ['B'], itemLow, ['B']]);
  await dbModule.query(
    `INSERT INTO exam_sections (bank_id,title,n,correct,incorrect) VALUES
     ($1,'Introduction',6,6,0), ($1,'Inventory',10,9,1)`, [bankId]);

  const v = await dbModule.query(
    `INSERT INTO exam_verdicts (item_id, kind, refuted, correct_answer, confidence, reason, model)
     VALUES ($1,'adversary',true,$2,70,'選單位置不對','claude-opus-5') RETURNING id`,
    [itemLow, ['A']]);
  await dbModule.query(
    `INSERT INTO exam_evidence (verdict_id, kind, ref, excerpt)
     VALUES ($1,'source','addons/stock/models/product.py:412','def _get_orderpoint')`, [v.rows[0].id]);
});

afterAll(() => { dbModule._setPoolForTesting(null); });

const auth = r => r.set('Authorization', `Bearer ${token}`);

test('未帶 token 一律擋下', async () => {
  await request(app).get('/api/exam/banks').expect(401);
  await request(app).get('/api/exam/lookup?q=x').expect(401);
});

test('題庫清單帶題數', async () => {
  const res = await auth(request(app).get('/api/exam/banks')).expect(200);
  expect(res.body[0]).toMatchObject({ label: 'B1', odoo_version: '19', item_count: 2 });
});

test('版本清單供切換用', async () => {
  const res = await auth(request(app).get('/api/exam/versions')).expect(200);
  expect(res.body).toEqual([{ odoo_version: '19', n: 2 }]);
});

describe('章節分組', () => {
  test('按章節分組並帶官方成績', async () => {
    const res = await auth(request(app).get(`/api/exam/sections?bank=${bankId}`)).expect(200);
    expect(res.body.bank.label).toBe('B1');
    const titles = res.body.groups.map(g => g.title);
    expect(titles).toEqual(['Introduction', 'Inventory']);
    const inv = res.body.groups.find(g => g.title === 'Inventory');
    expect(inv.official).toMatchObject({ n: 10, correct: 9, incorrect: 1 });
    expect(inv.items[0].confidence).toBe(45);
  });

  // 列表不需要選項全文，那是單題詳情的事——列表塞全文會讓 120 題的回應大得沒必要
  test('列表不含選項全文', async () => {
    const res = await auth(request(app).get(`/api/exam/sections?bank=${bankId}`)).expect(200);
    expect(res.body.groups[0].items[0].options).toBeUndefined();
  });

  test('缺 bank 參數回 400，不存在回 404', async () => {
    await auth(request(app).get('/api/exam/sections')).expect(400);
    await auth(request(app).get('/api/exam/sections?bank=99999')).expect(404);
  });
});

describe('單題詳情', () => {
  test('帶選項中英對照、審查與證據', async () => {
    const res = await auth(request(app).get(`/api/exam/items/${itemLow}`)).expect(200);
    expect(res.body.verdicts[0]).toMatchObject({ kind: 'adversary', refuted: true });
    expect(res.body.evidence[0].ref).toBe('addons/stock/models/product.py:412');
    expect(res.body.attempts[0]).toMatchObject({ page: '17', no: 8, bank_label: 'B1' });
  });

  test('選項的中英文都回得來', async () => {
    const res = await auth(request(app).get(`/api/exam/items/${itemCertain}`)).expect(200);
    expect(res.body.item.options[1]).toMatchObject({ letter: 'B', text: 'Leave empty', text_zh: '留空' });
  });

  test('不存在的 id 回 404', async () => {
    await auth(request(app).get('/api/exam/items/99999')).expect(404);
  });
});

describe('lookup（給 /solve 用）', () => {
  // 這是整條接口最重要的一條規則：讓 /solve 看到不確定的舊答案，
  // 就是拿它去錨定新的推理。過濾必須在 server 端，不能交給 client。
  test('只有 100% 才回答案', async () => {
    const ok = await auth(request(app).get(
      '/api/exam/lookup?q=How can you share a customer across companies?&version=19')).expect(200);
    expect(ok.body).toMatchObject({ confidence: 100, answer: ['B'], source: '官方章節全對推得' });
  });

  test('信心不足的題什麼都不回', async () => {
    const low = await auth(request(app).get(
      '/api/exam/lookup?q=Where is the Reordering Rule defined?&version=19')).expect(200);
    expect(low.body).toEqual({ confidence: null });
    expect(low.body.answer).toBeUndefined();
  });

  test('題庫裡沒有的題回 null 而非 404', async () => {
    const res = await auth(request(app).get('/api/exam/lookup?q=never seen this&version=19')).expect(200);
    expect(res.body).toEqual({ confidence: null });
  });

  // 大小寫、標點差異算同一題（指紋正規化過）
  test('題幹有標點與大小寫差異仍命中', async () => {
    const res = await auth(request(app).get(
      '/api/exam/lookup?q=HOW CAN YOU SHARE A CUSTOMER ACROSS COMPANIES&version=19')).expect(200);
    expect(res.body.confidence).toBe(100);
  });

  // 17 版考過的題不得汙染 19 版，反之亦然
  test('版本不對就查不到', async () => {
    const res = await auth(request(app).get(
      '/api/exam/lookup?q=How can you share a customer across companies?&version=17')).expect(200);
    expect(res.body).toEqual({ confidence: null });
  });

  test('缺 q 回 400', async () => {
    await auth(request(app).get('/api/exam/lookup')).expect(400);
  });
});
