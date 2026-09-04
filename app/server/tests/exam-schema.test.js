const { newDb } = require('pg-mem');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

const TABLES = ['exam_banks', 'exam_items', 'exam_attempts', 'exam_sections',
                'exam_verdicts', 'exam_evidence', 'exam_jobs', 'exam_glossary'];

test.each(TABLES)('%s 表存在且可查詢', async (t) => {
  const res = await dbModule.query(`SELECT * FROM ${t} LIMIT 1`);
  expect(res.rows).toEqual([]);
});

// 這條測的是「越考越準」能不能成立：同一題在同一版本只能有一列，
// 否則第二次考試會建出重複的 item，累積的證據就散在兩列上。
test('exam_items 對 (odoo_version, fingerprint) 唯一', async () => {
  const ins = `INSERT INTO exam_items (odoo_version, fingerprint, question_en, options, qtype)
               VALUES ($1, $2, 'Q', '[]'::jsonb, 'single')`;
  await dbModule.query(ins, ['19', 'abc']);
  await expect(dbModule.query(ins, ['19', 'abc'])).rejects.toThrow();
});

// 同一題在 Odoo 17 與 19 的答案可能不同，17 版的資料不得汙染 19 版題庫。
test('不同 Odoo 版本的同一題是兩列', async () => {
  const ins = `INSERT INTO exam_items (odoo_version, fingerprint, question_en, options, qtype)
               VALUES ($1, 'ver-probe', 'Q', '[]'::jsonb, 'single')`;
  await dbModule.query(ins, ['17']);
  await dbModule.query(ins, ['18']);
  const res = await dbModule.query(
    `SELECT odoo_version FROM exam_items WHERE fingerprint = 'ver-probe' ORDER BY odoo_version`);
  expect(res.rows.map(r => r.odoo_version)).toEqual(['17', '18']);
});

// CASCADE 是刻意的：此 repo 踩過「REFERENCES 不帶 CASCADE 擋死刪除路徑」的坑。
// 刪題庫時 attempts 必須跟著走，否則 DELETE 會被外鍵擋下。
test('刪掉題庫時 attempts 跟著消失', async () => {
  const bank = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('T', '19') RETURNING id`);
  const item = await dbModule.query(
    `INSERT INTO exam_items (odoo_version, fingerprint, question_en, options, qtype)
     VALUES ('19', 'cascade-probe', 'Q', '[]'::jsonb, 'single') RETURNING id`);
  await dbModule.query(
    `INSERT INTO exam_attempts (item_id, bank_id, page, no) VALUES ($1, $2, '1', 1)`,
    [item.rows[0].id, bank.rows[0].id]);

  await dbModule.query(`DELETE FROM exam_banks WHERE id = $1`, [bank.rows[0].id]);

  const left = await dbModule.query(
    `SELECT id FROM exam_attempts WHERE bank_id = $1`, [bank.rows[0].id]);
  expect(left.rows).toEqual([]);
});
