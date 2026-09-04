const { newDb } = require('pg-mem');
const { importBank } = require('../lib/exam/import-bank');

let dbModule;

const QUESTIONS = {
  questions: [
    {
      page: '1', pageTitle: 'Introduction', no: 1,
      question: 'In a multi-company setup, how can you share a customer?',
      question_zh: '多公司環境下如何共用客戶？',
      type: 'single',
      options: [{ letter: 'A', text: 'Not possible' }, { letter: 'B', text: 'Leave Company empty' }],
      round1: { answer: ['B'], confidence: 95, reason: 'r1' },
      round2: { answer: ['B'], confidence: 90, reason: 'r2' },
      their: ['B'], final: 'B', official: 'B', officialFrom: 'section-all-correct', certain: true,
    },
    {
      page: '2', pageTitle: 'Sales', no: 1,
      question: 'Which report shows the margin?',
      type: 'single',
      options: [{ letter: 'A', text: 'Margin' }, { letter: 'B', text: 'Sales' }],
      round1: { answer: ['A'], confidence: 60, reason: 'r1' },
      round2: { answer: ['B'], confidence: 55, reason: 'r2' },
      their: ['A'], final: 'A', official: null, officialFrom: null, certain: false,
    },
  ],
};

const SECTIONS = {
  sections: {
    '1': { title: 'Introduction', n: 6, correct: 6, incorrect: 0, unanswered: 0 },
    '2': { title: 'Sales', n: 10, correct: 9, incorrect: 1, unanswered: 0 },
  },
};

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('第一次匯入建立題目、作答與章節', async () => {
  const r = await importBank(dbModule, {
    label: '2026-08-14-1', odooVersion: '19', questions: QUESTIONS, sections: SECTIONS });
  expect(r.items).toBe(2);
  expect(r.merged).toBe(0);
  expect(r.attempts).toBe(2);
  expect(r.verdicts).toBe(4);     // 每題 round1 + round2
  expect(r.sections).toBe(2);
  expect(r.skipped).toEqual([]);
});

// 這條是「越考越準」的核心：第二次考到同一題不可以建成新的一列，
// 否則累積的證據會散在兩列上，永遠湊不出 100%。
test('再匯入同一批題目時合併而非新增', async () => {
  const r = await importBank(dbModule, {
    label: '第二次', odooVersion: '19', questions: QUESTIONS, sections: SECTIONS });
  expect(r.items).toBe(0);
  expect(r.merged).toBe(2);

  const items = await dbModule.query(
    `SELECT COUNT(*)::int AS c FROM exam_items WHERE odoo_version = '19'`);
  expect(items.rows[0].c).toBe(2);

  const seen = await dbModule.query(
    `SELECT seen_count FROM exam_items WHERE section_title = 'Sales'`);
  expect(seen.rows[0].seen_count).toBe(2);

  // 兩次考試各留一筆 attempt
  const at = await dbModule.query(`SELECT COUNT(*)::int AS c FROM exam_attempts`);
  expect(at.rows[0].c).toBe(4);
});

test('官方答案與來源正確帶入', async () => {
  const res = await dbModule.query(
    `SELECT answer_official, official_from FROM exam_items WHERE section_title = 'Introduction'`);
  expect(res.rows[0].answer_official).toEqual(['B']);
  expect(res.rows[0].official_from).toBe('section-all-correct');
});

// 沒有官方答案的題不可以被填上任何東西——把 final 填進 official 是規格 §5.3
// 記載的實測坑（整張表寫著「正確率 93%」，但那個數字不是那個意思）
test('沒有官方正解的題 answer_official 留空', async () => {
  const res = await dbModule.query(
    `SELECT answer_official, official_from FROM exam_items WHERE section_title = 'Sales'`);
  expect(res.rows[0].answer_official == null).toBe(true);
  expect(res.rows[0].official_from == null).toBe(true);
});

test('舊的兩輪盲判以 blind_r1/blind_r2 保留', async () => {
  const res = await dbModule.query(
    `SELECT kind, COUNT(*)::int AS c FROM exam_verdicts GROUP BY kind ORDER BY kind`);
  const byKind = Object.fromEntries(res.rows.map(r => [r.kind, r.c]));
  expect(byKind.blind_r1).toBeGreaterThan(0);
  expect(byKind.blind_r2).toBeGreaterThan(0);
});

test('章節結果存的是題數不是百分比', async () => {
  const res = await dbModule.query(
    `SELECT n, correct, incorrect FROM exam_sections WHERE title = 'Sales' LIMIT 1`);
  expect(res.rows[0]).toMatchObject({ n: 10, correct: 9, incorrect: 1 });
});

test('題幹空白的題跳過並具名回報，不中斷整批', async () => {
  const bad = { questions: [
    { page: '9', pageTitle: 'X', no: 1, question: '', options: [], type: 'single' },
    { page: '9', pageTitle: 'X', no: 2, question: 'A real question here', options: [], type: 'single' },
  ] };
  const r = await importBank(dbModule, {
    label: '壞資料', odooVersion: '19', questions: bad, sections: { sections: {} } });
  expect(r.items).toBe(1);
  expect(r.skipped).toHaveLength(1);
  expect(r.skipped[0]).toMatch(/P9-1/);
});

// 官方確認是硬事實，不該被後來一次沒有官方回饋的考試洗掉
test('合併時已有的官方答案不被沒有官方答案的那次覆蓋', async () => {
  const noOfficial = { questions: [{
    page: '1', pageTitle: 'Introduction', no: 1,
    question: 'In a multi-company setup, how can you share a customer?',
    type: 'single', options: [], their: ['B'], final: 'B', official: null,
  }] };
  await importBank(dbModule, {
    label: '沒官方回饋那次', odooVersion: '19', questions: noOfficial, sections: { sections: {} } });
  const res = await dbModule.query(
    `SELECT answer_official, official_from FROM exam_items WHERE section_title = 'Introduction'`);
  expect(res.rows[0].answer_official).toEqual(['B']);
  expect(res.rows[0].official_from).toBe('section-all-correct');
});

// 17 版考過的題不得汙染 19 版題庫
test('同一題在不同 Odoo 版本各自成列', async () => {
  const r = await importBank(dbModule, {
    label: '17 版那次', odooVersion: '17', questions: QUESTIONS, sections: { sections: {} } });
  expect(r.items).toBe(2);
  expect(r.merged).toBe(0);
});
