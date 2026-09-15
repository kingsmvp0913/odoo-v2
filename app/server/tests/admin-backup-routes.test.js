// 意圖：備份檔含全部加密憑證、密碼雜湊與客戶任務原文。清單／立即備份／下載三支都只能給平台管理員；
// 下載只准拿備份目錄裡、符合命名規則的檔——檔名能帶 ../ 的話，這支就變成讀整台主機任意檔案的洞；
// 每次下載都要留紀錄，事後才查得到是誰拿走的（09-15 使用者知情選擇開放下載）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');
const request = require('supertest');

// 立即備份會真的跑 pg_dump；路由測試只驗權限與回應，換掉那一支。
jest.mock('../lib/platform-backup', () => ({
  ...jest.requireActual('../lib/platform-backup'),
  runManualBackup: jest.fn(),
}));

process.env.JWT_SECRET = 'test-backup-routes';

let dbModule, app, adminToken, userToken, dir, backup;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-routes-'));
  process.env.PLATFORM_BACKUP_DIR = path.join(dir, 'backups');
  fs.mkdirSync(process.env.PLATFORM_BACKUP_DIR);

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  backup = require('../lib/platform-backup');

  const { hashPassword } = require('../password');
  const pw = await hashPassword('pw');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('adm',$1,'A','admin'), ('usr',$1,'U','user')",
    [pw]
  );
  adminToken = (await request(app).post('/api/auth/login').send({ username: 'adm', password: 'pw' })).body.token;
  userToken = (await request(app).post('/api/auth/login').send({ username: 'usr', password: 'pw' })).body.token;
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  delete process.env.PLATFORM_BACKUP_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { backup.runManualBackup.mockReset(); });

const bdir = () => process.env.PLATFORM_BACKUP_DIR;
const put = (name, content = 'PGDMP-x', iso = null) => {
  fs.writeFileSync(path.join(bdir(), name), content);
  if (iso) fs.utimesSync(path.join(bdir(), name), new Date(iso), new Date(iso));
};
const asText = (res, cb) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); };

test('三支都要登入', async () => {
  put('platform-db-20260915.dump');
  expect((await request(app).get('/api/admin/backups')).status).toBe(401);
  expect((await request(app).post('/api/admin/backups')).status).toBe(401);
  expect((await request(app).get('/api/admin/backups/platform-db-20260915.dump/download')).status).toBe(401);
  expect(backup.runManualBackup).not.toHaveBeenCalled();
});

test('一般使用者一支都拿不到', async () => {
  put('platform-db-20260915.dump', 'PGDMP-secret');
  const auth = { Authorization: `Bearer ${userToken}` };
  expect((await request(app).get('/api/admin/backups').set(auth)).status).toBe(403);
  expect((await request(app).post('/api/admin/backups').set(auth)).status).toBe(403);
  const dl = await request(app).get('/api/admin/backups/platform-db-20260915.dump/download').set(auth).buffer(true).parse(asText);
  expect(dl.status).toBe(403);
  expect(String(dl.body)).not.toContain('PGDMP-secret');
  expect(backup.runManualBackup).not.toHaveBeenCalled();
});

test('管理員看得到清單：只列備份檔，新的在前，帶保留天數與排程時間', async () => {
  put('platform-db-20260914.dump', 'x', '2026-09-13T20:00:00Z');
  put('platform-db-20260915-103005.dump', 'x', '2026-09-15T02:30:05Z');
  put('notes.txt');
  const res = await request(app).get('/api/admin/backups').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const names = res.body.files.map((f) => f.name);
  expect(names.indexOf('platform-db-20260915-103005.dump')).toBeLessThan(names.indexOf('platform-db-20260914.dump'));
  expect(names).not.toContain('notes.txt');
  expect(res.body).toMatchObject({ hour: 4, keepDays: 14 });
});

test('下載：拿得到檔案內容、以附件下載，並留下是誰下載的紀錄', async () => {
  put('platform-db-20260915.dump', 'PGDMP-content');
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const res = await request(app).get('/api/admin/backups/platform-db-20260915.dump/download')
      .set('Authorization', `Bearer ${adminToken}`).buffer(true).parse(asText);
    expect(res.status).toBe(200);
    expect(res.body).toBe('PGDMP-content');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="platform-db-20260915\.dump"/);
    const line = log.mock.calls.map((c) => require('util').format(...c)).find((l) => l.includes('platform-db-20260915.dump'));
    expect(line).toMatch(/下載/);
    expect(line).toMatch(/user_id=\d+/);
  } finally {
    log.mockRestore();
  }
});

test('下載：檔名帶路徑或不符命名規則一律擋，讀不到備份目錄以外的檔', async () => {
  fs.writeFileSync(path.join(dir, 'config.json'), 'APP_SECRET-leak');      // 備份目錄的上一層
  put('config.json', 'APP_SECRET-leak');                                   // 備份目錄裡但不是備份檔
  const auth = { Authorization: `Bearer ${adminToken}` };
  for (const name of ['..%2Fconfig.json', 'config.json', 'platform-db-20260915.dump%2F..%2F..%2Fconfig.json']) {
    const res = await request(app).get(`/api/admin/backups/${name}/download`).set(auth).buffer(true).parse(asText);
    expect([400, 404]).toContain(res.status);
    expect(String(res.body)).not.toContain('APP_SECRET-leak');
  }
  const missing = await request(app).get('/api/admin/backups/platform-db-20200101.dump/download').set(auth);
  expect(missing.status).toBe(404);
});

test('立即備份：成功回檔名；已經有一份在跑時回 409，不是 500', async () => {
  const auth = { Authorization: `Bearer ${adminToken}` };
  backup.runManualBackup.mockResolvedValueOnce({ file: 'platform-db-20260915-103005.dump', bytes: 10, ms: 5 });
  const ok = await request(app).post('/api/admin/backups').set(auth);
  expect(ok.status).toBe(200);
  expect(ok.body.file).toBe('platform-db-20260915-103005.dump');

  backup.runManualBackup.mockRejectedValueOnce(Object.assign(new Error('已經有一份手動備份正在進行'), { code: 'BUSY' }));
  const busy = await request(app).post('/api/admin/backups').set(auth);
  expect(busy.status).toBe(409);
  expect(busy.body.error).toMatch(/正在進行/);
});
