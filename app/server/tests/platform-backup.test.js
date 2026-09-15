/**
 * 平台資料庫備份（lib/platform-backup.js）。
 *
 * 要守的不是「有呼叫 pg_dump」，而是備份最危險的幾種靜默失敗：
 * 壞掉的備份長得像好的、DB 密碼跑進 ps、清舊檔清到別人的檔或正在寫的檔、失敗了沒人看得到。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const backup = require('../lib/platform-backup');

const DB_URL = 'postgres://odoo:s3cr%40t@localhost:8772/aidev';
const PARTS = { year: 2026, month: 9, day: 15 };
const TAIPEI_1030 = new Date('2026-09-15T02:30:05.000Z'); // 臺灣 09-15 10:30:05

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-backup-'));
  backup._resetForTesting();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// 假 pg_dump：照 -f 寫出檔案（content 為空就不寫），再以指定 exit code 結束。
// hang＝永遠不結束（writeOnSpawn 時先把 .partial 寫出來，模擬寫到一半）。
function fakeSpawn({ code = 0, content = 'PGDMP-data', stderr = '', hang = false, writeOnSpawn = false } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn(() => { setImmediate(() => child.emit('close', null)); });
    calls.push({ cmd, args, opts, child });
    const out = args[args.indexOf('-f') + 1];
    if (hang) {
      if (writeOnSpawn) fs.writeFileSync(out, content);
    } else {
      setImmediate(() => {
        if (content) fs.writeFileSync(out, content);
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
      });
    }
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('成功：寫成正式檔、不留 .partial；DB 密碼只走環境變數不進 argv，平台總鑰匙不傳給 pg_dump', async () => {
  const prev = process.env.APP_SECRET;
  process.env.APP_SECRET = 'master-key';
  try {
    const spawnFn = fakeSpawn();
    const r = await backup.runBackup({ databaseUrl: DB_URL, dir, stamp: '20260915', spawnFn });
    expect(fs.readdirSync(dir)).toEqual(['platform-db-20260915.dump']);
    expect(r.bytes).toBeGreaterThan(0);
    const { cmd, args, opts } = spawnFn.calls[0];
    expect(cmd).toBe('pg_dump');
    expect(args.join(' ')).not.toContain('s3cr');
    expect(opts.env).toMatchObject({ PGHOST: 'localhost', PGPORT: '8772', PGUSER: 'odoo', PGPASSWORD: 's3cr@t', PGDATABASE: 'aidev' });
    expect(opts.env.APP_SECRET).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = prev;
  }
});

test('pg_dump 失敗：錯誤帶 stderr，目錄裡不留任何看起來像備份的檔', async () => {
  await expect(backup.runBackup({ databaseUrl: DB_URL, dir, stamp: '20260915', spawnFn: fakeSpawn({ code: 1, stderr: 'connection refused' }) }))
    .rejects.toThrow(/exit 1.*connection refused/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('pg_dump 回報成功但檔案是空的：當失敗處理，不改名成正式檔', async () => {
  await expect(backup.runBackup({ databaseUrl: DB_URL, dir, stamp: '20260915', spawnFn: fakeSpawn({ content: '' }) }))
    .rejects.toThrow(/空的/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('pg_dump 卡住：逾時會砍掉子行程並失敗，不留 .partial', async () => {
  const spawnFn = fakeSpawn({ hang: true });
  await expect(backup.runBackup({ databaseUrl: DB_URL, dir, stamp: '20260915', spawnFn, timeoutMs: 20 }))
    .rejects.toThrow(/未完成/);
  expect(spawnFn.calls[0].child.kill).toHaveBeenCalled();
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('清舊檔：含今天留 14 天（跨月也對、手動備份也算），更舊的刪；別人手動放的檔一律不碰；殘留 .partial 清掉', () => {
  const names = [
    'platform-db-20260915.dump', 'platform-db-20260902.dump', 'platform-db-20260901.dump', 'platform-db-20250101.dump',
    'platform-db-20260902-090000.dump', 'platform-db-20260901-235959.dump',
    'platform-db-20260910.dump.partial', 'manual-before-upgrade.dump', 'notes.txt',
  ];
  names.forEach((n) => fs.writeFileSync(path.join(dir, n), 'x'));
  const removed = backup.pruneOldBackups({ dir, todayStamp: '20260915', keepDays: 14 });
  expect(removed.sort()).toEqual([
    'platform-db-20250101.dump', 'platform-db-20260901-235959.dump', 'platform-db-20260901.dump', 'platform-db-20260910.dump.partial',
  ]);
  expect(fs.readdirSync(dir).sort()).toEqual([
    'manual-before-upgrade.dump', 'notes.txt', 'platform-db-20260902-090000.dump', 'platform-db-20260902.dump', 'platform-db-20260915.dump',
  ]);
});

test('清舊檔不會刪掉正在寫的 .partial（每日備份清檔的同時，手動備份可能正寫到一半）', async () => {
  const spawnFn = fakeSpawn({ hang: true, writeOnSpawn: true });
  const pending = backup.runManualBackup({ now: TAIPEI_1030, databaseUrl: DB_URL, dir, spawnFn });
  fs.writeFileSync(path.join(dir, 'platform-db-20260901-000000.dump.partial'), 'x');   // 真正的殘留
  const removed = backup.pruneOldBackups({ dir, todayStamp: '20260915' });
  expect(removed).toEqual(['platform-db-20260901-000000.dump.partial']);
  expect(fs.existsSync(path.join(dir, 'platform-db-20260915-103005.dump.partial'))).toBe(true);
  spawnFn.calls[0].child.emit('close', 0);
  await expect(pending).resolves.toMatchObject({ file: 'platform-db-20260915-103005.dump' });
});

test('每日備份：今天的檔已經在（例如備份後平台重啟）就不重做', async () => {
  fs.writeFileSync(path.join(dir, 'platform-db-20260915.dump'), 'x');
  const spawnFn = fakeSpawn();
  const r = await backup.runDailyBackup({ parts: PARTS, databaseUrl: DB_URL, dir, spawnFn, notifyFailure: jest.fn() });
  expect(r.skipped).toBe(true);
  expect(spawnFn.calls).toHaveLength(0);
});

test('每日備份成功：順手清掉過期的，排程頁顯示最近一次的日期', async () => {
  fs.writeFileSync(path.join(dir, 'platform-db-20250101.dump'), 'x');
  const r = await backup.runDailyBackup({ parts: PARTS, databaseUrl: DB_URL, dir, spawnFn: fakeSpawn(), notifyFailure: jest.fn() });
  expect(r.removed).toEqual(['platform-db-20250101.dump']);
  const note = backup.describeBackups({ dir, todayParts: PARTS });
  expect(note).toMatch(/最近一次：2026-09-15/);
  expect(note).not.toMatch(/⚠/);
});

test('每日備份失敗：不往外拋（不能連坐 cron 其他排程），發通知，畫面看得到失敗原因', async () => {
  const notifyFailure = jest.fn().mockResolvedValue();
  const r = await backup.runDailyBackup({
    parts: PARTS, databaseUrl: DB_URL, dir, spawnFn: fakeSpawn({ code: 1, stderr: 'disk full' }), notifyFailure,
  });
  expect(r.error).toMatch(/disk full/);
  expect(notifyFailure).toHaveBeenCalledWith(expect.stringMatching(/disk full/));
  const note = backup.describeBackups({ dir, todayParts: PARTS });
  expect(note).toMatch(/上次失敗.*disk full/);
  expect(note).toMatch(/沒有任何備份/);
  expect(backup.backupStatus({ dir, todayParts: PARTS }).lastFailure.reason).toMatch(/disk full/);
});

test('沒有 DATABASE_URL：大聲失敗，不建目錄、不跑 pg_dump', async () => {
  const sub = path.join(dir, 'backups');
  const spawnFn = fakeSpawn();
  const notifyFailure = jest.fn().mockResolvedValue();
  const r = await backup.runDailyBackup({ parts: PARTS, databaseUrl: '', dir: sub, spawnFn, notifyFailure });
  expect(r.error).toMatch(/DATABASE_URL/);
  expect(notifyFailure).toHaveBeenCalled();
  expect(fs.existsSync(sub)).toBe(false);
  expect(spawnFn.calls).toHaveLength(0);
});

test('最近一次備份超過一天就警告（備份默默停掉時唯一看得到的訊號）', () => {
  fs.writeFileSync(path.join(dir, 'platform-db-20260910.dump'), 'x');
  expect(backup.describeBackups({ dir, todayParts: PARTS })).toMatch(/已經 5 天沒有新的備份/);
  expect(backup.backupStatus({ dir, todayParts: PARTS }).latestAgeDays).toBe(5);
});

test('手動備份：檔名帶臺灣時間的時分秒，不會讓當天的每日備份被跳過', async () => {
  const r = await backup.runManualBackup({ now: TAIPEI_1030, databaseUrl: DB_URL, dir, spawnFn: fakeSpawn() });
  expect(r.file).toBe('platform-db-20260915-103005.dump');
  const daily = await backup.runDailyBackup({ parts: PARTS, databaseUrl: DB_URL, dir, spawnFn: fakeSpawn(), notifyFailure: jest.fn() });
  expect(daily.skipped).toBeUndefined();
  expect(fs.readdirSync(dir).sort()).toEqual(['platform-db-20260915-103005.dump', 'platform-db-20260915.dump']);
});

test('手動備份正在跑時再按一次：直接拒絕，不疊第二個 pg_dump', async () => {
  const spawnFn = fakeSpawn({ hang: true });
  const first = backup.runManualBackup({ now: TAIPEI_1030, databaseUrl: DB_URL, dir, spawnFn });
  await expect(backup.runManualBackup({ now: TAIPEI_1030, databaseUrl: DB_URL, dir, spawnFn })).rejects.toMatchObject({ code: 'BUSY' });
  expect(spawnFn.calls).toHaveLength(1);
  spawnFn.calls[0].child.emit('close', 1);   // 收掉第一個
  await expect(first).rejects.toThrow(/exit 1/);
  // 第一個結束後可以再按
  await expect(backup.runManualBackup({ now: TAIPEI_1030, databaseUrl: DB_URL, dir, spawnFn: fakeSpawn() })).resolves.toBeTruthy();
});

test('清單：只列備份命名規則的檔，新的在前，分得出手動與每日', () => {
  const put = (name, iso) => {
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), new Date(iso), new Date(iso));
  };
  put('platform-db-20260914.dump', '2026-09-13T20:00:00Z');
  put('platform-db-20260915-103005.dump', '2026-09-15T02:30:05Z');
  put('notes.txt', '2026-09-15T05:00:00Z');
  put('platform-db-20260915.dump.partial', '2026-09-15T05:00:00Z');
  expect(backup.listBackups({ dir }).map((f) => [f.name, f.manual])).toEqual([
    ['platform-db-20260915-103005.dump', true],
    ['platform-db-20260914.dump', false],
  ]);
  expect(backup.backupStatus({ dir, todayParts: PARTS }).latestAgeDays).toBe(0);
});

test('下載用的檔名檢查：只認備份命名規則，帶路徑的一律不認', () => {
  expect(backup.isBackupName('platform-db-20260915.dump')).toBe(true);
  expect(backup.isBackupName('platform-db-20260915-103005.dump')).toBe(true);
  for (const bad of ['../data/config.json', 'platform-db-20260915.dump/../../config.json', 'config.json',
    'platform-db-20260915.dump.partial', '', undefined]) {
    expect(backup.isBackupName(bad)).toBe(false);
  }
});
