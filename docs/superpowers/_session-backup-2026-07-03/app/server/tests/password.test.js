/**
 * password.test.js — Odoo 相容的 pbkdf2_sha512 密碼雜湊
 *
 * 意圖：本系統密碼與 Odoo (passlib pbkdf2_sha512) 互通，
 *       且能漸進驗證舊有的 bcrypt hash（遷移期間不擋登入）。
 */
const bcrypt = require('bcryptjs');
const { hashPassword, checkPassword } = require('../password');

test('hashPassword 產生 passlib pbkdf2_sha512 MCF 格式', async () => {
  const h = await hashPassword('secret123');
  expect(h).toMatch(/^\$pbkdf2-sha512\$\d+\$[^$]+\$[^$]+$/);
});

test('checkPassword 驗證自產 pbkdf2 hash：正確 true、錯誤 false', async () => {
  const h = await hashPassword('secret123');
  expect(await checkPassword('secret123', h)).toBe(true);
  expect(await checkPassword('wrong', h)).toBe(false);
});

test('checkPassword 相容 passlib（Odoo）產生的 hash', async () => {
  // 由 Odoo 使用的 passlib pbkdf2_sha512 產生，密碼為 'ji3cl3gj94'
  const passlibHash = '$pbkdf2-sha512$25000$WKu1NoZwrhXCeI/xPsc4xw$kno0Uc/ip3q/SVVYi2QnFcoXtdQ/uxgkQ/JW/Lccwif3wer6VYjwmFSxKZsjW4Zj4cT1H9xtypHauKy6HX5fYw';
  expect(await checkPassword('ji3cl3gj94', passlibHash)).toBe(true);
  expect(await checkPassword('nope', passlibHash)).toBe(false);
});

test('checkPassword 對舊 bcrypt hash 仍能驗證（遷移 fallback）', async () => {
  const legacy = await bcrypt.hash('secret123', 4);
  expect(await checkPassword('secret123', legacy)).toBe(true);
  expect(await checkPassword('wrong', legacy)).toBe(false);
});
