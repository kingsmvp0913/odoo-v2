const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../db');
const { ensureTestingBranch } = require('./git');
const { E2E_LOGIN } = require('./e2e-account');
const { leasePort, envBindHost, envPublicUrl } = require('../port-alloc');
const { startProjectVpns, stopProjectVpns } = require('../lib/project-vpn');
const { syncNginxMapDebounced } = require('../lib/nginx-map');
const { resolveEnterprisePath } = require('../lib/enterprise-sources');

// 測試環境一律建在專案內 odoo-v2/odoo-envs（比照 REPOS_BASE 慣例），不得跑到專案外
const ENV_BASE = process.env.ODOO_ENV_BASE || path.resolve(__dirname, '..', '..', '..', 'odoo-envs');

// repo clone 根（與 project-routes.js 同一個定義）。只用於 cleanupProjectEnv 刪除專案根目錄前的
// 範圍檢查——pipeline 不得 require route 檔（會連帶要求 JWT_SECRET 才能載入），故在此各自宣告。
const REPOS_BASE = process.env.REPOS_BASE_DIR || path.resolve(__dirname, '..', '..', '..', 'repos');

// 測試區一律建在官方 odoo:<major> image 的容器上，徹底避開宿主多版本 Python／gevent 編譯，
// 自動涵蓋 odoo 13→未來 20+（唯一建置模式；舊的宿主 venv 模式已移除）。
const dockerEnv = require('../lib/docker-env');
const DOCKER_CTX_DIR = path.resolve(__dirname, '..', '..', 'docker'); // app/docker（含 Dockerfile.odoo）
// 容器內 tour（HttpCase）自起的 http 埠：與常駐 server 的 8069 錯開（exec 與 server 共用容器網路）。
const DOCKER_TEST_HTTP_PORT = 8169;

// 組某專案的 docker 操作上下文（容器名、image、DB、addons 掛載、db 連線參數、env 目錄）。
async function dockerCtxFor(projectId) {
  const { rows: [project] } = await query(
    `SELECT p.name, p.folder_name, p.odoo_version, p.edition, e.port
       FROM projects p LEFT JOIN odoo_envs e ON e.project_id = p.id
      WHERE p.id=$1`, [projectId]
  );
  if (!project) return null;
  const dirName = project.folder_name || project.name;
  const major = (project.odoo_version || '17.0').split('.')[0];
  const hostPaths = await projectAddonsPaths(projectId);
  const mounts = dockerEnv.addonsMounts(hostPaths);
  // 企業版：把該大版本的 enterprise addons 以唯讀掛入，且排在專案 repos「之後」、核心「之前」——
  // 順序即覆蓋權（專案自訂可蓋 enterprise，enterprise 的 web_enterprise 要能蓋核心 web）。
  // 解析不到來源時不掛、改記 enterpriseError，由 setup 據此 fail loud（不可默默跑成社群版）。
  let enterpriseError = null;
  if (project.edition === 'enterprise') {
    const ent = await resolveEnterprisePath(project.odoo_version);
    if (ent.ok) mounts.push({ host: ent.path, container: dockerEnv.ENTERPRISE_CONTAINER_DIR, enterprise: true });
    else enterpriseError = ent.error;
  }
  return {
    project, dirName, major, enterpriseError,
    dbName: `test_${dirName}`,
    image: dockerEnv.imageTagFor(major),
    container: dockerEnv.containerNameFor(dirName),
    mounts,
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

// waitForPort 只證明「TCP 埠已綁上」，但 Odoo 的 ThreadedServer 是「先 start() 綁 http port、再
// preload_registries() 跑 -i 安裝」——base 尚未裝完埠就已在監聽，純 TCP 探測會提早放行。seed 是另一個
// odoo shell 進程、從 DB 重載自己的 registry，若此時 base 還沒 commit 進 DB，seed 會拿到半成品 registry
// → env['res.users'] KeyError，隨後移除容器又連帶中止安裝（DB 只剩最早的 orm_signaling_* 表）。有 pip
// 相依的專案因 installModuleRequirements 的耗時剛好遮住這個 race；純 base 專案沒有這段延遲必中。
// 故在 seed 前補一道「DB 裡 -i 的模組真的 installed」的就緒閘。連的是測試 DB（test_<dirName>，與平台 DB
// 同台 postgres、不同 database），故另建連線；DATABASE_URL 未設時無從查→放行(fail-open)。deps.createClient
// 供單元測試注入假 client。回 true=就緒、false=逾時未就緒。
async function waitForModulesInstalled({ dbName, modules, timeoutMs = HEALTH_TIMEOUT_MS, intervalMs = 1000 }, deps = {}) {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) return true; // 無連線資訊，無從把關 → 放行（單元測試以 deps.createClient 覆蓋此路徑）
  const createClient = deps.createClient || (() => {
    const { Client } = require('pg');
    const u = new URL(rawUrl);
    u.pathname = '/' + dbName;
    return new Client({ connectionString: u.toString() });
  });
  const want = modules.length;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let installed = -1;
    const client = createClient();
    try {
      await client.connect();
      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM ir_module_module WHERE name = ANY($1) AND state = 'installed'",
        [modules]
      );
      installed = rows[0] ? rows[0].n : 0;
    } catch {
      // 新 DB 在 base 建表前查 ir_module_module 會 42P01（relation 不存在），或連線瞬間未就緒 → 視為未就緒續等
      installed = -1;
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
    if (installed >= want) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// 測試注入用：讓全流程測試在不連真 DB 下確定性地控制就緒閘（比照 db.js 的 _setPoolForTesting）。
let _moduleReadyCheck = null;
function _setModuleReadyCheckForTesting(fn) { _moduleReadyCheck = fn; }

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

// 全平台所有專案宣告的 Python 相依聯集（供 image 預裝，見 docker-env.ensureImage）。
// 刻意「不分專案」：實測聯集只有十來個且幾乎全來自同一個專案，分專案建 image 一個都沒省到，
// 只會讓 image 數量變成「專案數 × 版本數」（每個 3GB+）。版本釘定與 installModuleRequirements
// 同一取捨（只裝套件名），故聯集不會比現況更容易撞版本。
async function getAllDeclaredPythonDeps() {
  const { rows } = await query(
    "SELECT DISTINCT project_id FROM project_repos WHERE clone_status='done' AND local_path IS NOT NULL"
  );
  const all = new Set();
  for (const r of rows) {
    for (const name of await getDeclaredPythonDeps(r.project_id)) {
      if (SAFE_PKG.test(name)) all.add(name);
    }
  }
  return [...all].sort();
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

// 把 docker exec 的結果包成 Error，並帶齊 deploy／E2E 判定失敗歸屬時要看的四個欄位。
// exitCode／killed 不是裝飾品，是兩道守衛的唯一輸入：
//   - deploy-testing.looksLikeInfraDeath 用 exitCode 判「進程猝死（非常規退出碼）且 log 無 Odoo
//     錯誤」＝infra／資源層死亡，退 coding 無用（107 事故）；
//   - deploy-testing／playwright-agent 用 killed 判「我方逾時砍掉」＝重試只會再 hang 一次，直接
//     停等人工（健檢 F8）。
// docker 化時漏帶這兩欄，兩道守衛在 undefined 上恆為 false ＝整組死碼，逾時／猝死會一路走到
// haiku 分類器被瞎猜成 code 而誤退開發。
function _execError(message, { code, timedOut, stdout, stderr }) {
  const e = new Error(message);
  e.stdout = stdout;
  e.stderr = stderr;
  e.exitCode = code;          // docker exec 轉傳容器內指令的退出碼；逾時被砍時為 null
  e.killed = !!timedOut;      // 只有「我方 timeout kill」算 killed（見 docker-env.runDocker）
  return e;
}

// 對測試區資料庫執行模組升級（odoo-bin -u）。載入/語法錯會以非 0 結束並 throw，供上層判定退回 coding。
async function upgradeModules(projectId, modules, signal) {
  const modArg = (modules && modules.length ? modules : ['all']).join(',');
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) throw new Error('project not found');
  // 建置成功「之後」企業版來源才失效（來源列被刪／目錄被清）時，ctx.mounts 會缺 /mnt/enterprise，
  // 這裡先擋掉、報明確的版本錯誤，避免以「模組相依缺失」的面貌出現而被誤判成 code 問題退回 coding。
  if (ctx.enterpriseError) throw new Error(ctx.enterpriseError);
  if (!(await dockerEnv.containerRunning(ctx.container))) throw new Error('測試容器未運行，請先建立/啟動測試環境');
  // 有指定模組給 -i＋-u（新裝＋更新，新模組只 -u 不會裝、Odoo 只印 warning 卻 exit 0＝假成功）；未指定則 -u all。
  const modFlags = (modules && modules.length) ? ['-i', modArg, '-u', modArg] : ['-u', modArg];
  const { code, timedOut, stdout, stderr } = await dockerEnv.execOdoo({
    container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
    odooArgs: [...modFlags, '--stop-after-init'],
  }, { signal });
  if (code !== 0) { throw _execError(stderr || stdout || 'docker upgrade failed', { code, timedOut, stdout, stderr }); }
  return { ok: true, log: (stdout || '') + (stderr || '') };
}

// 重啟常駐測試容器，讓「進程啟動時才 import」的東西重載——升級走 docker exec 一次性進程(--stop-after-init)
// 只改了 DB，常駐 server(綁 8069 那個)仍持舊的 registry 與 Python controllers；新增/改動的 controller(HTTP
// 路由)不重啟不生效，使用者開測試區報錯需手動重啟。restart 以原 CMD 重跑，重新 import 所有已裝模組的
// controllers 並 reload registry。等埠重新監聽才回；容器未運行→跳過（無常駐 server 可重啟，下次開測試區走建置）。
async function restartEnv(projectId) {
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) throw new Error('project not found');
  if (!(await dockerEnv.containerRunning(ctx.container))) return { ok: false, skipped: 'not_running' };
  await dockerEnv.restartContainer(ctx.container);
  const port = ctx.project.port;
  const envHost = envBindHost(port);
  if (!await waitForPort(port, HEALTH_TIMEOUT_MS, 1000, envHost)) {
    throw new Error(`測試環境重啟後埠 ${port} 未進入監聽`);
  }
  return { ok: true };
}

// E2E via tour：與升級同一條 odoo-bin 指令，加 --test-enable 觸發 tour、--test-tags 只跑本模組測試。
// exit 非 0（tour/斷言失敗或載入錯）在容器內 execOdoo 回非 0、由本函式 throw，供上層依 deploy 同套邏輯分類。
async function runTourTests(projectId, moduleName, signal) {
  if (!moduleName) throw new Error('未指定 module，無法執行 tour 測試');
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) throw new Error('project not found');
  // 同 upgradeModules：企業版來源在建置成功之後失效時，先擋、報明確版本錯誤，
  // 避免以「模組相依缺失」的面貌出現而被誤判成 code 問題退回 coding。
  if (ctx.enterpriseError) throw new Error(ctx.enterpriseError);
  if (!(await dockerEnv.containerRunning(ctx.container))) throw new Error('測試容器未運行，請先建立/啟動測試環境');
  // chromium 已在 image 內；HttpCase 於容器內自起 http server（用 DOCKER_TEST_HTTP_PORT 與常駐 8069 錯開）
  const { code, timedOut, stdout, stderr } = await dockerEnv.execOdoo({
    container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
    odooArgs: [
      '-i', moduleName, '-u', moduleName, '--stop-after-init',
      '--test-enable', '--test-tags', `/${moduleName}`, '--http-port', String(DOCKER_TEST_HTTP_PORT),
    ],
  }, { signal });
  if (code !== 0) { throw _execError(stderr || stdout || 'docker tour failed', { code, timedOut, stdout, stderr }); }
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
  // 同 upgradeModules：企業版來源在建置成功之後失效時先擋、報明確版本錯誤。呼叫端
  // （tasks-routes.uninstallTaskModule）本就 best-effort catch 任何 throw 轉成警告字串、不擋刪除，
  // 故沿用既有 throw 風格而非再多加一個 skipped_* 分支。
  if (ctx.enterpriseError) throw new Error(ctx.enterpriseError);
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
    "UPDATE odoo_envs SET status='idle', pid=NULL, pid_started_at=NULL, url=NULL, port=NULL, external_slot=NULL, updated_at=NOW() WHERE project_id=$1",
    [projectId]
  );
  // 停機後 conf 內那段仍指著已被移除的容器（舊分頁重整會拿到 502）。走防抖版：
  // 夜間關機／批次回收會連續呼叫，逐一 reload 等於連續打擾共用 nginx 上的正式站。
  syncNginxMapDebounced().catch(() => {});
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
      "UPDATE odoo_envs SET status='idle', pid=NULL, pid_started_at=NULL, url=NULL, port=NULL, external_slot=NULL, updated_at=NOW() WHERE project_id=$1",
      [env.project_id]
    );
  }
  // 停機後 conf 內那段仍指著已被移除的容器（舊分頁重整會拿到 502）。走防抖版：
  // 夜間關機／批次回收會連續呼叫，逐一 reload 等於連續打擾共用 nginx 上的正式站。
  syncNginxMapDebounced().catch(() => {});
}

// 閒置回收：port 池能用一小段埠支撐大量專案的前提。每輪做兩件事——
//   1. 從容器 log 更新 last_active_at（真實 HTTP 請求才算；輪詢類不算，見 lib/env-activity）
//   2. 閒置逾時或壽命逾時的環境停機並歸還租約
// 門檻刻意比「池滿徵收」（ENV_IDLE_TIMEOUT_PRESSURE_MIN，預設 15 分）寬鬆：沒人在等就別打擾使用者。
// 壽命上限是保底——輪詢類請求若有漏擋，環境會永遠不閒置，靠這條收掉。
const IDLE_TIMEOUT_MIN = parseInt(process.env.ENV_IDLE_TIMEOUT_MIN || '60', 10);
const MAX_LIFETIME_HOURS = parseInt(process.env.ENV_MAX_LIFETIME_HOURS || '8', 10);

async function sweepIdleEnvs(deps = {}) {
  const idleMin = deps.idleMin ?? IDLE_TIMEOUT_MIN;
  const maxHours = deps.maxHours ?? MAX_LIFETIME_HOURS;
  const { idleMinutes, releaseExternalSlot } = require('../lib/external-slot');
  const externalIdleMin = deps.externalIdleMin ?? idleMinutes();
  const { parseLastActivity } = require('../lib/env-activity');
  const { rows } = await query("SELECT project_id FROM odoo_envs WHERE status='running'");
  let updated = 0, stopped = 0, slotsReleased = 0;

  for (const { project_id: projectId } of rows) {
    // 使用中的專案完全不碰（同 nightlyShutdown 的鐵則）：砍了會讓 deploy/E2E 中途死掉被誤歸因
    const { rows: [busy] } = await query(
      "SELECT 1 FROM tasks WHERE project_id=$1 AND status IN ('deploy_testing','playwright_running') AND is_paused=false AND is_hidden=false LIMIT 1",
      [projectId]
    );
    if (busy) continue;

    // 抓 log 失敗（容器沒了／docker 暫時不通）不得中斷整輪——一個壞環境不該讓所有環境都收不掉
    try {
      const ctx = await dockerCtxFor(projectId);
      if (ctx) {
        const logText = await dockerEnv.containerLogs(ctx.container, { tail: 500 });
        const at = parseLastActivity(logText);
        if (at) {
          // 只准往前，不准往回撥：借對外名額時會把 last_active_at 推到現在（「有人要看」的證據），
          // 而 log 反映的是「上一次真的有請求」，在剛借完、瀏覽器還沒發第一個請求的空窗裡必然較舊。
          // 無條件覆寫等於把時間倒退，下面的對外回收就會把剛借出的名額立刻收走。
          // 用 WHERE 擋而非 GREATEST：pg-mem 不支援 GREATEST，會靜默回 NULL 把欄位清掉。
          await query(
            `UPDATE odoo_envs SET last_active_at=$2::timestamptz
              WHERE project_id=$1 AND (last_active_at IS NULL OR last_active_at < $2::timestamptz)`,
            [projectId, at.toISOString()]
          );
          updated++;
        }
      }
    } catch { /* 抓不到活動時間就沿用既有值，交由下方逾時判定 */ }

    const { rows: [expired] } = await query(
      `SELECT 1 FROM odoo_envs
        WHERE project_id=$1
          AND ( COALESCE(last_active_at, updated_at) < NOW() - ($2 || ' minutes')::interval
             OR created_at < NOW() - ($3 || ' hours')::interval )`,
      [projectId, String(idleMin), String(maxHours)]
    );
    if (expired) { await stopEnv(projectId); stopped++; }
  }

  // 對外名額回收。必須排在主迴圈「之後」——主迴圈才剛從容器 log 把 last_active_at 更新到最新，
  // 排在前面會拿上一輪的舊值判定，剛借出的名額會被立刻收走。
  //
  // 與環境去留分開判定：pipeline 可能還要用這個環境（不能停），但沒人在看就該把名額還回去。
  // 已被主迴圈停掉的環境其 external_slot 已由 stopEnv 清空，不會重複處理。
  const { rows: staleSlots } = await query(
    `SELECT project_id FROM odoo_envs
      WHERE external_slot IS NOT NULL
        AND COALESCE(last_active_at, updated_at) < NOW() - ($1 || ' minutes')::interval`,
    [String(externalIdleMin)]
  );
  for (const { project_id: pid } of staleSlots) {
    await releaseExternalSlot(pid);
    slotsReleased++;
    console.log(`[env-sweep] 專案 ${pid} 對外閒置逾 ${externalIdleMin} 分，歸還檢視名額（環境不停）`);
  }
  if (slotsReleased) syncNginxMapDebounced().catch(() => {});

  return { updated, stopped, slotsReleased };
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
// 專案硬刪除的清理必須分兩段，因為 project_repos／odoo_envs 對 projects 都是 ON DELETE CASCADE：
// 刪除端點的 DB 交易一 COMMIT，這裡要查的列就全被 cascade 帶走，之後再查等於查空 →
// 整個清理變成完整 no-op（目錄與容器全留在磁碟上，而且沒有任何路徑會再回收它們）。
// 所以呼叫端必須在交易「之前」先取得這份路徑快照，交易「之後」才帶著它來刪檔——
// 不可逆的刪檔仍排在最後，但不再依賴已經消失的 DB 列。
async function snapshotProjectPaths(projectId) {
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [projectId]);
  const { rows: repos } = await query('SELECT local_path FROM project_repos WHERE project_id=$1', [projectId]);
  return {
    dirName: project ? (project.folder_name || project.name) : null,
    repoPaths: repos.map(r => r.local_path).filter(Boolean),
  };
}

// snapshot 省略時自行查（給「專案列還在」的呼叫端用）；硬刪除路徑必須傳入交易前取好的快照。
async function cleanupProjectEnv(projectId, snapshot = null) {
  try { await stopEnv(projectId); } catch {}
  const snap = snapshot || await snapshotProjectPaths(projectId);
  if (snap.dirName) {
    const dirName = snap.dirName;
    const envDir = path.join(ENV_BASE, dirName);
    const resolved = path.resolve(envDir);
    if (resolved.startsWith(path.resolve(ENV_BASE) + path.sep) && fs.existsSync(envDir)) {
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
    }
  }
  const repos = snap.repoPaths.map(local_path => ({ local_path }));
  // 各 repo clone 與所有任務 worktree 同住一個「專案根」：clone 是 <REPOS_BASE>/<專案目錄>/<label>、
  // coding／QA 的工作樹是 <專案根>/.worktrees/<task_id>/<label>（見 pipeline/task-agent.js
  // worktreeParent）。只逐一刪 local_path 會把整棵 .worktrees 與專案根目錄留在磁碟上——那才是
  // 佔空間的大宗（每張任務一份完整工作樹），而且專案已經不存在，沒有任何路徑會再回收它們。
  const roots = new Set();
  for (const r of repos) {
    if (!r.local_path) continue;
    const root = path.dirname(path.resolve(r.local_path));
    // 往上刪一層比刪 local_path 本身危險：local_path 是 DB 內容，被寫壞時 dirname 可能指到磁碟根。
    // 只有確定落在 REPOS_BASE 底下才敢整個專案根刪掉，否則退回原本的「只刪這個 repo 目錄」。
    if (root.startsWith(path.resolve(REPOS_BASE) + path.sep)) roots.add(root);
    else if (fs.existsSync(r.local_path)) {
      try { fs.rmSync(r.local_path, { recursive: true, force: true }); } catch {}
    }
  }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

// ================= 測試區生命週期（docker 容器） =================
// 所有 docker 參數組裝在 lib/docker-env.js（純函式、已單測）；此處只做「查 DB／落狀態／串起 docker 呼叫」。

// 探測測試區的 SSO 免密登入 route 是否不存在（true ＝ 404 ＝ idx_aidev_sso 沒安裝成功）。
// 判定只認 404：不帶 token 時 controller 回 403（bad token）、secret 未設時回 503，這些都代表
// controller 已經載入了。反過來只認 403 會把 503 誤判成沒安裝，白重啟一輪還掩蓋真正的 secret 問題。
// 連不上／逾時一律回 false（不做判定）：健檢剛過，此時連不上另有原因，不該由本函式定調成模組問題。
function _ssoRouteMissing(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/aidev/sso', timeout: timeoutMs }, (res) => {
      res.resume(); // 不排掉 body 的話 socket 不會釋放，這個 Promise 之後的流程會拖著一個 handle
      resolve(res.statusCode === 404);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// 建置＋啟動：build image → 起常駐容器（首次帶 -i base 裝底）→ 健康檢查 → 補相依 → seed。
async function _runEnvSetupDocker(projectId) {
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) return;
  // 企業版缺件一律 fail loud：靜默降級成社群版會讓人以為在測企業版，而且毫無跡象。
  // 擺在借埠之前——建不起來的環境不該先白佔一個併發槽。
  if (ctx.enterpriseError) {
    await query(
      `INSERT INTO odoo_envs (project_id, status, error_msg, setup_log, updated_at)
       VALUES ($1,'error',$2,$3,NOW())
       ON CONFLICT (project_id) DO UPDATE SET status='error', error_msg=$2, setup_log=$3, updated_at=NOW()`,
      [projectId, ctx.enterpriseError, `[docker] ${ctx.enterpriseError}\n`]
    );
    return;
  }
  // 租約：沿用現有租約（重跑 setup 時容器會 rm+run，埠不變即可重用），沒有才借新的。
  // 池滿時注入 reclaim 徵收一個閒置夠久的測試區讓位——deploy／E2E 與人工建置走同一套規則。
  let port = ctx.project.port;
  if (!port) {
    // odoo_envs 列必須先存在才寫得進租約（首次建置時尚無此列）
    await query(
      "INSERT INTO odoo_envs (project_id, status, updated_at) VALUES ($1,'setting_up',NOW()) ON CONFLICT (project_id) DO NOTHING",
      [projectId]
    );
    port = await leasePort(projectId, { reclaim: (victimId) => stopEnv(victimId) });
  }
  const envHost = envBindHost(port);
  fs.mkdirSync(ctx.envDir, { recursive: true });
  const readyMarker = path.join(ctx.envDir, '.docker-ready');
  // filestore 綁到宿主持久目錄（與 DB 同樣持久），避免容器 rm+run 重建後 attachment 檔遺失、asset 500。
  // 權限必須放寬到人人可寫：官方 odoo image 內的 odoo 是 uid 101，與建立此目錄的宿主 uid 不同，
  // 預設 0755 會讓容器寫不進去——症狀是裝 base 時 PermissionError 包成 res_lang_data.xml 的
  // ParseError，完全指不向權限。chmod 另下一次：mkdir 的 mode 會被 umask 削掉。
  const filestoreDir = path.join(ctx.envDir, 'filestore');
  fs.mkdirSync(filestoreDir, { recursive: true });
  fs.chmodSync(filestoreDir, 0o777);

  await query(
    `INSERT INTO odoo_envs (project_id, status, port, updated_at) VALUES ($1,'setting_up',$2,NOW())
     ON CONFLICT (project_id) DO UPDATE SET status='setting_up', error_msg=NULL, setup_log=NULL, port=$2, updated_at=NOW()`,
    [projectId, port]
  );

  // 每環境隨機憑證：SSO 簽章 secret（給 mintSsoToken 與 seed 寫 config param）＋ E2E 隨機密碼（給 seed
  // 與 playwright 登入）。每次建置換新，掛到 ctx 供下方 seed 使用。
  const creds = await _ensureEnvCredentials(projectId);
  ctx.ssoSecret = creds.ssoSecret;
  ctx.e2ePassword = creds.e2ePassword;

  // enterprise 是唯讀共用來源、不屬於任何專案的 repo，不得開／切 testing 分支
  for (const m of ctx.mounts) {
    if (m.enterprise) continue;
    try { await ensureTestingBranch(m.host); } catch { /* 非致命 */ }
  }

  let log = `[docker] mode=docker image=${ctx.image} container=${ctx.container} port=${port}\n`;
  const firstBuild = !fs.existsSync(readyMarker);

  // 0) 確保 Docker daemon 在跑（Windows 自動啟動 Docker Desktop 並等待就緒）。
  // 沒這道 preflight，daemon 沒起時會直接落到 build 拿到一串 npipe 連線亂碼、誤報「image build 失敗」。
  try {
    await dockerEnv.ensureDockerRunning();
  } catch (e) {
    return _failEnv(projectId, 'Docker 引擎未啟動或啟動逾時，請確認 Docker Desktop', log + `[docker] ${e.message}\n`);
  }

  // 1) 確保平台 image（odoo:<major> + chromium + 預裝的 Python 相依）；首次 build 較久。
  // 相依必須內建在 image：容器層 pip 裝的東西容器一被 rm（夜間關機／閒置回收）就全滅，而 DB 裡
  // 那些模組仍是已安裝 → 重建時常駐進程一啟動就 ModuleNotFoundError → registry 載入失敗。
  const img = await dockerEnv.ensureImage(ctx.major, DOCKER_CTX_DIR, { pipPkgs: await getAllDeclaredPythonDeps() });
  log += img.log;
  if (!img.ok) return _failEnv(projectId, 'docker image build 失敗', log);

  // 2) 移除同名舊容器（冪等）→ 起常駐容器（首次帶 init 旗標，Odoo 裝完 base 續跑 server）
  await dockerEnv.removeContainer(ctx.container);
  // idx_aidev_sso 一律由「常駐 server 進程自己」以 -i 裝：Odoo 的 HTTP 路由是進程啟動時 import
  // 已安裝模組的 controllers 建立的，用 docker exec 另起進程裝只會把模組寫進 DB，常駐進程從沒
  // import 過該模組的 controllers → /aidev/sso 回 404（Odoo 找不到頁面），要重啟容器才會出現。
  // -i 對已安裝模組 idempotent，故非首次也帶。
  const initArgs = firstBuild
    ? ['-i', 'base,idx_aidev_sso', '--without-demo=all', '--load-language=zh_TW']
    : ['-i', 'idx_aidev_sso'];
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
  // 埠通了不等於 registry 就緒：Odoo 綁 port 早於 preload_registries 跑完 -i 安裝（見 waitForModulesInstalled
  // 註解）。seed 是獨立 odoo shell、從 DB 重載 registry，base 沒裝完就會 KeyError res.users。故在此把關：
  // DB 裡 -i 的模組真的 installed 才放行；未就緒即中止且不寫 .docker-ready，讓下次仍以 firstBuild 重跑 -i base 自癒。
  const wantModules = firstBuild ? ['base', 'idx_aidev_sso'] : ['idx_aidev_sso'];
  const readyCheck = _moduleReadyCheck || waitForModulesInstalled;
  if (!await readyCheck({ dbName: ctx.dbName, modules: wantModules, timeoutMs: firstBuild ? Math.max(HEALTH_TIMEOUT_MS, 300000) : HEALTH_TIMEOUT_MS })) {
    log += `[docker] registry 未就緒：${ctx.dbName} 內 ${wantModules.join(',')} 未於期限內全部 installed（base 安裝未完成即被放行是舊 race 的根因）\n`;
    log += `容器 log：\n${await dockerEnv.containerLogs(ctx.container).catch(() => '')}`;
    await dockerEnv.removeContainer(ctx.container);
    return _failEnv(projectId, `Odoo 模組安裝未完成（${wantModules.join('/')} 未就緒），已於 seed 前中止`, log);
  }
  if (firstBuild) { try { fs.writeFileSync(readyMarker, new Date().toISOString()); } catch { /* 非致命 */ } }

  // 4) 補裝自訂模組 Python 相依（image 未內建）＋ seed users
  try { log += await installModuleRequirements(projectId); } catch (e) { log += `[deps] FAIL ${e.message}\n`; }
  // seed 失敗不得放行成 running：這一步寫的是「測試區裡的 E2E 帳號」與
  // 「ir.config_parameter('aidev.sso_secret')」，而平台端的 sso_secret／e2e_password 在上面
  // 已經先存進 odoo_envs 了。放行的話兩邊憑證不一致——SSO 免密登入驗章失敗、E2E 拿一組
  // DB 裡不存在的密碼登入，症狀（登入失敗／404）完全不指向 seed，而 setup_log 裡那行
  // [seed] FAIL 沒有任何人會去看。比照健康檢查失敗：移除容器、落 error 讓原因浮上畫面。
  try {
    log += await _seedOdooUsersDocker(ctx);
  } catch (e) {
    log += `[seed] FAIL ${e.message}\n`;
    await dockerEnv.removeContainer(ctx.container);
    return _failEnv(projectId, `測試區帳號 seed 失敗（SSO／E2E 憑證未寫入）：${e.message}`, log);
  }

  // CMD 上的 -i idx_aidev_sso 有可能整個被回滾：專案模組宣告的 Python 相依是上面
  // installModuleRequirements 才用 pip 補進「容器可寫層」的，容器一被 rm（夜間關機／閒置回收）
  // 就跟著消失，而 DB 裡那些模組仍是已安裝——於是重建時常駐進程一啟動就 ModuleNotFoundError
  // → Failed to load registry → 連 idx_aidev_sso 一起回滾。症狀是 /aidev/sso 回 404，但
  // run／pip／seed 與健康檢查全部回報成功（健檢只探埠），使用者要到點下「開啟測試區」才看到
  // Not Found 且毫無線索。相依此刻已補齊，重啟常駐進程即可讓 -i 重跑並 import controllers。
  // 只在真的 404 時才重啟：健康環境（含所有首次建置）不必白付一次 Odoo 冷啟。
  if (await _ssoRouteMissing(envHost, port)) {
    log += '[sso] /aidev/sso 回 404（-i idx_aidev_sso 被 registry 載入失敗回滾）→ 相依已補齊，重啟容器重試\n';
    await dockerEnv.restartContainer(ctx.container);
    if (!await waitForPort(port, HEALTH_TIMEOUT_MS, 1000, envHost)) {
      log += `[docker] 重啟後容器 log：\n${await dockerEnv.containerLogs(ctx.container).catch(() => '')}`;
      return _failEnv(projectId, `測試區重啟後未進入監聽：埠 ${port}`, log);
    }
    // 仍 404 ＝ 相依真的補不齊（模組漏宣告 external_dependencies.python、或 pip 裝不動——
    // installModuleRequirements 是 best-effort 不中斷）。比照 seed 失敗不放行：留在 running
    // 只會讓使用者點進去看到 Not Found，而 setup_log 裡的真因沒有人會去看。
    if (await _ssoRouteMissing(envHost, port)) {
      log += `[docker] 容器 log：\n${await dockerEnv.containerLogs(ctx.container).catch(() => '')}`;
      return _failEnv(projectId, 'idx_aidev_sso 未安裝成功，開啟測試區會是 Not Found（多半是自訂模組的 Python 相依缺件），詳見建立記錄', log);
    }
    log += '[sso] 重啟後 /aidev/sso 已就緒\n';
  }

  // 子網域模式下對外網址是「借到名額的當下才算得出來」，開機時存進 url 會是一個誰都連不上的
  // 舊 port 模式網址（內部埠已不對公網開）。未設子網域樣板時（本機／未反代機）逐字維持原行為。
  const bootUrl = process.env.ENV_EXTERNAL_URL_TEMPLATE ? null : envPublicUrl(port, ctx.dirName);
  await query(
    "UPDATE odoo_envs SET status='running', pid=NULL, pid_started_at=NULL, port=$2, url=$3, setup_log=$4, updated_at=NOW() WHERE project_id=$1",
    [projectId, port, bootUrl, log]
  );

  // 對外曝露：此時尚無人持有名額，同步後 conf 通常不變；仍呼叫是為了收斂殘留段
  // （fire-and-forget；gate 未設＝no-op，Windows 零影響）。
  syncNginxMapDebounced().catch(() => {});

  // VPN 共管：測試區進入 running 後背景暖機該專案所有 vpn 連線（fire-and-forget，不 await；
  // 撥號慢[≤25s/條]不該延後測試區可用時間，查詢時的 lazy ensureGatewayRunning 會冪等補等）。
  // 回傳的彙整 log（OK/FAIL/SKIP）是新架構下唯一一次撥號成敗的訊號，不能像舊架構一樣丟掉。
  startProjectVpns(projectId).then(l => l && console.log(l)).catch(() => {});
}

// 產每環境的 SSO 簽章 secret 與 E2E 密碼並存 odoo_envs（單一真相來源，供 mintSsoToken／
// seed 寫 config param／playwright 讀密碼共用，避免多處各產生而漂移）。每次建置一律換新，
// 讓每環境憑證獨立、原始碼公開亦非通用後門。回 { ssoSecret, e2ePassword }。
async function _ensureEnvCredentials(projectId) {
  const ssoSecret = crypto.randomBytes(32).toString('hex');
  const e2ePassword = crypto.randomBytes(18).toString('base64url');
  await query('UPDATE odoo_envs SET sso_secret=$2, e2e_password=$3 WHERE project_id=$1', [projectId, ssoSecret, e2ePassword]);
  return { ssoSecret, e2ePassword };
}

// seed users（docker）：odoo shell + stdin 腳本。不再撈全平台 users＋password_hash 灌進測試區（憑證外洩），
// 只 seed E2E 帳號一筆（每環境隨機密碼），並把該環境 SSO secret 透過 AIDEV_SSO_SECRET 傳入，由腳本寫進
// ir.config_parameter('aidev.sso_secret') 供 idx_aidev_sso 驗章。其餘平台使用者改由 SSO JIT 首登時建立。
async function _seedOdooUsersDocker(ctx) {
  const users = [{ login: E2E_LOGIN, name: 'E2E 自動測試', password_plain: ctx.e2ePassword }];
  const script = fs.readFileSync(path.join(__dirname, 'seed_odoo_users.py'), 'utf8');
  const { code, stdout, stderr } = await dockerEnv.execOdoo({
    container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
    odooArgs: ['shell', '--no-http'], interactive: true,
    env: { SEED_USERS: JSON.stringify(users), AIDEV_SSO_SECRET: ctx.ssoSecret, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  }, { input: script });
  if (code !== 0) throw new Error((stderr || stdout || '').slice(-300));
  return `[seed] E2E + sso secret → ${String(stdout).trim().slice(-200)}\n`;
}

module.exports = { runEnvSetup, upgradeModules, installModuleRequirements, getDeclaredPythonDeps, getAllDeclaredPythonDeps, installPythonPackage, pythonExternalDeps, runTourTests, uninstallModule, findChrome, stopEnv, nightlyShutdown, sweepIdleEnvs, envIsActive, cleanupProjectEnv, snapshotProjectPaths, waitForPort, waitForModulesInstalled, _setModuleReadyCheckForTesting, restartEnv, ENV_BASE, runtimeLogPath, dockerCtxFor };
