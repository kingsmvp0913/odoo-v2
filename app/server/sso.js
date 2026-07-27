const crypto = require('crypto');

function mintSsoToken({ secret, login, name, ttlSec = 30 }) {
  const payload = { login, name, exp: Math.floor(Date.now() / 1000) + ttlSec, jti: crypto.randomUUID() };
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  return `${p}.${sig}`;
}

module.exports = { mintSsoToken };
