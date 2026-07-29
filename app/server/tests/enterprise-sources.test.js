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
