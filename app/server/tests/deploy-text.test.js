// 意圖：部署結果的文案是使用者唯一看得到的東西，所以「資料缺了怎麼寫」比正常情況更重要——
// 目標被刪掉、沒有模組要動、錯誤沒有訊息，任何一種寫成空白或 undefined 都等於什麼都沒說。
const { describeResults } = require('../lib/deploy-text');

const targets = [{ id: 1, db_name: 'odoo_tst' }, { id: 2, db_name: 'odoo_prd' }];

test('成功：寫得出是哪個資料庫、動了哪些模組', () => {
  const [line] = describeResults([{ targetId: 1, ok: true, modules: ['idx_hj', 'idx_scan'] }], targets, '客戶測試區');
  expect(line).toBe('客戶測試區部署完成（odoo_tst）：idx_hj, idx_scan');
});

test('失敗：帶得出原因', () => {
  const [line] = describeResults([{ targetId: 2, ok: false, modules: ['idx_hj'], error: '健康檢查未通過' }], targets, '客戶正式區');
  expect(line).toMatch(/客戶正式區部署失敗（odoo_prd／idx_hj）/);
  expect(line).toMatch(/健康檢查未通過/);
});

// 「沒有模組要動」是成功，不是失敗——寫成空字串會讓那一行看起來像壞掉
test('沒有模組變更時講清楚，不留空白', () => {
  const [line] = describeResults([{ targetId: 1, ok: true, modules: [] }], targets, '客戶測試區');
  expect(line).toMatch(/無模組變更/);
});

test('錯誤沒帶訊息時不寫成 undefined', () => {
  const [line] = describeResults([{ targetId: 1, ok: false }], targets, '客戶測試區');
  expect(line).not.toMatch(/undefined/);
  expect(line).toMatch(/未知原因/);
});

// 目標在部署期間被刪掉：對不到就退用 id，至少還查得到是哪一筆
test('對不到目標時退用 targetId', () => {
  const [line] = describeResults([{ targetId: 99, ok: true, modules: ['idx_hj'] }], targets, '客戶測試區');
  expect(line).toMatch(/（99）/);
});

test('沒有結果時回空陣列，不丟例外', () => {
  expect(describeResults(null, targets, '客戶測試區')).toEqual([]);
});
