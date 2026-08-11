const { maskSecrets } = require('../lib/log-parse');

test('遮罩 password= 之後的內容', () => {
  expect(maskSecrets('login failed password=hunter2 for admin')).toContain('password=***');
  expect(maskSecrets('login failed password=hunter2 for admin')).not.toContain('hunter2');
});

test('遮罩各種憑證欄位名', () => {
  for (const k of ['passwd', 'pwd', 'token', 'api_key', 'secret', 'authorization']) {
    const masked = maskSecrets(`${k}=s3cr3tvalue`);
    expect(masked).not.toContain('s3cr3tvalue');
  }
});

test('遮罩疑似 token 的長英數字串', () => {
  const long = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8';
  expect(maskSecrets(`session ${long} created`)).not.toContain(long);
});

// 業務資料刻意不遮：debug 常需靠這些定位問題，且 runSelect 已能讀整個客戶資料庫，
// 在 log 遮 email 是自欺欺人的雙重標準。
test('不遮罩業務資料（email／客戶名／單號）', () => {
  const line = 'partner a@b.com 王小明 訂單 SO2026-0042 建立失敗';
  const masked = maskSecrets(line);
  expect(masked).toContain('a@b.com');
  expect(masked).toContain('王小明');
  expect(masked).toContain('SO2026-0042');
});

test('不誤遮一般路徑與 traceback 內容', () => {
  const line = '  File "/opt/odoo/addons/sale/models/sale_order.py", line 1234, in _compute_amount';
  expect(maskSecrets(line)).toBe(line);
});
