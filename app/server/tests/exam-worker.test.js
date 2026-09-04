const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

// 模型呼叫全部 mock：這支測的是佇列與資料流，不是審查品質。
// 審查品質有它自己的實測（docs/superpowers/specs/2026-09-04-adversary-bench-result.md）。
const mockExtract = jest.fn();
const mockReview = jest.fn();
const mockEvidence = jest.fn();
jest.mock('../lib/exam/review', () => {
  const actual = jest.requireActual('../lib/exam/review');
  return {
    ...actual,
    extractPage: (...a) => mockExtract(...a),
    reviewQuestions: (...a) => mockReview(...a),
  };
});
jest.mock('../lib/exam/evidence', () => {
  const actual = jest.requireActual('../lib/exam/evidence');
  return { ...actual, gatherEvidence: (...a) => mockEvidence(...a) };
});

const { runQueue, reclaimInterrupted } = require('../lib/exam/worker');

let dbModule, bankId, uploadDir;

const verdictOf = (qs) => ({
  readable: true, page: '', note: '',
  questions: qs.map((q, i) => ({
    no: i + 1, question: q.en, question_zh: q.zh, type: 'single',
    options: [{ letter: 'A', text: 'aa', text_zh: '啊' }, { letter: 'B', text: 'bb', text_zh: '玻' }],
    their_answer: q.their || ['B'], refuted: !!q.refuted,
    correct_answer: q.correct || ['B'], confidence: q.conf ?? 95, reason: 'r',
  })),
});
const pageOf = (qs) => ({
  readable: true, page: '', note: '',
  questions: qs.map((q, i) => ({
    no: i + 1, question: q.en, question_zh: q.zh, type: 'single', has_image: !!q.hasImage,
    options: [{ letter: 'A', text: 'aa', text_zh: '啊' }, { letter: 'B', text: 'bb', text_zh: '玻' }],
  })),
});

async function addUpload(page, answer, name) {
  const rel = path.join('exam_1', `${page}.jpg`);
  fs.mkdirSync(path.join(uploadDir, 'exam_1'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, rel), Buffer.from([0xff, 0xd8, 0xff]));
  const r = await dbModule.query(
    `INSERT INTO exam_uploads (bank_id, page, answer_raw, responder, image_path)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [bankId, page, answer, name || null, rel]);
  return r.rows[0].id;
}

beforeAll(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-worker-'));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.EXAM_CONCURRENCY = '2';

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('W','19') RETURNING id`);
  bankId = b.rows[0].id;
});

afterAll(() => {
  dbModule._setPoolForTesting(null);
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
  delete process.env.EXAM_CONCURRENCY;
});

beforeEach(() => {
  mockExtract.mockReset();
  mockReview.mockReset();
  mockEvidence.mockReset();
  mockEvidence.mockResolvedValue({ result: { found: false, evidence: [], rejected: [] } });
});

test('沒有待處理時不建 job', async () => {
  const r = await runQueue(dbModule, { bankId });
  expect(r).toMatchObject({ jobId: null, total: 0 });
  const jobs = await dbModule.query('SELECT COUNT(*)::int c FROM exam_jobs');
  expect(jobs.rows[0].c).toBe(0);
});

test('跑完一筆會建題目、作答與判斷', async () => {
  await addUpload('1', '第 1 題 B；第 2 題 A', '小王');
  const qs = [
    { en: 'What is a delivery order?', zh: '什麼是交貨單？', their: ['B'] },
    { en: 'Where is the reordering rule?', zh: '重訂貨規則在哪？', their: ['A'], correct: ['A'] },
  ];
  mockExtract.mockResolvedValue({ page: pageOf(qs), model: 'claude-opus-5' });
  mockReview.mockResolvedValue({
    verdict: verdictOf(qs),
    model: 'claude-opus-5',
  });

  const r = await runQueue(dbModule, { bankId });
  expect(r).toMatchObject({ total: 1, done: 1, failed: 0 });

  const items = await dbModule.query(`SELECT COUNT(*)::int c FROM exam_items WHERE odoo_version='19'`);
  expect(items.rows[0].c).toBe(2);
  const att = await dbModule.query(
    `SELECT no, answer_their, answer_final, responder FROM exam_attempts ORDER BY no`);
  expect(att.rows[0]).toMatchObject({ no: 1, answer_their: ['B'], answer_final: ['B'], responder: '小王' });
  const v = await dbModule.query(`SELECT COUNT(*)::int c FROM exam_verdicts WHERE kind='adversary'`);
  expect(v.rows[0].c).toBe(2);

  const up = await dbModule.query(`SELECT status FROM exam_uploads WHERE page='1'`);
  expect(up.rows[0].status).toBe('done');
});

// 同一題再考一次不可以建成新的一列，否則累積的證據散在兩列上
test('第二次遇到同一題是合併不是新增', async () => {
  await addUpload('2', 'B', null);
  const qs = [{ en: 'What is a delivery order?', zh: '什麼是交貨單？' }];
  mockExtract.mockResolvedValue({ page: pageOf(qs), model: 'claude-opus-5' });
  mockReview.mockResolvedValue({
    verdict: verdictOf(qs),
    model: 'claude-opus-5',
  });
  await runQueue(dbModule, { bankId });

  const items = await dbModule.query(`SELECT seen_count FROM exam_items WHERE question_en LIKE 'What is a delivery%'`);
  expect(items.rows).toHaveLength(1);
  expect(items.rows[0].seen_count).toBe(2);
});

test('只有官方確認答案命中才短路，且不寫假的 adversary', async () => {
  const { fingerprint } = require('../lib/exam/fingerprint');
  const q = 'Which answer is officially confirmed for this question?';
  const item = await dbModule.query(
    `INSERT INTO exam_items
       (odoo_version,fingerprint,question_en,options,qtype,answer_official,official_from,confidence)
     VALUES ('19',$1,$2,'[]'::jsonb,'single',$3,'manual',100) RETURNING id`,
    [fingerprint(q), q, ['A']]);
  await addUpload('3', 'B', null);
  mockExtract.mockResolvedValue({ page: pageOf([{ en: q, zh: '官方題' }]), model: 'm' });

  await runQueue(dbModule, { bankId });

  expect(mockReview).not.toHaveBeenCalled();
  const attempt = (await dbModule.query(
    `SELECT answer_their,answer_final FROM exam_attempts WHERE item_id=$1 ORDER BY id DESC LIMIT 1`,
    [item.rows[0].id])).rows[0];
  expect(attempt).toEqual({ answer_their: ['B'], answer_final: ['B'] });
  const verdicts = await dbModule.query(
    `SELECT id FROM exam_verdicts WHERE item_id=$1`, [item.rows[0].id]);
  expect(verdicts.rows).toEqual([]);
});

// 單筆失敗不中斷整批：實測踩過一頁逾時讓整個腳本 exit，前面的結果留在 DB
// 看起來像跑完了
test('一筆失敗不影響其他筆，且具名留下錯誤', async () => {
  await addUpload('7', 'B', null);
  await addUpload('8', 'B', null);
  mockExtract
    .mockRejectedValueOnce(new Error('審查逾時（1200s）'))
    .mockResolvedValue({ page: pageOf([{ en: 'Q8 unique question', zh: '第八題' }]), model: 'm' });
  mockReview.mockResolvedValue({ verdict: verdictOf([{ en: 'Q8 unique question', zh: '第八題' }]), model: 'm' });

  const r = await runQueue(dbModule, { bankId });
  expect(r.done + r.failed).toBe(2);
  expect(r.failed).toBe(1);

  const failed = await dbModule.query(`SELECT page, error FROM exam_uploads WHERE status='failed'`);
  expect(failed.rows).toHaveLength(1);
  expect(failed.rows[0].error).toMatch(/逾時/);
});

// attempts 建在審查之前（saveVerdicts 要靠它們對應題號），所以審查炸掉會留下
// 一批沒有 verdict 的孤兒：畫面上永遠「等待中」，重跑還會再建一份重複的。
// 實測踩過——模型把信心度回成 0.95 撞爛 INTEGER 欄位，整頁 4 題卡死。
test('審查中途失敗時，那一頁已建的作答要清乾淨', async () => {
  await addUpload('40', 'B,A', null);
  mockExtract.mockResolvedValue({
    page: pageOf([{ en: 'Rollback question one' }, { en: 'Rollback question two' }]), model: 'm' });
  mockReview.mockRejectedValue(new Error('invalid input syntax for type integer: "0.95"'));

  const r = await runQueue(dbModule, { bankId });
  expect(r.failed).toBe(1);

  const left = await dbModule.query(
    `SELECT COUNT(*)::int c FROM exam_attempts a
       JOIN exam_uploads u ON u.id = a.upload_id WHERE u.page = '40'`);
  expect(left.rows[0].c).toBe(0);

  const up = await dbModule.query(`SELECT status, error FROM exam_uploads WHERE page='40'`);
  expect(up.rows[0].status).toBe('failed');
  expect(up.rows[0].error).toMatch(/0\.95/);
});

test('讀不出題目算失敗並寫下原因', async () => {
  await addUpload('9', 'B', null);
  mockExtract.mockResolvedValue({
    page: { readable: false, note: '截圖被裁掉一半', questions: [] }, model: 'm' });
  const r = await runQueue(dbModule, { bankId });
  expect(r.failed).toBe(1);
  const row = await dbModule.query(`SELECT error FROM exam_uploads WHERE page='9'`);
  expect(row.rows[0].error).toMatch(/截圖被裁掉一半/);
});

// 題數對不上時寧可留空也不移位——補空或截斷會讓答案錯位，
// 而錯位的症狀是「某幾題莫名被判不一致」，離真因很遠
test('作答題數與審查讀出的題數不符時不硬湊', async () => {
  await addUpload('11', 'BAA', null);   // 看起來 3 題
  mockExtract.mockResolvedValue({ page: pageOf([{ en: 'Only one question here', zh: '只有一題' }]), model: 'm' });
  mockReview.mockResolvedValue({
    verdict: verdictOf([{ en: 'Only one question here', zh: '只有一題' }]), model: 'm' });
  await runQueue(dbModule, { bankId });

  const att = await dbModule.query(`SELECT answer_their FROM exam_attempts WHERE page='11'`);
  expect(att.rows[0].answer_their).toBeNull();
  const up = await dbModule.query(`SELECT status, error FROM exam_uploads WHERE page='11'`);
  expect(up.rows[0].status).toBe('done');
  expect(up.rows[0].error).toMatch(/沒對齊|3 題.*1 題/);
});

test('信心足夠就不取證，不足才取證', async () => {
  await addUpload('12', '第 1 題 B；第 2 題 B', null);
  const qs = [
    { en: 'High confidence question here', zh: '高信心', conf: 95 },
    { en: 'Low confidence question here', zh: '低信心', conf: 60 },
  ];
  mockExtract.mockResolvedValue({ page: pageOf(qs), model: 'm' });
  mockReview.mockResolvedValue({
    verdict: verdictOf(qs), model: 'm' });

  await runQueue(dbModule, { bankId });
  expect(mockEvidence).toHaveBeenCalledTimes(1);   // 只有 60 分那題
});

test('job 記錄進度且結束時標 done', async () => {
  const jobs = await dbModule.query(`SELECT status, pages_total, pages_done FROM exam_jobs ORDER BY id DESC LIMIT 1`);
  expect(jobs.rows[0].status).toBe('done');
  expect(jobs.rows[0].pages_done).toBe(jobs.rows[0].pages_total);
});

// 沒有這一步，重啟後 job 永遠停在 running，畫面看起來像「還在跑」，
// 但跑它的行程早就不在了
describe('reclaimInterrupted', () => {
  test('把上次被殺掉的工作標 interrupted，upload 退回 pending', async () => {
    const j = await dbModule.query(
      `INSERT INTO exam_jobs (bank_id, status, phase) VALUES ($1,'running','審查中') RETURNING id`, [bankId]);
    await addUpload('30', 'B', null);
    await dbModule.query(`UPDATE exam_uploads SET status='running' WHERE page='30'`);

    const r = await reclaimInterrupted(dbModule);
    expect(r.jobs).toBe(1);
    expect(r.uploads).toBe(1);

    const job = await dbModule.query(`SELECT status FROM exam_jobs WHERE id=$1`, [j.rows[0].id]);
    expect(job.rows[0].status).toBe('interrupted');
    const up = await dbModule.query(`SELECT status FROM exam_uploads WHERE page='30'`);
    expect(up.rows[0].status).toBe('pending');
  });

  test('已完成的不受影響', async () => {
    const done = await dbModule.query(`SELECT COUNT(*)::int c FROM exam_uploads WHERE status='done'`);
    expect(done.rows[0].c).toBeGreaterThan(0);
  });
});
