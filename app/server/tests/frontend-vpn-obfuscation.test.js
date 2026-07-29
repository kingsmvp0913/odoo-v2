// 意圖：conn1 當初被存成 AUTH_FAILED 的廢帳號，根因就是前端把 .ovpn 裡的「混淆值」原樣帶進表單。
// L7FW SSLVPN 把帳密寫在 openvpn 會忽略的 # 註解欄位，且每 byte XOR 0x05。
const { deobfuscateSslvpn } = require('../../public/js/vpn-obfuscation.js');

test('還原鴻久 config 0 的帳號（實測值）', () => {
  expect(deobfuscateSslvpn('dlfa0')).toBe('aicd5');
});

test('還原鴻久 config 0 的密碼（實測值）', () => {
  expect(deobfuscateSslvpn('Dlfa0')).toBe('Aicd5');
});

test('還原後含控制字元時退回原值（別家廠牌可能沒混淆或格式不同）', () => {
  // 'a' ^ 5 = 'd'，但 '\x00' ^ 5 = '\x05' 仍是控制字元 → 判定不是有效還原
  expect(deobfuscateSslvpn('a\x00')).toBe('a\x00');
});

test('空字串與 undefined 原樣回傳，不丟錯', () => {
  expect(deobfuscateSslvpn('')).toBe('');
  expect(deobfuscateSslvpn(undefined)).toBeUndefined();
});
