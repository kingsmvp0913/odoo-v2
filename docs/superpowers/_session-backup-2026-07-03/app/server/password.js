/**
 * password.js — 與 Odoo (passlib) 互通的密碼雜湊
 *
 * 產生格式：$pbkdf2-sha512$<rounds>$<ab64 salt>$<ab64 checksum>
 * 與 Odoo res.users 的 CryptContext(['pbkdf2_sha512', ...]) 完全相容，
 * 故 users.password_hash 可直接寫入 Odoo 的 res_users.password 欄位。
 *
 * checkPassword 保留 bcrypt 驗證路徑，讓遷移期間既有的 $2 hash 仍可登入。
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROUNDS = 25000;      // passlib pbkdf2_sha512 預設；hash 自帶，Odoo 依字串內 rounds 驗證
const SALT_BYTES = 16;
const KEY_BYTES = 64;      // sha512 digest 長度

// passlib adapted-base64：標準 base64，'+' -> '.'，去掉尾端 '='
function ab64encode(buf) {
  return buf.toString('base64').replace(/\+/g, '.').replace(/=+$/, '');
}
function ab64decode(str) {
  let s = str.replace(/\./g, '+');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const dk = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, ROUNDS, KEY_BYTES, 'sha512');
  return Promise.resolve(`$pbkdf2-sha512$${ROUNDS}$${ab64encode(salt)}$${ab64encode(dk)}`);
}

async function checkPassword(pw, hash) {
  if (typeof hash !== 'string') return false;
  if (hash.startsWith('$pbkdf2-sha512$')) {
    const m = /^\$pbkdf2-sha512\$(\d+)\$([^$]*)\$([^$]+)$/.exec(hash);
    if (!m) return false;
    const rounds = parseInt(m[1], 10);
    const salt = ab64decode(m[2]);
    const expected = ab64decode(m[3]);
    const dk = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, rounds, expected.length, 'sha512');
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  }
  // 遷移 fallback：既有的 bcrypt hash
  return bcrypt.compare(pw, hash);
}

module.exports = { hashPassword, checkPassword };
