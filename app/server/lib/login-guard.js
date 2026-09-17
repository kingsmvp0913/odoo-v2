// app/server/lib/login-guard.js
/**
 * login-guard.js — 登入失敗次數限制（2026-09-16）
 *
 * 為什麼需要：`POST /api/auth/login` 原本是「查 DB ＋ 比對密碼」就結束，沒有任何次數限制。
 * 子專案 0 的 M6 實測發現 AI 容器連得到平台 8771（`--internal` 網路只擋外網、不擋主機，而 8771 聽 `*`），
 * 等於一個被注入的 AI 可以無限猜密碼——猜中 9 個管理員中的任何一個，就把整個平台拿回去。
 *
 * 鎖定對象是 **(帳號, 來源)** 這一對，不是帳號本身（2026-09-16 使用者裁決）：
 * 只鎖帳號的話，AI 可以故意對每個管理員帳號各打錯 10 次，把所有人永久封鎖、沒有人解得開，
 * 等於把機密性問題換成整個平台停擺。真人經 nginx 進來、容器直連 8771，remoteAddress 不同。
 *
 * 計數落 DB 不放記憶體：放記憶體的話，攻擊者只要等一次平台重啟就歸零。
 */
const net = require('net');
const { query } = require('../db');

const LOCK_THRESHOLD = 5;      // 錯這麼多次 → 鎖一段時間
const LOCK_MINUTES = 10;       // 鎖多久
const BLOCK_THRESHOLD = 10;    // 累計錯這麼多次 → 永久封鎖，要管理員手動解

const asDate = now => new Date(typeof now === 'function' ? now() : now);

async function checkLogin({ username, source, now = () => new Date() }) {
  const { rows: [r] } = await query(
    'SELECT fail_count, locked_until, blocked FROM login_attempts WHERE username = $1 AND source = $2',
    [username, source]
  );
  if (!r) return { allowed: true };
  if (r.blocked) return { allowed: false, reason: 'blocked' };
  if (r.locked_until && new Date(r.locked_until).getTime() > asDate(now).getTime()) {
    return { allowed: false, reason: 'locked', until: new Date(r.locked_until).toISOString() };
  }
  return { allowed: true };
}

// 先查再寫（不用 ON CONFLICT … RETURNING）：pg-mem 的 upsert RETURNING 回傳值不可信，
// 會讓正確的碼在測試裡紅（見記憶 pgmem-on-conflict-returning-lies）。
async function recordFailure({ username, source, now = () => new Date() }) {
  const t = asDate(now);
  const { rows: [cur] } = await query(
    'SELECT fail_count, locked_until FROM login_attempts WHERE username = $1 AND source = $2',
    [username, source]
  );
  const n = (cur ? Number(cur.fail_count) : 0) + 1;
  const blocked = n >= BLOCK_THRESHOLD;
  // 每滿 LOCK_THRESHOLD 的倍數鎖一次；沒滿就沿用原本的鎖（可能已過期）
  const lockedUntil = blocked ? null
    : (n % LOCK_THRESHOLD === 0 ? new Date(t.getTime() + LOCK_MINUTES * 60000) : (cur ? cur.locked_until : null));

  if (cur) {
    await query(
      'UPDATE login_attempts SET fail_count = $3, locked_until = $4, blocked = $5, last_failed_at = $6 WHERE username = $1 AND source = $2',
      [username, source, n, lockedUntil, blocked, t]
    );
  } else {
    await query(
      'INSERT INTO login_attempts (username, source, fail_count, locked_until, blocked, last_failed_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, source, n, lockedUntil, blocked, t]
    );
  }
  return { fail_count: n, blocked, locked_until: lockedUntil };
}

async function recordSuccess({ username, source }) {
  await query('DELETE FROM login_attempts WHERE username = $1 AND source = $2', [username, source]);
}

// 只列出「現在還鎖著」或「已封鎖」的；自然過期的不該佔著畫面
async function listLocks({ now = () => new Date() } = {}) {
  const { rows } = await query(
    `SELECT username, source, fail_count, locked_until, blocked, last_failed_at
       FROM login_attempts
      WHERE blocked = true OR locked_until > $1
      ORDER BY last_failed_at DESC`,
    [asDate(now)]
  );
  return rows;
}

// 使用者管理頁用：每個帳號目前有幾個來源被鎖／被封鎖
async function lockSummary({ now = () => new Date() } = {}) {
  const rows = await listLocks({ now });
  const out = {};
  for (const r of rows) {
    if (!out[r.username]) out[r.username] = { locked: 0, blocked: 0 };
    if (r.blocked) out[r.username].blocked += 1;
    else out[r.username].locked += 1;
  }
  return out;
}

// 封鎖的也要解得掉，否則管理員救不回誤鎖的人
async function clearLock(username, source) {
  await query('DELETE FROM login_attempts WHERE username = $1 AND source = $2', [username, source]);
}

// 認出真實來源（最終審查 IMPORTANT-2，裁決 R16）：網頁使用者全經 nginx 進來，remoteAddress 都是 nginx 同一個位址，
// 拿它當來源等於「網路上任何人打錯 10 次，管理員對所有人封鎖」。只有直連的對方在 TRUSTED_PROXY_IPS
// （data/config.json，逗號分隔的完整 IP，start.sh 匯出）裡，才採用它轉來的 X-Real-IP；
// 其他人（例如直連 8771 的 AI 容器）自己帶的 header 不理。不用 Express 的 trust proxy：會改到全站的 req.ip。
// 沒設 TRUSTED_PROXY_IPS → 與原本完全相同（remoteAddress 原值）。
const unmap = ip => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip);
function clientSource(req, trusted = process.env.TRUSTED_PROXY_IPS) {
  const peer = (req.socket && req.socket.remoteAddress) || 'unknown';
  const list = String(trusted || '').split(',').map(x => unmap(x.trim())).filter(Boolean);
  if (!list.length) return peer;
  const p = unmap(peer);
  if (!list.includes(p)) return p;
  const real = String((req.headers && req.headers['x-real-ip']) || '').trim();
  return net.isIP(real) ? unmap(real) : p;
}

module.exports = {
  LOCK_THRESHOLD, LOCK_MINUTES, BLOCK_THRESHOLD, clientSource,
  checkLogin, recordFailure, recordSuccess, listLocks, lockSummary, clearLock,
};
