// 意圖：users.odoo_settings 的 odoo_password／service_password 原本明碼存 DB，與同一張表已用
// APP_SECRET 加密的 github_pat_enc 兩套標準。這裡把它收斂——但**只在進出 DB 的那一刻轉換**，
// API 形狀不變（GET 回明碼、PUT 收明碼），因為 settings 頁是「載入整包→存檔時原樣鋪回」，
// GET 一旦不回密碼，使用者存一次設定就會把密碼清空。
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-for-user-settings';

const { encryptSettings, decryptSettings, isEncrypted } = require('../lib/user-settings');
const { encrypt } = require('../lib/crypto');

describe('encryptSettings', () => {
  test('密碼欄位轉密文，其餘欄位原樣不動', () => {
    const out = encryptSettings({
      odoo_url: 'https://erp.example.com', odoo_username: 'alice',
      odoo_password: 'p@ss', service_password: 'svc', theme: 'dark'
    });
    expect(out.odoo_password).not.toBe('p@ss');
    expect(out.service_password).not.toBe('svc');
    expect(isEncrypted(out.odoo_password)).toBe(true);
    // 非祕密欄位不得被動到——誤加密 url／username 會讓同步整個連不上
    expect(out.odoo_url).toBe('https://erp.example.com');
    expect(out.odoo_username).toBe('alice');
    expect(out.theme).toBe('dark');
  });

  // read-modify-write 的呼叫端（theme／saved_views）會把 DB 讀出的密文原樣帶回來；
  // 再加密一層就會變成「解一次還是密文」，而解密端只解一次 → 拿密文去登入、同步靜默失敗。
  test('已是密文 → 不重複加密', () => {
    const once = encryptSettings({ odoo_password: 'p@ss' });
    const twice = encryptSettings(once);
    expect(twice.odoo_password).toBe(once.odoo_password);
    expect(decryptSettings(twice).odoo_password).toBe('p@ss');
  });

  test('空字串／未設定的密碼欄位不處理（不要把 undefined 加密成一段密文）', () => {
    const out = encryptSettings({ odoo_password: '', odoo_username: 'bob' });
    expect(out.odoo_password).toBe('');
    expect(out.service_password).toBeUndefined();
  });

  test('非物件輸入原樣回（null／undefined 不得炸掉存檔）', () => {
    expect(encryptSettings(null)).toBe(null);
    expect(encryptSettings(undefined)).toBe(undefined);
  });
});

describe('decryptSettings', () => {
  test('密文轉回明碼', () => {
    const out = decryptSettings({ odoo_password: encrypt('p@ss'), service_password: encrypt('svc') });
    expect(out.odoo_password).toBe('p@ss');
    expect(out.service_password).toBe('svc');
  });

  // 相容性關鍵：既有資料全是明碼，解不開就原樣回。少了這條，所有舊使用者的同步當場全掛。
  test('舊的明碼資料 → 原樣回傳，不得丟例外', () => {
    const out = decryptSettings({ odoo_password: 'legacy-plain', odoo_username: 'carol' });
    expect(out.odoo_password).toBe('legacy-plain');
    expect(out.odoo_username).toBe('carol');
  });

  test('加密→解密往返還原', () => {
    const original = { odoo_password: 'a:b:c', service_password: '中文密碼 123' };
    expect(decryptSettings(encryptSettings(original))).toEqual(original);
  });
});

// 以「decrypt 成功」判定而非比對 `a:b:c` 字面格式——密碼本身可能剛好含兩個冒號，
// 用格式判斷會把它誤認成密文而跳過加密，明碼就這樣漏進 DB。
test('isEncrypted：長得像密文格式的明碼密碼不得被誤判', () => {
  expect(isEncrypted('a:b:c')).toBe(false);
  expect(isEncrypted('aaaa:bbbb:cccc')).toBe(false);
  expect(isEncrypted(encrypt('a:b:c'))).toBe(true);
  expect(isEncrypted('')).toBe(false);
  expect(isEncrypted(null)).toBe(false);
});
