// 意圖：企業版最危險的失敗模式是「靜默降級成社群版」——使用者以為在測企業版，實際 web_enterprise
// 根本沒掛上，測到的是社群版 UI，而且不會有任何錯誤訊息。故 resolveEnterprisePath 的每一種
// 「不可用」都必須回明確錯誤（且訊息指名是哪個版本），絕不回一個「就當沒有」的空值。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { newDb } = require('pg-mem');

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args) => mockExecFile(...args),
}));

let dbModule, ent, tmpBase;

beforeAll(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-test-'));
  process.env.ENTERPRISE_BASE_DIR = tmpBase;
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ent = require('../lib/enterprise-sources');
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  delete process.env.ENTERPRISE_BASE_DIR;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  await dbModule.query('DELETE FROM enterprise_sources');
  mockExecFile.mockReset();
});

// git 成功：execFile(file, args, opts, cb) → cb(null, '', '')
const gitOk = () => mockExecFile.mockImplementation((_f, _a, _o, cb) => cb(null, '', ''));
const gitFail = (stderr) => mockExecFile.mockImplementation((_f, _a, _o, cb) => {
  const err = new Error('git failed'); err.stderr = stderr; cb(err, '', stderr);
});

test('未登記來源 → 回錯誤且訊息指名版本（不可回 ok 讓它默默跑社群版）', async () => {
  const r = await ent.resolveEnterprisePath('17.0');
  expect(r.ok).toBe(false);
  expect(r.error).toContain('17');
  expect(r.error).toContain('企業版');
});

test('已登記但沒同步成功 → 回錯誤（狀態 pending 不算可用）', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url) VALUES ('17','https://x/e.git')");
  const r = await ent.resolveEnterprisePath('17.0');
  expect(r.ok).toBe(false);
  expect(r.error).toContain('17');
});

test('狀態 done 但本地目錄已不存在 → 回錯誤（DB 說有、磁碟沒有＝掛上去也是空的）', async () => {
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, local_path, clone_status) VALUES ('17','https://x/e.git',$1,'done')",
    [path.join(tmpBase, 'gone')]
  );
  const r = await ent.resolveEnterprisePath('17.0');
  expect(r.ok).toBe(false);
});

test('狀態 done 且目錄存在 → 回該路徑（大版本取自 17.0 的第一段）', async () => {
  const dir = path.join(tmpBase, '17');
  fs.mkdirSync(dir, { recursive: true });
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, local_path, clone_status) VALUES ('17','https://x/e.git',$1,'done')",
    [dir]
  );
  const r = await ent.resolveEnterprisePath('17.0');
  expect(r).toEqual({ ok: true, path: dir });
});

test('首次同步走 clone，帶 branch，成功後狀態 done 並寫回 local_path 與同步時間', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url, branch) VALUES ('17','https://x/e.git','17.0')");
  gitOk();
  const r = await ent.syncSource('17');
  expect(r.ok).toBe(true);
  const args = mockExecFile.mock.calls[0][1];
  expect(args[0]).toBe('clone');
  expect(args).toContain('--branch');
  expect(args).toContain('17.0');
  const { rows: [s] } = await dbModule.query("SELECT clone_status, local_path, last_synced_at FROM enterprise_sources WHERE odoo_version='17'");
  expect(s.clone_status).toBe('done');
  expect(s.local_path).toBe(path.join(tmpBase, '17'));
  expect(s.last_synced_at).not.toBeNull();
});

// 意圖：同步失敗必須留下錯誤原文給管理員看，否則介面只會顯示「失敗」卻查不出是 PAT 沒權限還是 branch 打錯。
test('同步失敗 → 狀態 error 並保留 git stderr', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url) VALUES ('17','https://x/e.git')");
  gitFail('fatal: Authentication failed');
  const r = await ent.syncSource('17');
  expect(r.ok).toBe(false);
  const { rows: [s] } = await dbModule.query("SELECT clone_status, error_msg FROM enterprise_sources WHERE odoo_version='17'");
  expect(s.clone_status).toBe('error');
  expect(s.error_msg).toContain('Authentication failed');
});

// 意圖：enterprise 是唯讀來源，重複同步要能收斂到遠端狀態；用 fetch+reset 而非 pull，
// 避免 shallow clone 的 pull 行為差異與本地殘留擋住更新。
test('已 clone 過 → 走 fetch + reset --hard，不重新 clone', async () => {
  const dir = path.join(tmpBase, '18');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, branch, local_path, clone_status) VALUES ('18','https://x/e.git','18.0',$1,'done')",
    [dir]
  );
  gitOk();
  const r = await ent.syncSource('18');
  expect(r.ok).toBe(true);
  const calls = mockExecFile.mock.calls.map(c => c[1]);
  expect(calls.some(a => a.includes('fetch'))).toBe(true);
  expect(calls.some(a => a.includes('reset'))).toBe(true);
  expect(calls.some(a => a.includes('clone'))).toBe(false);
});

// 意圖：管理員把 URL 填錯後用「編輯」改成正確 URL 再同步，是本功能要擋的最危險情境——
// 若只改 DB 不改 git remote，fetch 會抓 clone 當下寫進 .git/config 的舊 origin，卻回報成功、
// 狀態顯示可用，掛進容器的其實是錯的 repo。故已 clone 過的來源再同步時，必須先把 origin
// 收斂到 DB 目前的 repo_url，才能 fetch 到「使用者現在以為在用」的那個 repo。
test('已 clone 過的來源改了 repo_url 後再同步 → git 參數要帶新 URL（不可黏著舊 origin）', async () => {
  const dir = path.join(tmpBase, '20');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, branch, local_path, clone_status) VALUES ('20','https://old-wrong/e.git','20.0',$1,'done')",
    [dir]
  );
  // 模擬管理員事後用「編輯」修正 URL：PUT 只改 DB，不動既有 clone 的 git remote
  await dbModule.query("UPDATE enterprise_sources SET repo_url='https://correct/e.git' WHERE odoo_version='20'");
  gitOk();
  const r = await ent.syncSource('20');
  expect(r.ok).toBe(true);
  const calls = mockExecFile.mock.calls.map(c => c[1]);
  expect(calls.some(a => a.includes('https://correct/e.git'))).toBe(true);
});

test('同步未登記的版本 → 回錯誤，不去碰 git', async () => {
  const r = await ent.syncSource('19');
  expect(r.ok).toBe(false);
  expect(mockExecFile).not.toHaveBeenCalled();
});

// ── 本地目錄來源（source_type='local'）─────────────────────────────────────
// 意圖：企業版整包上百 MB，推上 git 既慢又是把有授權的專有碼放進遠端。本地型態讓管理員直接把
// addons 放進共用目錄，但「不驗證」等於在上面那條「靜默降級成社群版」的防線上破洞——目錄裡放
// 錯東西時 Odoo 不會報錯，只是安靜地用社群版 web 啟動。故登記時就要把三種放錯法擋在門口。

// 造一個本地 enterprise 目錄；預設合格，參數用來製造各種放錯法
function makeLocalDir(major, { version = `${major}.0.1.0`, mode = 0o644, siblings = [] } = {}) {
  const dir = path.join(tmpBase, String(major));
  const we = path.join(dir, 'web_enterprise');
  fs.mkdirSync(we, { recursive: true });
  const mf = path.join(we, '__manifest__.py');
  fs.writeFileSync(mf, `{\n    'name': 'Web Enterprise',\n    'version': '${version}',\n}\n`);
  fs.chmodSync(mf, mode);
  for (const s of siblings) {
    fs.mkdirSync(path.join(dir, s), { recursive: true });
    fs.writeFileSync(path.join(dir, s, '__manifest__.py'), "{'name': 'x'}");
  }
  return dir;
}

const insertLocal = (major) => dbModule.query(
  "INSERT INTO enterprise_sources (odoo_version, repo_url, source_type) VALUES ($1,'','local')", [String(major)]
);

test('本地目錄合格 → 狀態 done、寫回 local_path 與模組數，且全程不碰 git', async () => {
  makeLocalDir(15, { siblings: ['account_accountant', 'documents'] });
  await insertLocal(15);
  const r = await ent.syncSource('15');
  expect(r.ok).toBe(true);
  expect(r.moduleCount).toBe(3);            // web_enterprise + 兩個 siblings
  expect(mockExecFile).not.toHaveBeenCalled();
  const { rows: [s] } = await dbModule.query("SELECT clone_status, local_path, last_synced_at FROM enterprise_sources WHERE odoo_version='15'");
  expect(s.clone_status).toBe('done');
  expect(s.local_path).toBe(path.join(tmpBase, '15'));
  expect(s.last_synced_at).not.toBeNull();
});

// 意圖：解壓企業版 tarball 最常見的結果是 enterprise/17/enterprise-17.0/web_enterprise——多包一層時
// addons-path 指到的那層沒有任何模組，Odoo 一樣安靜跑社群版。訊息必須直接點名那個子目錄，
// 否則管理員看到「找不到 web_enterprise」只會覺得自己明明放了。
test('缺 web_enterprise 且底下只有單一子目錄 → 錯誤訊息點名該子目錄（多包一層）', async () => {
  const dir = path.join(tmpBase, '16');
  fs.mkdirSync(path.join(dir, 'enterprise-16.0', 'web_enterprise'), { recursive: true });
  await insertLocal(16);
  const r = await ent.syncSource('16');
  expect(r.ok).toBe(false);
  expect(r.error).toContain('enterprise-16.0');
  const { rows: [s] } = await dbModule.query("SELECT clone_status, error_msg FROM enterprise_sources WHERE odoo_version='16'");
  expect(s.clone_status).toBe('error');
  expect(s.error_msg).toContain('enterprise-16.0');
});

// 意圖（鑑別力）：多包一層的提示只在「真的只有一個子目錄」時才成立。目錄裡本來就散著多個模組卻
// 缺 web_enterprise，是另一回事（放成社群版 addons／只放了部分模組），不可套同一句話誤導。
test('缺 web_enterprise 但底下有多個子目錄 → 一般錯誤，不亂猜多包一層', async () => {
  const dir = path.join(tmpBase, '13');
  fs.mkdirSync(path.join(dir, 'sale_management'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stock'), { recursive: true });
  await insertLocal(13);
  const r = await ent.syncSource('13');
  expect(r.ok).toBe(false);
  expect(r.error).toContain('web_enterprise');
  expect(r.error).not.toContain('多包');
});

// 意圖：17 的目錄放進 18 的包，掛起來 Odoo 會裝到版本不符的模組，錯誤在建置很後期才浮現且
// 訊息不指向這裡。manifest 的 version 是現成的判準，登記當下就能擋。
test('manifest 版本與登記的大版本不符 → 錯誤指名兩個版本', async () => {
  makeLocalDir(14, { version: '18.0.1.0' });
  await insertLocal(14);
  const r = await ent.syncSource('14');
  expect(r.ok).toBe(false);
  expect(r.error).toContain('18.0.1.0');
  expect(r.error).toContain('14');
});

// 意圖：容器內的 odoo 是另一個 uid，掛載是唯讀但仍要讀得到。scp／unzip 進來的檔案若是 600，
// Odoo 看到的是一個空 addons 目錄——同樣是靜默降級。這台先前已因 filestore 權限踩過一次。
test('manifest 非 other-readable → 錯誤提示權限（容器內 odoo 是別的 uid）', async () => {
  makeLocalDir(12, { mode: 0o600 });
  await insertLocal(12);
  const r = await ent.syncSource('12');
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/權限|chmod/);
});

test('本地型態通過檢查後 → resolveEnterprisePath 照常回該路徑', async () => {
  const dir = makeLocalDir(11);
  await insertLocal(11);
  await ent.syncSource('11');
  const r = await ent.resolveEnterprisePath('11.0');
  expect(r).toEqual({ ok: true, path: dir });
});
