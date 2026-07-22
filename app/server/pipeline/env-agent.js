const net = require('net');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { ensureTestingBranch } = require('./git');
const { E2E_LOGIN, E2E_PASSWORD } = require('./e2e-account');
const { allocateProjectPort, loopbackHostForPort } = require('../port-alloc');
const { startProjectVpns, stopProjectVpns } = require('../lib/project-vpn');

// 測試環境一律建在專案內 odoo-v2/odoo-envs（比照 REPOS_BASE 慣例），不得跑到專案外
const ENV_BASE = process.env.ODOO_ENV_BASE || path.resolve(__dirname, '..', '..', '..', 'odoo-envs');

// 測試區一律建在官方 odoo:<major> image 的容器上，徹底避開宿主多版本 Python／gevent 編譯，
// 自動涵蓋 odoo 13→未來 20+（唯一建置模式；舊的宿主 venv 模式已移除）。
const dockerEnv = require('../lib/docker-env');
const DOCKER_CTX_DIR = path.resolve(__dirname, '..', '..', 'docker'); // app/docker（含 Dockerfile.odoo）
// 容器內 tour（HttpCase）自起的 http 埠：與常駐 server 的 8069 錯開（exec 與 server 共用容器網路）。
const DOCKER_TEST_HTTP_PORT = 8169;

// 組某專案的 docker 操作上下文（容器名、image、DB、addons 掛載、db 連線參數、env 目錄）。
async function dockerCtxFor(projectId) {
  const { rows: [project] } = await query('SELECT name, folder_name, odoo_version, port FROM projects WHERE id=$1', [projectId]);
  if (!project) return null;
  const dirName = project.folder_name || project.name;
  const major = (project.odoo_version || '17.0').split('.')[0];
  const hostPaths = await projectAddonsPaths(projectId);
  return {
    project, dirName, major,
    dbName: `test_${dirName}`,
    image: dockerEnv.imageTagFor(major),
    container: dockerEnv.containerNameFor(dirName),
    mounts: dockerEnv.addonsMounts(hostPaths),
    dbArgs: odooDbArgs(),
    envDir: path.join(ENV_BASE, dirName),
  };
}

async function _failEnv(projectId, msg, log) {
  await query(
    "UPDATE odoo_envs SET status='error', error_msg=$2, setup_log=$3, updated_at=NOW() WHERE project_id=$1",
    [projectId, msg, log]
  );
}

// 常駐 Odoo server 的 runtime log 檔路徑（單一慣例，供啟動端寫入與 route 端讀取共用）
function runtimeLogPath(envDir) { return path.join(envDir, 'odoo.log'); }

// 探測埠是否真的接受連線（Odoo 已 listen）。逾時內反覆重試，最終回 true/false。
// 用於啟動後健康檢查：Odoo spawn 後需數秒載入才 listen，唯有實測連得上才算「running」，
// 否則 process 崩了卻標 running（stale running）→ 死掉的 URL 被餵給 E2E 卻永遠好不了。
// 預設 90s 可用 ENV_HEALTH_TIMEOUT_MS 放寬：大量模組首次載入（asset bundle）可能超過 90s 才 listen，
// 被誤殺會標 error 即使其實正要起來
const HEALTH_TIMEOUT_MS = parseInt(process.env.ENV_HEALTH_TIMEOUT_MS || '90000', 10);
function waitForPort(port, timeoutMs = HEALTH_TIMEOUT_MS, intervalMs = 1000, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ port, host });
      sock.setTimeout(2000);
      const fail = () => {
        sock.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, intervalMs);
      };
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', fail);
      sock.once('timeout', fail);
    };
    attempt();
  });
}

// 從 app 的 DATABASE_URL 推導 Odoo DB 連線參數，讓測試機連到同一台 PostgreSQL（否則 Odoo 預設連 localhost:5432 無密碼會失敗）
function odooDbArgs() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return [];
  try {
    const u = new URL(raw);
    const args = [];
    if (u.hostname) args.push('--db_host', u.hostname);
    if (u.port)     args.push('--db_port', u.port);
    if (u.username) args.push('--db_user', decodeURIComponent(u.username));
    if (u.password) args.push('--db_password', decodeURIComponent(u.password));
    return args;
  } catch {
    return [];
  }
}

// tour 的 browser_js 需 chrome 執行檔；Odoo 各平台認固定路徑（odoo/tests/common.py ChromeBrowser.executable）。
// 找不到時 Odoo raise unittest.SkipTest → 測試靜默跳過但 exit 0 ＝假綠燈，故建環境時先擋。
function findChrome() {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LocalAppData || process.env.LOCALAPPDATA || '';
    const bins = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      lad ? path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    ].filter(Boolean);
    return bins.find(b => fs.existsSync(b)) || null;
  }
  for (const b of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(b)) return b;
  }
  return null;
}

// 專案所有已 clone 完成的 repo 路徑，全部掛進 addons-path（primary 優先，不依賴是否勾選 primary）
async function projectAddonsPaths(projectId) {
  const { rows } = await query(
    "SELECT local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [projectId]
  );
  return rows.map(r => r.local_path);
}

// PEP 508 套件名（含 optional extras 與版本限定）。manifest 由 GitHub 拉來的 repo 提供、非可信輸入：
// 不符者一律丟棄，防被污染的 manifest 夾帶 pip 旗標（--index-url=http://evil、-e /path…）做
// argument injection（execFile 無 shell 注入，但畸形項會被 pip 當選項解析＝argv 旗標走私）。
// 名稱＋optional 版本限定；不含 extras（Odoo manifest 的 python 相依是 import 名，無 extras；
// 且 extras 的 ']' 會與清單抽取的 ']' 混淆）。任何含旗標/URL/路徑/空白的畸形項都不符 → 丟棄。
const SAFE_PKG = /^[A-Za-z0-9][A-Za-z0-9._-]*([<>=!~]=?[A-Za-z0-9._*+-]+)?$/;

// 從 __manifest__.py 文字抽出 external_dependencies 的 python 套件清單。
// manifest 是 Python dict literal，用 regex 抓 external_dependencies 內的 'python': [ ... ]（可跨行）。
// 只回傳通過 SAFE_PKG 白名單的項目——會被 pip 當旗標的惡意/畸形項在此就丟棄。
function pythonExternalDeps(manifestText) {
  const s = String(manifestText || '');
  const ext = s.match(/external_dependencies['"]?\s*:\s*\{/);
  if (!ext) return [];
  const py = s.slice(ext.index).match(/['"]python['"]\s*:\s*\[([\s\S]*?)\]/);
  if (!py) return [];
  return [...py[1].matchAll(/['"]([^'"]+)['"]/g)]
    .map(m => m[1].trim())
    .filter(name => SAFE_PKG.test(name));
}

// deploy 前自動補裝自訂模組宣告的 Python 相依。相依宣告有兩處來源，都要涵蓋：
//   (1) <repo>/requirements.txt 與 <repo>/<module>/requirements.txt
//   (2) 各模組 __manifest__.py 的 external_dependencies['python']（Odoo 安裝時實際檢查的權威來源；
//       不少模組如 idx_hj 只在此宣告、無 requirements.txt）
// env 建置只裝 Odoo 核心 requirements → 這兩處宣告的（xlsxtpl、smbprotocol…）安裝時就缺。
// 掃齊逐一 pip install（idempotent，已裝快速略過）。best-effort：裝不動只記錄不中斷，真正缺的相依
// 會讓後續升級以清楚錯誤停下。回傳 log 字串（無可裝則空字串）。
async function installModuleRequirements(projectId, signal) {
  // 把自訂模組宣告的 Python 相依名以 root 在常駐容器內 pip 安裝（image 未內建；requirements.txt 的
  // 精確版本釘定先以套件名安裝、未逐檔 -r，屬 Stage 1 取捨——精確版本釘定為後續強化項）。
  const ctx = await dockerCtxFor(projectId);
  if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) return '';
  const declared = [...await getDeclaredPythonDeps(projectId)].filter(n => SAFE_PKG.test(n));
  if (!declared.length) return '';
  const { code, stdout, stderr } = await dockerEnv.execPipInstall(ctx.container, declared, { signal });
  return `[pip-docker] ${code === 0 ? 'OK' : 'FAIL'} ${declared.join(' ')}\n${String(code === 0 ? stdout : stderr).slice(-200)}\n`;
}

// 蒐集本專案「已宣告」的 Python 相依名（小寫集合），供缺套件時判斷是「真環境缺件」還是「漏宣告」
//（健檢 F6）。來源同 installModuleRequirements：各模組 __manifest__ 的 external_dependencies.python
// ＋各層 requirements.txt 的頂層套件名（去掉版本限定與 extras）。
async function getDeclaredPythonDeps(projectId) {
  const declared = new Set();
  const repos = await projectAddonsPaths(projectId);
  const addName = (raw) => {
    const name = String(raw || '').trim().split(/[<>=!~;\s\[]/)[0].trim().toLowerCase();
    if (name && !name.startsWith('#') && !name.startsWith('-')) declared.add(name);
  };
  const readReq = (file) => {
    try { for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) addName(ln); }
    catch { /* 讀不到就略過 */ }
  };
  for (const repo of repos) {
    const rootReq = path.join(repo, 'requirements.txt');
    if (fs.existsSync(rootReq)) readReq(rootReq);
    let entries = [];
    try { entries = fs.readdirSync(repo, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const modDir = path.join(repo, e.name);
      const req = path.join(modDir, 'requirements.txt');
      if (fs.existsSync(req)) readReq(req);
      const manifest = path.join(modDir, '__manifest__.py');
      if (fs.existsSync(manifest)) {
        try { for (const p of pythonExternalDeps(fs.readFileSync(manifest, 'utf8'))) addName(p); }
        catch { /* 讀不到就略過 */ }
      }
    }
  }
  return declared;
}

// 針對性補裝單一 Python 套件（缺件且已宣告時的自動修復用，健檢 F4）。回傳 { ok, log }。
// 名稱先過 SAFE_PKG 白名單，杜絕 argv 旗標走私；不符者不裝、回 ok:false。
async function installPythonPackage(projectId, pkg, signal) {
  const name = String(pkg || '').trim();
  if (!SAFE_PKG.test(name)) return { ok: false, log: `[pip-fix] SKIP 非法套件名 ${name}\n` };
  const ctx = await dockerCtxFor(projectId);
  if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) return { ok: false, log: '[pip-fix] SKIP 容器未運行\n' };
  const { code, stdout, stderr } = await dockerEnv.execPipInstall(ctx.container, [name], { signal });
  return { ok: code === 0, log: `[pip-fix-docker] ${code === 0 ? 'OK' : 'FAIL'} ${name}\n${String(code === 0 ? stdout : stderr).slice(-200)}\n` };
}

// 同專案 setup 去重：手動建置（env-routes）、deploy（持專案鎖）、E2E（不持鎖）可能同時觸發；
// 並行跑兩個 runEnvSetup 會 spawn 兩個 Odoo 搶同一 port——後者綁失敗、前者 pid 被覆寫成孤兒洩漏。
// 不能在此包 withProjectLock（deploy 已持鎖呼叫，非重入會死鎖），改讓並行呼叫共享同一個 in-flight promise。
const _setupInflight = new Map(); // String(projectId) → Promise

function runEnvSetup(projectId) {
  const key = String(projectId);
  if (_setupInflight.has(key)) return _setupInflight.get(key);
  const p = _runEnvSetup(projectId).finally(() => _setupInflight.delete(key));
  _setupInflight.set(key, p);
  return p;
}

async function _runEnvSetup(projectId) {
  return _runEnvSetupDocker(projectId);
}

// 不重建環境，直接把本系統 users 補進/更新到既有 Odoo 測試區（供獨立「同步使用者」按鈕）
async function syncUsers(projectId) {
  const ctx = await dockerCtxFor(projectId);
  if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) throw new Error('環境尚未建立或容器未運行，請先建立測試環境');
  return _seedOdooUsersDocker(ctx);
}

// 對測試區資料庫執行模組升級（odoo-bin -u）。載入/語法錯會以非 0 結束並 throw，供上層判定退回 coding。
async function upgradeModules(projectId, modules, signal) {
  const modArg = (modules && modules.length ? modules : ['all']).join(',');
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) throw new Error('project not found');
  if (!(await dockerEnv.containerRunning(ctx.container))) throw new Error('測試容器未運行，請先建立/啟動測試環境');
  // 有指定模組給 -i＋-u（新裝＋更新，新模組只 -u 不會裝、Odoo 只印 warning 卻 exit 0＝假成功）；未指定則 -u all。
  const modFlags = (modules && modules.length) ? ['-i', modArg, '-u', modArg] : ['-u', modArg];
  const { code, stdout, stderr } = await dockerEnv.execOdoo({
    container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
    odooArgs: [...modFlags, '--stop-after-init'],
  }, { signal });
  if (code !== 0) { const e = new Error(stderr || stdout || 'docker upgrade failed'); e.stdout = stdout; e.stderr = stderr; throw e; }
  return { ok: true, log: (stdout || '') + (stderr || '') };
}

// E2E via tour：與升級同一條 odoo-bin 指令，加 --test-enable 觸發 tour、--test-tags 只跑本模組測試。
// exit 非 0（tour/斷言失敗或載入錯）在容器內 execOdoo 回非 0、由本函式 throw，供上層依 deploy 同套邏輯分類。
async function runTourTests(projectId, moduleName, signal) {
  if (!moduleName) throw new Error('未指定 module，無法執行 tour 測試');
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) throw new Error('project not found');
  if (!(await dockerEnv.containerRunning(ctx.container))) throw new Error('測試容器未運行，請先建立/啟動測試環境');
  // chromium 已在 image 內；HttpCase 於容器內自起 http server（用 DOCKER_TEST_HTTP_PORT 與常駐 8069 錯開）
  const { code, stdout, stderr } = await dockerEnv.execOdoo({
    container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
    odooArgs: [
      '-i', moduleName, '-u', moduleName, '--stop-after-init',
      '--test-enable', '--test-tags', `/${moduleName}`, '--http-port', String(DOCKER_TEST_HTTP_PORT),
    ],
  }, { signal });
  if (code !== 0) { const e = new Error(stderr || stdout || 'docker tour failed'); e.stdout = stdout; e.stderr = stderr; throw e; }
  return { ok: true, log: (stdout || '') + (stderr || '') };
}

// 刪任務時把該任務的 module 從測試 DB 卸載（odoo-bin shell + button_immediate_uninstall）。
// 回傳結構化結果，不整庫重建、保住人工 QA 資料。呼叫端負責「任務層依存」判斷（同專案別的任務是否也用它）。
//   { result: 'uninstalled' | 'skipped_not_installed' | 'skipped_no_env' | 'skipped_dependents', dependents?: string[] }
// 環境沒建過（容器不存在／未運行）→ module 不可能裝過，回 skipped_no_env。
// shell 非 0 或未回傳 RESULT → throw，由呼叫端 fail-open 捕捉。
async function uninstallModule(projectId, moduleName) {
  if (!moduleName) return { result: 'skipped_not_installed' };
  const ctx = await dockerCtxFor(projectId);
  if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) return { result: 'skipped_no_env' };
  const script = fs.readFileSync(path.join(__dirname, 'uninstall_module.py'), 'utf8');
  const { code, stdout, stderr } = await dockerEnv.execOdoo({
    container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
    odooArgs: ['shell', '--no-http'], interactive: true,
    env: { UNINSTALL_MODULE: moduleName, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  }, { input: script });
  if (code !== 0) throw new Error(`卸載失敗：${(stderr || stdout || '').slice(-300)}`);
  const line = String(stdout).split(/\r?\n/).reverse().find(l => l.startsWith('RESULT:'));
  if (!line) throw new Error(`卸載未回傳結果：${String(stdout).slice(-300)}`);
  const payload = line.slice('RESULT:'.length).trim();
  if (payload === 'uninstalled') return { result: 'uninstalled' };
  if (payload === 'skipped_not_installed') return { result: 'skipped_not_installed' };
  if (payload.startsWith('skipped_dependents:')) {
    return { result: 'skipped_dependents', dependents: payload.slice('skipped_dependents:'.length).split(',').map(s => s.trim()).filter(Boolean) };
  }
  throw new Error(`卸載回傳未知結果：${payload}`);
}

async function stopEnv(projectId) {
  // VPN 共管：測試區停 → 一併收掉該專案的 VPN 容器（只停不刪、永不擋停機流程）。
  await stopProjectVpns(projectId).catch(() => {});
  const ctx = await dockerCtxFor(projectId);
  if (ctx) { await dockerEnv.stopContainer(ctx.container); await dockerEnv.removeContainer(ctx.container); }
  await query(
    "UPDATE odoo_envs SET status='idle', pid=NULL, pid_started_at=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
    [projectId]
  );
}

async function nightlyShutdown() {
  const { rows } = await query("SELECT project_id, pid, pid_started_at FROM odoo_envs WHERE status='running'");
  for (const env of rows) {
    // 跳過使用中的 env：該專案有任務正在 deploy_testing／playwright_running，
    // 砍了會讓 deploy/E2E 中途死掉被誤歸因為程式問題（健檢：夜間 shutdown 誤歸因）
    const { rows: [busy] } = await query(
      "SELECT 1 FROM tasks WHERE project_id=$1 AND status IN ('deploy_testing','playwright_running') AND is_paused=false AND is_hidden=false LIMIT 1",
      [env.project_id]
    );
    if (busy) continue;
    // VPN 共管：夜間關機時一併收掉該專案 VPN（同 stopEnv 語意，只停不刪、不擋流程）。
    await stopProjectVpns(env.project_id).catch(() => {});
    const ctx = await dockerCtxFor(env.project_id);
    if (ctx) { await dockerEnv.stopContainer(ctx.container); await dockerEnv.removeContainer(ctx.container); }
    await query(
      "UPDATE odoo_envs SET status='idle', pid=NULL, pid_started_at=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
      [env.project_id]
    );
  }
}

// 該專案是否有「使用中」的測試環境：建立中／運行中，或容器仍在／已建置完成（.docker-ready 仍在）。
// 用於防呆：環境使用中時不得移除其掛載的 repo。
async function envIsActive(projectId) {
  const { rows: [env] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (env && (env.status === 'setting_up' || env.status === 'running')) return true;
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [projectId]);
  if (!project) return false;
  const dirName = project.folder_name || project.name;
  const ctx = await dockerCtxFor(projectId);
  if (ctx && await dockerEnv.containerExists(ctx.container)) return true;
  return fs.existsSync(path.join(ENV_BASE, dirName, '.docker-ready'));
}

// 刪除專案前的連帶清理：kill 環境 process、移除 env 與各 repo clone 目錄。
// DB row（odoo_envs / project_repos）由 FK cascade 處理，此處只負責檔案與程序。
async function cleanupProjectEnv(projectId) {
  try { await stopEnv(projectId); } catch {}
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [projectId]);
  if (project) {
    const dirName = project.folder_name || project.name;
    const envDir = path.join(ENV_BASE, dirName);
    const resolved = path.resolve(envDir);
    if (resolved.startsWith(path.resolve(ENV_BASE) + path.sep) && fs.existsSync(envDir)) {
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    }
  }
  const { rows: repos } = await query('SELECT local_path FROM project_repos WHERE project_id=$1', [projectId]);
  for (const r of repos) {
    if (r.local_path && fs.existsSync(r.local_path)) {
      try { fs.rmSync(r.local_path, { recursive: true, force: true }); } catch {}
    }
  }
}

// ================= 測試區生命週期（docker 容器） =================
// 所有 docker 參數組裝在 lib/docker-env.js（純函式、已單測）；此處只做「查 DB／落狀態／串起 docker 呼叫」。

// 建置＋啟動：build image → 起常駐容器（首次帶 -i base 裝底）→ 健康檢查 → 補相依 → seed。
async function _runEnvSetupDocker(projectId) {
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) return;
  let port = ctx.project.port;
  if (!port) { port = await allocateProjectPort(); await query('UPDATE projects SET port=$2 WHERE id=$1', [projectId, port]); }
  const envHost = loopbackHostForPort(port);
  fs.mkdirSync(ctx.envDir, { recursive: true });
  const readyMarker = path.join(ctx.envDir, '.docker-ready');
  // filestore 綁到宿主持久目錄（與 DB 同樣持久），避免容器 rm+run 重建後 attachment 檔遺失、asset 500。
  const filestoreDir = path.join(ctx.envDir, 'filestore');
  fs.mkdirSync(filestoreDir, { recursive: true });

  await query(
    `INSERT INTO odoo_envs (project_id, status, port, updated_at) VALUES ($1,'setting_up',$2,NOW())
     ON CONFLICT (project_id) DO UPDATE SET status='setting_up', error_msg=NULL, setup_log=NULL, port=$2, updated_at=NOW()`,
    [projectId, port]
  );

  for (const m of ctx.mounts) { try { await ensureTestingBranch(m.host); } catch { /* 非致命 */ } }

  let log = `[docker] mode=docker image=${ctx.image} container=${ctx.container} port=${port}\n`;
  const firstBuild = !fs.existsSync(readyMarker);

  // 0) 確保 Docker daemon 在跑（Windows 自動啟動 Docker Desktop 並等待就緒）。
  // 沒這道 preflight，daemon 沒起時會直接落到 build 拿到一串 npipe 連線亂碼、誤報「image build 失敗」。
  try {
    await dockerEnv.ensureDockerRunning();
  } catch (e) {
    return _failEnv(projectId, 'Docker 引擎未啟動或啟動逾時，請確認 Docker Desktop', log + `[docker] ${e.message}\n`);
  }

  // 1) 確保平台 image（odoo:<major> + chromium）；首次 build 較久
  const img = await dockerEnv.ensureImage(ctx.major, DOCKER_CTX_DIR);
  log += img.log;
  if (!img.ok) return _failEnv(projectId, 'docker image build 失敗', log);

  // 2) 移除同名舊容器（冪等）→ 起常駐容器（首次帶 init 旗標，Odoo 裝完 base 續跑 server）
  await dockerEnv.removeContainer(ctx.container);
  const initArgs = firstBuild ? ['-i', 'base', '--without-demo=all', '--load-language=zh_TW'] : [];
  const run = await dockerEnv.runContainer({
    name: ctx.container, image: ctx.image, host: envHost, port, dbName: ctx.dbName,
    dbArgs: ctx.dbArgs, mounts: ctx.mounts, serverArgs: initArgs, filestoreDir,
  });
  log += `[docker] run ${run.ok ? 'OK' : 'FAIL'}\n${run.log.slice(-300)}\n`;
  if (!run.ok) return _failEnv(projectId, `docker run 失敗：${(run.stderr || '').slice(-200)}`, log);

  // 3) 健康檢查：容器發佈在 envHost（127.0.0.x，每專案獨立 loopback host），故探 envHost 而非
  // 127.0.0.1（docker -p 只綁 envHost，探 127.0.0.1 會永遠連不到、卡建立中）。首次含 base 安裝，放寬逾時。
  const healthy = await waitForPort(port, firstBuild ? Math.max(HEALTH_TIMEOUT_MS, 300000) : HEALTH_TIMEOUT_MS, 1000, envHost);
  if (!healthy) {
    log += `[docker] 健康檢查失敗，容器 log：\n${await dockerEnv.containerLogs(ctx.container).catch(() => '')}`;
    await dockerEnv.removeContainer(ctx.container);
    return _failEnv(projectId, `Odoo 容器啟動逾時：埠 ${port} 未進入監聽`, log);
  }
  if (firstBuild) { try { fs.writeFileSync(readyMarker, new Date().toISOString()); } catch { /* 非致命 */ } }

  // 4) 補裝自訂模組 Python 相依（image 未內建）＋ seed users
  try { log += await installModuleRequirements(projectId); } catch (e) { log += `[deps] FAIL ${e.message}\n`; }
  try { log += await _seedOdooUsersDocker(ctx); } catch (e) { log += `[seed] FAIL ${e.message}\n`; }

  await query(
    "UPDATE odoo_envs SET status='running', pid=NULL, pid_started_at=NULL, port=$2, url=$3, setup_log=$4, updated_at=NOW() WHERE project_id=$1",
    [projectId, port, `http://${envHost}:${port}`, log]
  );

  // VPN 共管：測試區進入 running 後背景暖機該專案所有 vpn 連線（fire-and-forget，不 await；
  // 撥號慢[≤25s/條]不該延後測試區可用時間，查詢時的 lazy ensureGatewayRunning 會冪等補等）。
  startProjectVpns(projectId).catch(() => {});
}

// seed users（docker）：odoo shell + stdin 腳本，users 經 SEED_USERS env 傳入（同 venv 契約）。
async function _seedOdooUsersDocker(ctx) {
  const { rows: users } = await query(
    'SELECT username AS login, display_name AS name, password_hash AS password FROM users ORDER BY id'
  );
  users.push({ login: E2E_LOGIN, name: 'E2E 自動測試', password_plain: E2E_PASSWORD });
  const script = fs.readFileSync(path.join(__dirname, 'seed_odoo_users.py'), 'utf8');
  const { code, stdout, stderr } = await dockerEnv.execOdoo({
    container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
    odooArgs: ['shell', '--no-http'], interactive: true,
    env: { SEED_USERS: JSON.stringify(users), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  }, { input: script });
  if (code !== 0) throw new Error((stderr || stdout || '').slice(-300));
  return `[seed] ${users.length} users → ${String(stdout).trim().slice(-200)}\n`;
}

module.exports = { runEnvSetup, upgradeModules, installModuleRequirements, getDeclaredPythonDeps, installPythonPackage, pythonExternalDeps, runTourTests, uninstallModule, findChrome, stopEnv, syncUsers, nightlyShutdown, envIsActive, cleanupProjectEnv, waitForPort, ENV_BASE, runtimeLogPath, dockerCtxFor };
