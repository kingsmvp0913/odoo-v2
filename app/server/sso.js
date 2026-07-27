const crypto = require('crypto');
const usedJti = new Set(); // 一次性 nonce，記憶體即可（單行程硬限制，重啟即清）

function mintSsoToken({ secret, login, name, ttlSec = 60 }) {
  const payload = { login, name, exp: Math.floor(Date.now() / 1000) + ttlSec, jti: crypto.randomUUID() };
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  return `${p}.${sig}`;
}
function markJtiUsed(jti) { if (usedJti.has(jti)) return false; usedJti.add(jti); return true; }

module.exports = { mintSsoToken, markJtiUsed };
