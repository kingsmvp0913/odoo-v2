// L7FW SSLVPN 的 .ovpn 把帳密存在 openvpn 會忽略的 #SSLVPN_AUTH_* 註解欄位，且每 byte XOR 0x05
// 混淆（GUI 連線時自己還原）。原樣帶進表單就會存成連不上的亂碼帳號——這正是 conn 1 曾經
// AUTH_FAILED 的原因。還原後若出現控制字元，代表這家廠牌沒混淆或格式不同，退回原值。
function deobfuscateSslvpn(s) {
  if (!s) return s;
  const out = Array.from(String(s), c => String.fromCharCode(c.charCodeAt(0) ^ 5)).join('');
  return /^[\x21-\x7e]+$/.test(out) ? out : s;
}

if (typeof window !== 'undefined') window.DEOBFUSCATE_SSLVPN = deobfuscateSslvpn;
if (typeof module !== 'undefined') module.exports = { deobfuscateSslvpn };
