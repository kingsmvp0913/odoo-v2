/**
 * lib/platform-backup.js — 平台自己的資料庫備份（每日自動＋管理員手動）
 *
 * 在這之前平台 DB 一份備份都沒有（2026-09-14 實查）：容器或磁碟出事，任務、設定、加密存放的
 * 客戶憑證全部一起沒。產品化規格 4 §4.4／O7：每天 pg_dump、先放這台 data/backups/、留 14 天。
 *
 * ⚠ 備份裡的 *_enc 欄位要搭配 data/config.json 的 APP_SECRET 才解得開（rules/infra 121）。
 *   只有備份沒有 APP_SECRET，救回來的客戶憑證全部是廢資料；兩者要分開保存。
 *
 * 這台沒有設定任何通知管道（2026-09-15 實查：notify_webhook_url 空、Teams 只填一半），
 * 失敗通知送得出去才算數——所以排程頁與管理員設定頁另外顯示「最近一次成功的備份」，
 * 那才是一定看得到的訊號。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killChildGracefully } = require('./proc');

// 臺灣時間。避開 22:00 健檢＋夜間改善（02:00 截止後可能重啟）、23:00 測試區關機、01:00 自動封存。
const BACKUP_HOUR = parseInt(process.env.PLATFORM_BACKUP_HOUR || '4', 10);
const KEEP_DAYS = parseInt(process.env.PLATFORM_BACKUP_KEEP_DAYS || '14', 10);
// 55MB 的 DB 實測 0.5 秒；上限只是防 pg_dump 卡死讓 .partial 永遠停在那裡。
const DUMP_TIMEOUT_MS = parseInt(process.env.PLATFORM_BACKUP_TIMEOUT_MS || '600000', 10);
const DAY_MS = 86400000;
// 每日：platform-db-YYYYMMDD.dump；手動：platform-db-YYYYMMDD-HHmmss.dump（同樣算進 14 天、同樣會被清）
const FILE_RE = /^platform-db-(\d{4})(\d{2})(\d{2})(-\d{6})?\.dump$/;
const PARTIAL_RE = /^platform-db-\d{8}(-\d{6})?\.dump\.partial$/;

let _lastFailure = null;
let _manualRunning = false;
// 寫到一半的 .partial：清舊檔時不能把正在寫的那份（例如每日備份跑的同時有人按了手動備份）刪掉。
const _inProgress = new Set();

// 請求當下才讀，不在載入時定死（rules/infra 122）
function backupDir() {
  return process.env.PLATFORM_BACKUP_DIR || path.join(__dirname, '..', '..', '..', 'data', 'backups');
}

function stampOf({ year, month, day }) {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function fileNameOf(stamp) { return `platform-db-${stamp}.dump`; }

function stampToUtcMs(stamp) {
  return Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)));
}

function taipeiStamp(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${String(Number(p.hour) % 24).padStart(2, '0')}${p.minute}${p.second}`;
}

// 下載端點用：只認自己命名規則的檔名，擋掉 ../ 之類的路徑。
function isBackupName(name) { return FILE_RE.test(String(name || '')); }

// 帳密走環境變數不走 argv：放 argv 的話，同機任何人 `ps` 就看得到 DB 密碼。
// env 只給 PATH＋PG*——不把平台整包 process.env（含 APP_SECRET／JWT_SECRET）傳給子行程。
function pgEnvFromUrl(databaseUrl) {
  const u = new URL(databaseUrl);
  return {
    PATH: process.env.PATH,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

/**
 * 跑一次 pg_dump。先寫 .partial、成功且非空才改名成正式檔——
 * 壞掉或寫一半的備份絕不能長得像一份可用的備份（沒演練過之前，人只會看檔名與大小）。
 */
function runBackup({ databaseUrl, dir, stamp, spawnFn = spawn, timeoutMs = DUMP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, fileNameOf(stamp));
    const partial = `${file}.partial`;
    const started = Date.now();
    let settled = false;
    let stderr = '';
    let timer = null;
    _inProgress.add(path.basename(partial));

    const done = () => { settled = true; clearTimeout(timer); _inProgress.delete(path.basename(partial)); };
    const fail = (err) => {
      if (settled) return;
      done();
      fs.rmSync(partial, { force: true });
      reject(err);
    };

    const child = spawnFn('pg_dump', ['-Fc', '-f', partial], {
      env: pgEnvFromUrl(databaseUrl),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    timer = setTimeout(() => {
      fail(new Error(`pg_dump 超過 ${Math.round(timeoutMs / 1000)} 秒未完成，已中止`));
      killChildGracefully(child);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    if (child.stderr) child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (err) => fail(new Error(`pg_dump 無法執行：${err.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return fail(new Error(`pg_dump exit ${code}：${stderr.trim() || '（無輸出）'}`));
      let bytes = 0;
      try { bytes = fs.statSync(partial).size; } catch { /* 檔案不存在＝0 */ }
      if (!bytes) return fail(new Error('pg_dump 回報成功，但備份檔是空的'));
      done();
      fs.renameSync(partial, file);
      resolve({ file, bytes, ms: Date.now() - started });
    });
  });
}

/**
 * 留今天在內共 keepDays 天（每日與手動都算）。只刪自己命名規則的檔：備份目錄裡若有人手動放的東西，一律不碰。
 * 殘留的 .partial（被重啟或逾時砍掉的那一次）一併清掉，但正在寫的那份不動。
 */
function pruneOldBackups({ dir, todayStamp, keepDays = KEEP_DAYS }) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const oldestKeptMs = stampToUtcMs(todayStamp) - (keepDays - 1) * DAY_MS;
  const removed = [];
  for (const name of names) {
    const m = name.match(FILE_RE);
    const stale = m
      ? stampToUtcMs(`${m[1]}${m[2]}${m[3]}`) < oldestKeptMs
      : PARTIAL_RE.test(name) && !_inProgress.has(name);
    if (!stale) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// best-effort：沒設管道就等於沒送，所以畫面上的「最近一次成功」才是主要訊號（見檔頭）。
async function sendFailureNotice(reason) {
  const message = `平台資料庫每日備份失敗：${reason}`;
  try { await require('../notify-webhook').sendWebhook(null, { type: 'platform_backup_failed', message }); } catch { /* best-effort */ }
  try {
    const teams = require('../teams');
    const settings = await teams.getSettings();
    if (teams.isConfigured(settings)) await teams.sendChannelMessage(settings, `<p><strong>⚠ ${escapeHtml(message)}</strong></p>`);
  } catch { /* best-effort */ }
}

/**
 * cron 每天呼叫一次。今天的每日檔已經在（例如平台在備份之後重啟、記憶體旗標歸零）就不重做；
 * 手動備份不算，它的檔名不同。失敗只記 log＋通知，不往外拋：cron tick 不能因為備份連坐其他排程。
 */
async function runDailyBackup({
  parts, databaseUrl = process.env.DATABASE_URL, dir = backupDir(), spawnFn, notifyFailure = sendFailureNotice,
} = {}) {
  const stamp = stampOf(parts);
  if (fs.existsSync(path.join(dir, fileNameOf(stamp)))) return { skipped: true };
  try {
    if (!databaseUrl) throw new Error('沒有 DATABASE_URL，無從備份');
    const result = await runBackup({ databaseUrl, dir, stamp, spawnFn });
    const removed = pruneOldBackups({ dir, todayStamp: stamp });
    _lastFailure = null;
    console.log('[BACKUP] 平台資料庫備份完成：%s（%d bytes，%d ms）；清掉過期 %d 份',
      path.basename(result.file), result.bytes, result.ms, removed.length);
    return { ...result, removed };
  } catch (err) {
    _lastFailure = { at: new Date().toISOString(), reason: err.message };
    console.error('[BACKUP] 平台資料庫備份失敗：', err.message);
    await notifyFailure(err.message).catch(() => {});
    return { error: err.message };
  }
}

/**
 * 管理員按「立即備份」（升級或大改之前）。檔名帶時分秒，不會蓋掉或擋掉當天的每日備份。
 * 同時只准一個：連點兩下不該疊出兩個 pg_dump。失敗直接拋給畫面——按的人就在現場。
 */
async function runManualBackup({ now = new Date(), databaseUrl = process.env.DATABASE_URL, dir = backupDir(), spawnFn } = {}) {
  if (_manualRunning) {
    const err = new Error('已經有一份手動備份正在進行');
    err.code = 'BUSY';
    throw err;
  }
  _manualRunning = true;
  try {
    if (!databaseUrl) throw new Error('沒有 DATABASE_URL，無從備份');
    const result = await runBackup({ databaseUrl, dir, stamp: taipeiStamp(now), spawnFn });
    console.log('[BACKUP] 手動備份完成：%s（%d bytes，%d ms）', path.basename(result.file), result.bytes, result.ms);
    return { ...result, file: path.basename(result.file) };
  } finally {
    _manualRunning = false;
  }
}

// 新的在前（依建立時間）；只列自己命名規則的檔。
function listBackups({ dir = backupDir() } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)); } catch { return []; }
  const files = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      files.push({ name, bytes: st.size, createdAt: st.mtime.toISOString(), manual: !!name.match(FILE_RE)[4] });
    } catch { /* 剛好被清掉 */ }
  }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 最近一次成功的備份距今幾天（以檔名日期算）；沒有任何備份回 null。
function latestAgeDays(files, todayParts) {
  if (!files.length || !todayParts) return null;
  const stamps = files.map((f) => f.name.match(FILE_RE)).map((m) => `${m[1]}${m[2]}${m[3]}`).sort();
  return Math.round((stampToUtcMs(stampOf(todayParts)) - stampToUtcMs(stamps[stamps.length - 1])) / DAY_MS);
}

// 管理員設定頁的「平台資料庫備份」區塊。今天用臺灣日期，才跟檔名的日期同一個時區比。
function backupStatus({ dir = backupDir(), now = new Date(), todayParts } = {}) {
  if (!todayParts) {
    const s = taipeiStamp(now);
    todayParts = { year: Number(s.slice(0, 4)), month: Number(s.slice(4, 6)), day: Number(s.slice(6, 8)) };
  }
  const files = listBackups({ dir });
  return {
    hour: BACKUP_HOUR, keepDays: KEEP_DAYS, lastFailure: _lastFailure,
    latestAgeDays: latestAgeDays(files, todayParts), files,
  };
}

// 排程頁用：一句話講完最近一次成功的備份；超過一天沒有新的就要讓人一眼看出來。
function describeBackups({ dir = backupDir(), todayParts } = {}) {
  const files = listBackups({ dir });
  const failure = _lastFailure ? `上次失敗（${_lastFailure.at}）：${_lastFailure.reason}。` : '';
  if (!files.length) return `${failure}⚠ 目前沒有任何備份。`;
  const latest = files[0];
  const [, y, mo, d] = latest.name.match(FILE_RE);
  const ageDays = latestAgeDays(files, todayParts) || 0;
  const warn = ageDays > 1 ? `⚠ 已經 ${ageDays} 天沒有新的備份。` : '';
  return `${failure}${warn}最近一次：${y}-${mo}-${d}（${(latest.bytes / 1048576).toFixed(1)} MB），共 ${files.length} 份，留 ${KEEP_DAYS} 天；位置 data/backups/。還原需要 data/config.json 的 APP_SECRET。`;
}

function _resetForTesting() { _lastFailure = null; _manualRunning = false; _inProgress.clear(); }

module.exports = {
  BACKUP_HOUR, KEEP_DAYS, backupDir, isBackupName, runBackup, pruneOldBackups, runDailyBackup, runManualBackup,
  listBackups, backupStatus, describeBackups, pgEnvFromUrl, _resetForTesting,
};
