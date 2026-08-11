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

// 審查發現的缺口 1：Authorization: Bearer 形式的 token 整個外洩（CRED_RE 的 \S+ 停在空白）
test('遮罩 Authorization: Bearer 之後的完整 token', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const masked = maskSecrets(`Authorization: Bearer ${jwt}`);
  expect(masked).not.toContain(jwt);
  expect(masked).toContain('Bearer ***');
});

// 審查發現的缺口 2：Python dict 形式 {'password': 'value'} 完全不遮（CRED_RE 不處理引號）
test('遮罩 Python dict 形式的引號值', () => {
  const masked = maskSecrets("{'password': 'hunter2'}");
  expect(masked).not.toContain('hunter2');
  expect(masked).toContain('password');
});

// 同樣是引號值的 JSON 形式
test('遮罩 JSON dict 形式的引號值', () => {
  const masked = maskSecrets('{"api_key": "sk-live-abc123"}');
  expect(masked).not.toContain('sk-live-abc123');
  expect(masked).toContain('api_key');
});

// 審查發現的缺口 3：underscore 欄位名（access_token、auth_token、csrf_token）不遮
// 原因：\b 是單詞邊界，而 _ 視為 word char，所以 `_token` 之間無邊界可言
test('遮罩 underscore 欄位名', () => {
  const fields = ['access_token', 'auth_token', 'csrf_token'];
  for (const field of fields) {
    const masked = maskSecrets(`${field}=ya29.a0AfH6SMB`);
    expect(masked).not.toContain('ya29.a0AfH6SMB');
  }
});

// Underscore 欄位的冒號形式
test('遮罩 underscore 欄位名（冒號分隔）', () => {
  const masked = maskSecrets('auth_token: abc123def456xyz');
  expect(masked).not.toContain('abc123def456xyz');
  expect(masked).toContain('auth_token:');
});

// 二次審查發現的三個新缺口

// Important: 值含冒號時分隔符偵測失敗，導致前綴洩漏
test('等號分隔符下值含冒號不洩漏前綴', () => {
  const input = 'api_key=abc:def123456789012345678901234567';
  const masked = maskSecrets(input);
  expect(masked).not.toContain('abc');
  expect(masked).not.toContain('def123456789012345678901234567');
  // 值的任何部分都不應該出現
  expect(masked).toContain('api_key=***');
});

// Minor 1: `mytoken=` 形式被誤遮（缺 word boundary）
test('不誤遮類似憑證但無關的欄位名', () => {
  const line = 'mytoken=notasecretvalue';
  const masked = maskSecrets(line);
  expect(masked).toBe(line);
  // 應該完全不變，而非 mytoken=***
});

// Minor 2: Authorization=Bearer 形式完全不遮
test('遮罩 Authorization=Bearer 格式（等號分隔）', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const masked = maskSecrets(`Authorization=Bearer ${jwt}`);
  expect(masked).not.toContain(jwt);
  expect(masked).toContain('Authorization=Bearer ***');
});
