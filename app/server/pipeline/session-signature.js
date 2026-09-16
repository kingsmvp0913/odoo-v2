// app/server/pipeline/session-signature.js
/**
 * session-signature.js — 「--resume 指定的 session 不存在」的 CLI 字面（子專案 0 §6）
 * SAMPLE_LINE 是 Task M2 在這台主機以不存在的 session id 實測取得的整行，不是猜的。
 * 比對時只把其中的 UUID 換成萬用樣式，其餘逐字；claude 升版後字面若變了，這支測試不會紅，
 * 但續接失敗仍會照舊降級 fresh（只是時間軸少一行說明）——升版時重跑 M2。
 *
 * M2 實測（2026-09-16，claude 2.1.267）：exit code 1，該行同時出現在 stderr 與 stdout 的
 * JSON result 事件的 errors[]；subtype 為 error_during_execution。
 */
const SAMPLE_LINE = 'No conversation found with session ID: 00000000-0000-4000-8000-000000000000';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineToPattern(line) {
  const m = UUID_RE.exec(line);
  if (!m) throw new Error('SAMPLE_LINE 必須含 M2 實測時用的 session UUID');
  const before = escapeRe(line.slice(0, m.index).trim());
  const after = escapeRe(line.slice(m.index + m[0].length).trim());
  return new RegExp(`${before}\\s*[0-9a-f-]{36}\\s*${after}`, 'i');
}

const MISSING_SESSION = [lineToPattern(SAMPLE_LINE)];

function missingSessionReason(text) {
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (MISSING_SESSION.some(re => re.test(line))) return line.trim().slice(0, 300);
  }
  return null;
}

function looksLikeMissingSession(text) { return missingSessionReason(text) !== null; }

module.exports = { SAMPLE_LINE, MISSING_SESSION, looksLikeMissingSession, missingSessionReason };
