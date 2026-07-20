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
