const { newDb } = require('pg-mem');
let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterAll(() => dbModule._setPoolForTesting(null));

test('migration：task_rejections.source 預設 human，既有寫法不帶 source 也可插入', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P','17.0') RETURNING id");
  const { rows: [r] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, project_id, reason, status) VALUES ('t1',$1,'r','new') RETURNING source",
    [p.id]);
  expect(r.source).toBe('human');
});

const { parseQaIssues } = require('../pipeline/qa-rejection');

test('parseQaIssues：物件 issue 保留合法 category', () => {
  const r = parseQaIssues({ issues: [{ desc: 'A 欄位漏加', category: 'impl_miss' },
                                      { desc: '規格沒說幣別', category: 'spec_unclear' }], summary: '修正指引' });
  expect(r.items).toEqual([{ desc: 'A 欄位漏加', category: 'impl_miss' },
                           { desc: '規格沒說幣別', category: 'spec_unclear' }]);
  expect(r.list).toEqual(['A 欄位漏加', '規格沒說幣別']);
  expect(r.summary).toBe('修正指引');
});

test('parseQaIssues：純字串 issue 向下相容 → category 預設 impl_miss', () => {
  const r = parseQaIssues({ issues: ['view 未加欄位', '  '] }); // 空白項濾掉
  expect(r.items).toEqual([{ desc: 'view 未加欄位', category: 'impl_miss' }]);
  expect(r.list).toEqual(['view 未加欄位']);
});

test('parseQaIssues：非法 category → 退回 impl_miss', () => {
  const r = parseQaIssues({ issues: [{ desc: 'x', category: 'qa_overstrict' }] });
  expect(r.items[0].category).toBe('impl_miss');
});

test('parseQaIssues：無 issues 無 summary → null', () => {
  expect(parseQaIssues({ verdict: 'fail' })).toBeNull();
});

test('parseQaIssues：只有 summary 無 issues → items 空、list 空、summary 保留', () => {
  const r = parseQaIssues({ summary: '整體方向錯' });
  expect(r.items).toEqual([]);
  expect(r.list).toEqual([]);
  expect(r.summary).toBe('整體方向錯');
});

const { recordQaRejection } = require('../pipeline/qa-rejection');

test('recordQaRejection：寫 task_rejections(source=qa,status=classified) + 逐條 rejection_items', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('QP','17.0') RETURNING id");
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('qu','x','Q','user') RETURNING id");
  const task = { task_id: 'manual_qa_1', project_id: p.id, user_id: u.id };
  await recordQaRejection(task, [
    { desc: 'A 欄位漏加', category: 'impl_miss' },
    { desc: '規格沒說幣別', category: 'spec_unclear' },
  ], '請補欄位並確認幣別');

  const { rows: [tr] } = await dbModule.query(
    "SELECT id, source, status, reason FROM task_rejections WHERE task_id='manual_qa_1'");
  expect(tr.source).toBe('qa');
  expect(tr.status).toBe('classified');
  expect(tr.reason).toBe('請補欄位並確認幣別');
  const { rows: items } = await dbModule.query(
    'SELECT description, category FROM rejection_items WHERE rejection_id=$1 ORDER BY id', [tr.id]);
  expect(items).toEqual([
    { description: 'A 欄位漏加', category: 'impl_miss' },
    { description: '規格沒說幣別', category: 'spec_unclear' },
  ]);
});

test('recordQaRejection：items 空 → 不寫任何列', async () => {
  const before = (await dbModule.query('SELECT COUNT(*)::int n FROM task_rejections')).rows[0].n;
  await recordQaRejection({ task_id: 'x', project_id: null, user_id: null }, [], 's');
  const after = (await dbModule.query('SELECT COUNT(*)::int n FROM task_rejections')).rows[0].n;
  expect(after).toBe(before);
});
