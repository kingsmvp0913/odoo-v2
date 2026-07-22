const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { query } = require('../db');
const { ensureTestingBranch } = require('./git');
const { E2E_LOGIN, E2E_PASSWORD } = require('./e2e-account');
const { allocateProjectPort, loopbackHostForPort } = require('../port-alloc');

// 測試環境一律建在專案內 odoo-v2/odoo-envs（比照 REPOS_BASE 慣例），不得跑到專案外
const ENV_BASE = process.env.ODOO_ENV_BASE || path.resolve(__dirname, '..', '..', '..', 'odoo-envs');

// Docker 模式：測試區改建在官方 odoo:<major> image 上，徹底避開宿主多版本 Python／gevent 編譯，
// 自動涵蓋 odoo 13→未來 20+。由「管理設定 → 環境建置模式」切換（teams_settings.env_mode），
// 預設 'venv'（行為不變）。讀 DB 設定而非環境變數，改設定即時生效、免重啟。
const dockerEnv = require('../lib/docker-env');
const DOCKER_CTX_DIR = path.resolve(__dirname, '..', '..', 'docker'); // app/docker（含 Dockerfile.odoo）
// 容器內 tour（HttpCase）自起的 http 埠：與常駐 server 的 8069 錯開（exec 與 server 共用容器網路）。
const DOCKER_TEST_HTTP_PORT = 8169;
async function isDockerMode() {
  try {
    const { rows: [s] } = await query("SELECT env_mode FROM teams_settings WHERE id = 1");
    return (s?.env_mode || 'venv').toLowerCase() === 'docker';
  } catch { return false; }
}

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

function execCmd(bin, args, signal) {
  return new Promise((resolve, reject) => {
    // maxBuffer 預設僅 1MB，Odoo 升級 log 超過會以 maxBuffer exceeded 假失敗
    // signal：手動暫停任務時中止 odoo-bin 子行程（否則 deploy／E2E 階段按暫停沒反應）
    const child = execFile(bin, args, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      if (err) {
        // 保留完整診斷：只留 stderr 的話，「幾秒就死、stderr 只有 banner」的失敗會無從鑑識（健檢根因 C）
        const e = new Error(stderr || err.message);
        e.exitCode = err.code; e.killed = !!err.killed; e.stdout = stdout; e.stderr = stderr;
        return reject(e);
      }
      // Odoo 的 Python logging 預設寫 stderr——測試結果、unittest.SkipTest 都在 stderr。
      // 成功路徑只回 stdout 會讓上層（如 playwright 防假綠燈檢查）拿到空字串＝死碼（健檢項3）。
      resolve(stderr ? `${stdout}\n${stderr}` : stdout);
    });
    // execFile 的 signal/timeout 在 Windows 只 TerminateProcess 單一 pid：runTourTests 的 odoo-bin
    // 會派 Chrome（tour）、pip install 會派編譯器當孫程序——被單 pid 砍後孫程序變孤兒常駐吃資源。
    // 暫停/逾時時對同一 pid 補一刀 taskkill /T /F 連整棵樹收（非 Windows 維持 execFile 原生行為）。
    if (isWindows) {
      const reap = () => killTreeWindows(child.pid);
      const t = setTimeout(reap, 600000); if (t.unref) t.unref();
      child.on('exit', () => clearTimeout(t));
      if (signal) {
        if (signal.aborted) reap();
        else signal.addEventListener('abort', reap, { once: true });
      }
    }
  });
}

// 與 execCmd 相同，但把 input 餵進 stdin（execFile 非同步版不支援 input）。
// timeout 必備：odoo-bin shell 若因 DB lock／等待輸入卡住，無 timeout 會讓 seed／卸載階段永久 hang，
// 整條 pipeline 卡死只能重啟 server（比照 execCmd 的 600s 上限）。
function execWithStdin(bin, args, input, env, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, windowsHide: true });
    let out = '', err = '';
    let settled = false;
    const done = fn => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    // 逾時回收：走 proc.js 的 killChildGracefully（SIGTERM→寬限→SIGKILL；Windows 走 taskkill /T /F
    // 連子孫一起收，避免 odoo-bin shell 若派子行程時留孤兒）
    const timer = setTimeout(() => {
      killChildGracefully(child);
      done(() => reject(new Error(`odoo-bin shell 逾時（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => done(() => reject(e)));
    child.on('close', code => done(() => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
    // 子行程提早死掉時 stdin 會發 EPIPE error，無 handler 會變 uncaughtException 拖垮 server
    child.stdin.on?.('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

// 溫和殺行程（SIGTERM→寬限→SIGKILL）與 pid 身分指紋共用 lib/proc.js。
// expectedStart 用 odoo_envs.pid_started_at：app 重啟後 OS 可能把舊 pid 派給無關行程，核對不符即拒殺。
const { killPidGracefully, killChildGracefully, killTreeWindows, isWindows, pidStartTime } = require('../lib/proc');

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

// 專案 venv 的 python 路徑（跨平台）；env 尚未建則回 null。
async function projectVenvPython(projectId) {
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [projectId]);
  if (!project) return null;
  const dirName = project.folder_name || project.name;
  const isWin = process.platform === 'win32';
  const venvPython = path.join(ENV_BASE, dirName, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  return fs.existsSync(venvPython) ? venvPython : null;
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
  if (await isDockerMode()) {
    // docker：把宣告的相依名以 root 在常駐容器內 pip 安裝（image 未內建；requirements.txt 的版本釘定
    // 在 docker 模式先以套件名安裝，未逐檔 -r，屬 Stage 1 取捨——精確版本釘定為後續強化項）。
    const ctx = await dockerCtxFor(projectId);
    if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) return '';
    const declared = [...await getDeclaredPythonDeps(projectId)].filter(n => SAFE_PKG.test(n));
    if (!declared.length) return '';
    const { code, stdout, stderr } = await dockerEnv.execPipInstall(ctx.container, declared, { signal });
    return `[pip-docker] ${code === 0 ? 'OK' : 'FAIL'} ${declared.join(' ')}\n${String(code === 0 ? stdout : stderr).slice(-200)}\n`;
  }
  const venvPython = await projectVenvPython(projectId);
  if (!venvPython) return '';                      // 環境尚未建好，交由建置流程處理
  const repos = await projectAddonsPaths(projectId);
  const reqFiles = [];
  const manifestPkgs = new Set();
  for (const repo of repos) {
    const root = path.join(repo, 'requirements.txt');
    if (fs.existsSync(root)) reqFiles.push(root);
    let entries = [];
    try { entries = fs.readdirSync(repo, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const modDir = path.join(repo, e.name);
      const req = path.join(modDir, 'requirements.txt');
      if (fs.existsSync(req)) reqFiles.push(req);
      const manifest = path.join(modDir, '__manifest__.py');
      if (fs.existsSync(manifest)) {
        try { for (const p of pythonExternalDeps(fs.readFileSync(manifest, 'utf8'))) manifestPkgs.add(p); }
        catch { /* 讀不到就略過 */ }
      }
    }
  }
  if (!reqFiles.length && !manifestPkgs.size) return '';
  let log = '';
  for (const f of reqFiles) {
    try {
      const out = await execCmd(venvPython, ['-m', 'pip', 'install', '-r', f], signal);
      log += `[pip-req] OK ${f}\n${String(out).slice(-200)}\n`;
    } catch (err) {
      log += `[pip-req] FAIL ${f}: ${String(err.stderr || err.message || '').slice(-200)}\n`;
    }
  }
  if (manifestPkgs.size) {
    const pkgs = [...manifestPkgs];
    try {
      // '--' 終止 pip 選項解析：即使白名單漏網，套件名也不會被當旗標（防 argv 旗標走私，縱深防禦）
      const out = await execCmd(venvPython, ['-m', 'pip', 'install', '--', ...pkgs], signal);
      log += `[pip-manifest] OK ${pkgs.join(' ')}\n${String(out).slice(-200)}\n`;
    } catch (batchErr) {
      // 批次一鑊全翻多半只因其中一個套件名打錯——逐一 fallback，讓裝得起來的照裝，
      // 只有真的裝不動的留 FAIL 痕跡（避免一顆壞蘋果拖垮整批，健檢 F5）。
      log += `[pip-manifest] BATCH FAIL，改逐一安裝：${String(batchErr.stderr || batchErr.message || '').slice(-200)}\n`;
      for (const p of pkgs) {
        try {
          const out = await execCmd(venvPython, ['-m', 'pip', 'install', '--', p], signal);
          log += `[pip-manifest] OK ${p}\n${String(out).slice(-120)}\n`;
        } catch (err) {
          log += `[pip-manifest] FAIL ${p}: ${String(err.stderr || err.message || '').slice(-200)}\n`;
        }
      }
    }
  }
  return log;
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
  if (await isDockerMode()) {
    const ctx = await dockerCtxFor(projectId);
    if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) return { ok: false, log: '[pip-fix] SKIP 容器未運行\n' };
    const { code, stdout, stderr } = await dockerEnv.execPipInstall(ctx.container, [name], { signal });
    return { ok: code === 0, log: `[pip-fix-docker] ${code === 0 ? 'OK' : 'FAIL'} ${name}\n${String(code === 0 ? stdout : stderr).slice(-200)}\n` };
  }
  const venvPython = await projectVenvPython(projectId);
  if (!venvPython) return { ok: false, log: '[pip-fix] SKIP 環境尚未建立\n' };
  try {
    const out = await execCmd(venvPython, ['-m', 'pip', 'install', '--', name], signal);
    return { ok: true, log: `[pip-fix] OK ${name}\n${String(out).slice(-200)}\n` };
  } catch (err) {
    return { ok: false, log: `[pip-fix] FAIL ${name}: ${String(err.stderr || err.message || '').slice(-200)}\n` };
  }
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

// 各 Odoo 大版本相容的 CPython 小版本（偏好序，探測時逐一嘗試機器上是否實際可用）。
// 依 Odoo 官方對各版本的 Python 需求整理，讓自動部署（13→未來 20+）免逐版本人工設定：
//   舊版（13/14）的舊相依（gevent 等）只有舊 Python 才有預編譯 wheel／才編得起來；新版要新 Python。
const ODOO_PYTHON_PREFS = {
  13: ['3.8', '3.7', '3.6'],
  14: ['3.8', '3.7', '3.6'],
  15: ['3.9', '3.8', '3.10'],
  16: ['3.10', '3.9', '3.8'],
  17: ['3.11', '3.10', '3.12'],
  18: ['3.12', '3.11', '3.10'],
  19: ['3.12', '3.11'],
};
// 未列於上表的未來新版（如 2026 的 20）：由新到舊試這些「當代」Python。
const MODERN_PYTHONS = ['3.13', '3.12', '3.11'];

// 探測機器上某個 CPython 小版本是否可用，回傳可當 venv 基底的直譯器（Windows 回實際 python.exe 完整路徑，
// 其他平台回 pythonX.Y 名）；不可用回 null。Windows 走 py launcher（py -3.8）問出 executable。
async function probePython(version) {
  try {
    if (isWindows) {
      const out = await execCmd('py', [`-${version}`, '-c', 'import sys;print(sys.executable)']);
      const p = String(out).trim().split(/\r?\n/).pop().trim();
      return p && fs.existsSync(p) ? p : null;
    }
    const bin = `python${version}`;
    await execCmd(bin, ['--version']);
    return bin;
  } catch { return null; }
}

// 為某 Odoo 大版本自動挑一個「相容且機器上實際可用」的 Python 來建 venv（免逐版本人工設定）：
//   1) 明確 override 最優先（逃生艙）：PYTHON_BIN_<major> → PYTHON_BIN
//   2) 依相容表逐一探測；未列的未來新版探測當代 Python（新→舊）
//   3) 都探不到 → 回退系統預設 python，並在 note 明說缺哪些版本（建置仍嘗試，失敗有跡可循）
async function resolveSystemPython(major) {
  const override = process.env[`PYTHON_BIN_${major}`] || process.env.PYTHON_BIN;
  if (override) return { python: override, note: `[py] Odoo ${major}：使用 override ${override}` };
  const prefs = ODOO_PYTHON_PREFS[major] || MODERN_PYTHONS;
  for (const v of prefs) {
    const found = await probePython(v);
    if (found) return { python: found, note: `[py] Odoo ${major} → Python ${v}（${found}）` };
  }
  const fallback = isWindows ? 'python' : 'python3';
  return {
    python: fallback,
    note: `[py] 警告：找不到 Odoo ${major} 相容的 Python（試過 ${prefs.join('/')}），回退 ${fallback}；`
      + `若建置因相依不相容失敗，請在測試機安裝對應 Python（Windows 經 py launcher 即可被自動偵測）`
  };
}

async function _runEnvSetup(projectId) {
  if (await isDockerMode()) return _runEnvSetupDocker(projectId);
  const { rows: [project] } = await query(
    'SELECT name, folder_name, odoo_version, port FROM projects WHERE id = $1',
    [projectId]
  );
  if (!project) return;

  // 埠在建立專案時已固定分配（projects.port）；缺值（極舊資料）才補配一次並持久化。
  let port = project.port;
  if (!port) {
    port = await allocateProjectPort();
    await query('UPDATE projects SET port=$2 WHERE id=$1', [projectId, port]);
  }
  // 每專案專屬 loopback host：讓多開測試區時瀏覽器 cookie 依 host 隔離，不再互蓋 session。
  const envHost = loopbackHostForPort(port);
  const major = (project.odoo_version || '17.0').split('.')[0];
  const baseDir = ENV_BASE;
  const dirName = project.folder_name || project.name;
  const envDir = path.join(baseDir, dirName);
  fs.mkdirSync(envDir, { recursive: true });
  const srcDir = path.join(envDir, 'src');
  const odooBin = path.join(srcDir, 'odoo-bin');
  const dbName = `test_${dirName}`;  // 與目錄名一致（folder_name || name），避免非 ASCII 資料庫名
  const extraAddons = await projectAddonsPaths(projectId);
  // 防呆：測試環境部署 testing 分支，確保每個主 clone 停在 testing（正常情況已在，非致命）
  for (const p of extraAddons) {
    try { await ensureTestingBranch(p); } catch { /* 非致命，不擋環境建立 */ }
  }
  const addonsPath = [path.join(srcDir, 'addons'), ...extraAddons].join(',');

  // 跨平台 venv 結構：Windows = venv/Scripts/python.exe；Linux = venv/bin/python
  const isWin = process.platform === 'win32';
  const venvDir = path.join(envDir, 'venv');
  const venvPython = path.join(venvDir, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  // 建 venv 的直譯器：全自動為此 Odoo 大版本挑一個「相容且機器上實際可用」的 Python，
  // 涵蓋 13→未來 20+ 免逐版本人工設定（見 resolveSystemPython）。
  const { python: systemPython, note: pyNote } = await resolveSystemPython(major);
  // Odoo≤16 綁較舊生態：setuptools<58 才含 2to3（舊相依源碼編譯所需）並保留 pkg_resources；
  // ≥17 用 <81（Python 3.12 venv 不再內建 setuptools，且 setuptools≥81 移除了 pkg_resources）。
  const setuptoolsPin = parseInt(major, 10) <= 16 ? 'setuptools<58' : 'setuptools<81';
  // 完整建置成功後寫入；存在即代表 clone/venv/pip/init 都已完成，停止後可直接快速啟動
  const readyMarker = path.join(envDir, '.ready');

  await query(
    `INSERT INTO odoo_envs (project_id, status, port, updated_at)
     VALUES ($1, 'setting_up', $2, NOW())
     ON CONFLICT (project_id) DO UPDATE SET status='setting_up', error_msg=NULL, setup_log=NULL, port=$2, updated_at=NOW()`,
    [projectId, port]
  );

  // 建置測試環境即驗證 chrome 存在：tour 需要它，缺則整個環境不算就緒（避免日後 E2E 假綠燈）。
  if (!fs.existsSync(readyMarker) && !findChrome()) {
    await query(
      "UPDATE odoo_envs SET status='error', error_msg=$2, updated_at=NOW() WHERE project_id=$1",
      [projectId, '找不到 Google Chrome（tour E2E 需要）。請安裝 Chrome 後重建環境。預期路徑：%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe']
    );
    return;
  }

  // clone 完整性：上次 clone 被中斷（app 重啟／10 分鐘 timeout 砍掉）會留下半殘 srcDir；
  // 只看「目錄存在」會永久跳過 clone → 後續步驟因缺檔永遠失敗且無法自癒，必須人工刪目錄。
  // 以 odoo-bin＋.git 存在為「完整」判準；不完整就先清掉重 clone（git clone 也拒絕 clone 進非空目錄）。
  const cloneIntact = fs.existsSync(odooBin) && fs.existsSync(path.join(srcDir, '.git'));
  if (!cloneIntact && fs.existsSync(srcDir)) {
    try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch { /* 留給 clone 步驟報錯 */ }
  }
  const steps = [
    ...(!cloneIntact ? [
      { name: 'clone', bin: 'git', args: ['clone', 'https://github.com/odoo/odoo.git', '--branch', `${major}.0`, '--depth=1', srcDir] }
    ] : []),
    { name: 'venv', bin: systemPython, args: ['-m', 'venv', '--clear', '--copies', venvDir] },
    // 補 wheel 與 setuptools：Python 3.12 起 venv 不再內建 setuptools，Odoo（module.py import pkg_resources）
    // 會 ModuleNotFoundError；且 setuptools≥81 已移除 pkg_resources，故釘 <81 保留它。wheel 讓 pip 優先取
    // 預編譯 binary（如 gevent），避免在缺編譯器／新版 Python 下走原始碼編譯而失敗。
    { name: 'pip',  bin: venvPython, args: ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', setuptoolsPin] },
    { name: 'pip-req', bin: venvPython, args: ['-m', 'pip', 'install', '-r', path.join(srcDir, 'requirements.txt')] },
    { name: 'init', bin: venvPython, args: [odooBin, '-d', dbName, '--stop-after-init', '-i', 'base', '--without-demo=all', '--load-language=zh_TW', '--addons-path', addonsPath, ...odooDbArgs()] },
  ];

  // 停止後再啟動：偵測到既有 .ready 標記與 venv，跳過整套建置，只重新啟動 process
  const alreadyBuilt = fs.existsSync(readyMarker) && fs.existsSync(venvPython);

  let log = pyNote ? `${pyNote}\n` : '';
  if (alreadyBuilt) {
    log += '[fast-start] 偵測到既有環境（.ready），跳過 clone/venv/pip/init，直接啟動\n';
  } else {
    for (const step of steps) {
      try {
        const out = await execCmd(step.bin, step.args);
        log += `[${step.name}] OK\n${out}\n`;
      } catch (err) {
        log += `[${step.name}] FAIL\n${err.message}\n`;
        await query(
          "UPDATE odoo_envs SET status='error', error_msg=$2, setup_log=$3, updated_at=NOW() WHERE project_id=$1",
          [projectId, `${step.name} failed: ${err.message}`, log]
        );
        return;
      }
    }
    fs.writeFileSync(readyMarker, new Date().toISOString());
    // 建置完成後把本系統所有 users 灌進 Odoo（全部管理員、密碼互通）；失敗不擋環境啟動
    try {
      log += await seedOdooUsers({ venvPython, odooBin, dbName, addonsPath });
    } catch (err) {
      log += `[seed] FAIL ${err.message}\n`;
    }
  }

  // --http-interface=0.0.0.0：綁所有介面（與 Odoo 預設同，不新增曝露），使各專案的
  // 127.0.0.x 專屬 host 都連得到同一個 port 上的服務（cookie 隔離所需）。
  // 常駐 Odoo 伺服器：Windows 上用 pythonw.exe（GUI 子系統、無主控台視窗）。
  // windowsHide 對 detached 的 console 程式不生效，故改直譯器本身才是正解。缺檔則退回 python.exe。
  let serverPython = venvPython;
  if (isWin) {
    const pythonw = path.join(venvDir, 'Scripts', 'pythonw.exe');
    if (fs.existsSync(pythonw)) serverPython = pythonw;
  }
  // 常駐 server 的 runtime log：交由 Odoo 原生 --logfile 自寫（pythonw 無主控台、detached 導 stdio 到檔不可靠），
  // 供前端「查看 log」按鈕除錯（如 asset bundle 503 → 後台空白，traceback 只在此可見）。
  // 每次啟動先清空，只保留當次執行的 log，避免無上限成長。
  // 既有環境還在跑（重按建立、crash 後 DB 仍記著活 pid）就直接再 spawn 會撞 port：
  // 新行程綁失敗被標 error、舊 pid 又被覆寫 → 孤兒行程洩漏。先溫和殺掉舊行程再啟動。
  const { rows: [prevEnv] } = await query('SELECT pid, pid_started_at FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (prevEnv?.pid) await killPidGracefully(prevEnv.pid, { expectedStart: prevEnv.pid_started_at });

  const logPath = runtimeLogPath(envDir);
  try { fs.rmSync(logPath, { force: true }); } catch {}
  const child = spawn(serverPython, [odooBin, '-d', dbName, `--http-port=${port}`, '--http-interface=0.0.0.0', `--logfile=${logPath}`, '--addons-path', addonsPath, ...odooDbArgs()], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,  // 背景運行，不另開 Windows 主控台視窗（pythonw 為主要手段，此為輔）
    // PYTHONUTF8：強制 Python 以 UTF-8 寫 --logfile，否則 Windows 用系統編碼（cp950）寫檔，
    // 中文 traceback／錯誤訊息（env 載 zh_TW）會變亂碼，讓 log 對中文錯誤失去鑑識價值。
    env: { ...process.env, PYTHONUTF8: '1' }
  });
  // detached/unref 的子行程，仍會在父程序存活期間送出 exit 事件；用來偵測「啟動即崩」。
  let earlyExit = null;
  child.once('exit', (code, sig) => { earlyExit = { code, sig }; });
  // spawn 失敗（venv 損毀、pythonw 不存在等）是非同步 'error' 事件、非同步 throw：無 handler 會變
  // uncaughtException 拖垮整個 server。導成 earlyExit 讓下方健檢走 status='error' 收斂，不崩 server。
  child.once('error', e => { earlyExit = earlyExit || { code: null, sig: null, err: String(e && e.message || e) }; });
  child.unref();
  const pid = child.pid || null;
  // 行程身分指紋（Linux /proc starttime；其他平台 null）：供之後 kill 前核對防 pid 重用誤殺
  const pidStartedAt = pid ? pidStartTime(pid) : null;

  // 啟動後健康檢查：探測埠真的 listen（或偵測到 process 提早結束）才標 running。
  // 逾時／崩潰 → 標 error（非 running），避免 stale running 把死掉的 URL 交給 E2E（本次事故根因）。
  const healthy = await waitForPort(port);
  if (earlyExit || !healthy) {
    const reason = earlyExit
      ? (earlyExit.err
          ? `Odoo process 啟動失敗（spawn error：${earlyExit.err}）`
          : `Odoo process 啟動後隨即結束（exit=${earlyExit.code}${earlyExit.sig ? `/${earlyExit.sig}` : ''}）`)
      : `Odoo 啟動逾時：${Math.round(HEALTH_TIMEOUT_MS / 1000)} 秒內埠 ${port} 未進入監聽`;
    log += `[start] PID=${pid} port=${port} → 健康檢查失敗：${reason}\n`;
    await killPidGracefully(pid);
    await query(
      "UPDATE odoo_envs SET status='error', pid=NULL, url=NULL, error_msg=$2, setup_log=$3, updated_at=NOW() WHERE project_id=$1",
      [projectId, reason, log]
    );
    return;
  }
  log += `[start] PID=${pid} port=${port} 健康檢查通過\n`;

  await query(
    "UPDATE odoo_envs SET status='running', pid=$2, pid_started_at=$3, port=$4, url=$5, setup_log=$6, updated_at=NOW() WHERE project_id=$1",
    [projectId, pid, pidStartedAt, port, `http://${envHost}:${port}`, log]
  );
}

// 把本系統 users 全部建立/更新到 Odoo res.users，設為管理員（base.group_system）。
// password 直接寫入本系統的 pbkdf2_sha512 hash（與 Odoo passlib 相容），達成密碼互通。
async function seedOdooUsers({ venvPython, odooBin, dbName, addonsPath }) {
  const { rows: users } = await query(
    'SELECT username AS login, display_name AS name, password_hash AS password FROM users ORDER BY id'
  );
  // 固定 E2E 測試帳號一律灌入（即使無 app user 也要建，供 Playwright 登入測試區）。
  // 無 app hash，帶明文交由 Odoo passlib 自行雜湊（password_plain，見 seed_odoo_users.py）。
  users.push({ login: E2E_LOGIN, name: 'E2E 自動測試', password_plain: E2E_PASSWORD });
  const script = fs.readFileSync(path.join(__dirname, 'seed_odoo_users.py'), 'utf8');
  const out = await execWithStdin(
    venvPython,
    [odooBin, 'shell', '-d', dbName, '--no-http', '--addons-path', addonsPath, ...odooDbArgs()],
    script,
    // Windows 的 sys.stdin/os.environ 預設非 UTF-8，強制 UTF-8 以正確讀取中文與 pipe script
    { ...process.env, SEED_USERS: JSON.stringify(users), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  );
  return `[seed] ${users.length} users → ${out.trim()}\n`;
}

// 不重建環境，直接把本系統 users 補進/更新到既有 Odoo 測試區（供獨立「同步使用者」按鈕）
async function syncUsers(projectId) {
  if (await isDockerMode()) {
    const ctx = await dockerCtxFor(projectId);
    if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) throw new Error('環境尚未建立或容器未運行，請先建立測試環境');
    return _seedOdooUsersDocker(ctx);
  }
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('project not found');
  const dirName = project.folder_name || project.name;
  const envDir = path.join(ENV_BASE, dirName);
  const srcDir = path.join(envDir, 'src');
  const odooBin = path.join(srcDir, 'odoo-bin');
  const dbName = `test_${dirName}`;
  const extraAddons = await projectAddonsPaths(projectId);
  const addonsPath = [path.join(srcDir, 'addons'), ...extraAddons].join(',');
  const isWin = process.platform === 'win32';
  const venvPython = path.join(envDir, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  if (!fs.existsSync(venvPython)) throw new Error('環境尚未建立，請先建立測試環境');
  return seedOdooUsers({ venvPython, odooBin, dbName, addonsPath });
}

// 對測試區資料庫執行模組升級（odoo-bin -u）。載入/語法錯會以非 0 結束並 throw，供上層判定退回 coding。
async function upgradeModules(projectId, modules, signal) {
  const modArgDocker = (modules && modules.length ? modules : ['all']).join(',');
  if (await isDockerMode()) {
    const ctx = await dockerCtxFor(projectId);
    if (!ctx) throw new Error('project not found');
    if (!(await dockerEnv.containerRunning(ctx.container))) throw new Error('測試容器未運行，請先建立/啟動測試環境');
    // 同 venv：有指定模組給 -i＋-u（新裝＋更新），未指定則 -u all
    const modFlags = (modules && modules.length) ? ['-i', modArgDocker, '-u', modArgDocker] : ['-u', modArgDocker];
    const { code, stdout, stderr } = await dockerEnv.execOdoo({
      container: ctx.container, dbName: ctx.dbName, dbArgs: ctx.dbArgs, mounts: ctx.mounts,
      odooArgs: [...modFlags, '--stop-after-init'],
    }, { signal });
    if (code !== 0) { const e = new Error(stderr || stdout || 'docker upgrade failed'); e.stdout = stdout; e.stderr = stderr; throw e; }
    return { ok: true, log: (stdout || '') + (stderr || '') };
  }
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('project not found');
  const dirName = project.folder_name || project.name;
  const envDir = path.join(ENV_BASE, dirName);
  const srcDir = path.join(envDir, 'src');
  const odooBin = path.join(srcDir, 'odoo-bin');
  const dbName = `test_${dirName}`;
  const extraAddons = await projectAddonsPaths(projectId);
  const addonsPath = [path.join(srcDir, 'addons'), ...extraAddons].join(',');
  const isWin = process.platform === 'win32';
  const venvPython = path.join(envDir, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  if (!fs.existsSync(venvPython)) throw new Error('環境尚未建立，請先建立測試環境');
  const modArg = (modules && modules.length ? modules : ['all']).join(',');
  // 有指定模組：-i 安裝（新模組只 -u 不會裝，Odoo 只印 warning 卻 exit 0＝假成功）＋ -u 更新（既有模組），兩者同給涵蓋新/舊。
  // 未指定：-u all 更新全部已安裝。
  const modFlags = (modules && modules.length) ? ['-i', modArg, '-u', modArg] : ['-u', modArg];
  const out = await execCmd(venvPython, [odooBin, ...modFlags, '-d', dbName, '--stop-after-init', '--addons-path', addonsPath, ...odooDbArgs()], signal);
  return { ok: true, log: out };
}

// 向 OS 要一個當下空閒的 TCP 埠（listen 0 讓核心配發）。tour 的 HttpCase 用它，
// 避免綁 Odoo 預設 8069 撞到常駐 server（第一個專案就配到 8069，E2E 前一步才剛確保它活著）。
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// E2E via tour：與升級同一條 odoo-bin 指令，加 --test-enable 觸發 tour、--test-tags 只跑本模組測試。
// exit 非 0（tour/斷言失敗或載入錯）由 execCmd throw，供上層依 deploy 同套邏輯分類。
async function runTourTests(projectId, moduleName, signal) {
  if (!moduleName) throw new Error('未指定 module，無法執行 tour 測試');
  if (await isDockerMode()) {
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
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('project not found');
  const dirName = project.folder_name || project.name;
  const envDir = path.join(ENV_BASE, dirName);
  const srcDir = path.join(envDir, 'src');
  const odooBin = path.join(srcDir, 'odoo-bin');
  const dbName = `test_${dirName}`;
  const extraAddons = await projectAddonsPaths(projectId);
  const addonsPath = [path.join(srcDir, 'addons'), ...extraAddons].join(',');
  const isWin = process.platform === 'win32';
  const venvPython = path.join(envDir, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  if (!fs.existsSync(venvPython)) throw new Error('環境尚未建立，請先建立測試環境');
  // HttpCase 會自起 http server，不帶 --http-port 會綁預設 8069＝撞常駐 server（健檢項4）。
  // 取一個空閒埠給測試進程，與常駐 server 隔開。
  const httpPort = await findFreePort();
  const out = await execCmd(venvPython, [
    odooBin, '-i', moduleName, '-u', moduleName, '-d', dbName, '--stop-after-init',
    '--test-enable', '--test-tags', `/${moduleName}`, '--http-port', String(httpPort),
    '--addons-path', addonsPath, ...odooDbArgs()
  ], signal);
  return { ok: true, log: out };
}

// 刪任務時把該任務的 module 從測試 DB 卸載（odoo-bin shell + button_immediate_uninstall）。
// 回傳結構化結果，不整庫重建、保住人工 QA 資料。呼叫端負責「任務層依存」判斷（同專案別的任務是否也用它）。
//   { result: 'uninstalled' | 'skipped_not_installed' | 'skipped_no_env' | 'skipped_dependents', dependents?: string[] }
// 環境沒建過（venv/.ready 不在）→ module 不可能裝過，回 skipped_no_env 且不 spawn。
// shell 非 0 或未回傳 RESULT → throw，由呼叫端 fail-open 捕捉。
async function uninstallModule(projectId, moduleName) {
  if (!moduleName) return { result: 'skipped_not_installed' };
  if (await isDockerMode()) {
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
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id = $1', [projectId]);
  if (!project) return { result: 'skipped_no_env' };
  const dirName = project.folder_name || project.name;
  const envDir = path.join(ENV_BASE, dirName);
  const srcDir = path.join(envDir, 'src');
  const odooBin = path.join(srcDir, 'odoo-bin');
  const dbName = `test_${dirName}`;
  const isWin = process.platform === 'win32';
  const venvPython = path.join(envDir, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  if (!fs.existsSync(venvPython) || !fs.existsSync(path.join(envDir, '.ready'))) {
    return { result: 'skipped_no_env' };
  }
  const extraAddons = await projectAddonsPaths(projectId);
  const addonsPath = [path.join(srcDir, 'addons'), ...extraAddons].join(',');
  const script = fs.readFileSync(path.join(__dirname, 'uninstall_module.py'), 'utf8');
  const out = await execWithStdin(
    venvPython,
    [odooBin, 'shell', '-d', dbName, '--no-http', '--addons-path', addonsPath, ...odooDbArgs()],
    script,
    // 比照 seedOdooUsers：Windows stdin/os.environ 預設非 UTF-8，強制 UTF-8 正確讀取 module 名
    { ...process.env, UNINSTALL_MODULE: moduleName, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  );
  const line = String(out).split(/\r?\n/).reverse().find(l => l.startsWith('RESULT:'));
  if (!line) throw new Error(`卸載未回傳結果：${String(out).slice(-300)}`);
  const payload = line.slice('RESULT:'.length).trim();
  if (payload === 'uninstalled') return { result: 'uninstalled' };
  if (payload === 'skipped_not_installed') return { result: 'skipped_not_installed' };
  if (payload.startsWith('skipped_dependents:')) {
    return {
      result: 'skipped_dependents',
      dependents: payload.slice('skipped_dependents:'.length).split(',').map(s => s.trim()).filter(Boolean),
    };
  }
  throw new Error(`卸載回傳未知結果：${payload}`);
}

async function stopEnv(projectId) {
  if (await isDockerMode()) {
    const ctx = await dockerCtxFor(projectId);
    if (ctx) { await dockerEnv.stopContainer(ctx.container); await dockerEnv.removeContainer(ctx.container); }
    await query(
      "UPDATE odoo_envs SET status='idle', pid=NULL, pid_started_at=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
      [projectId]
    );
    return;
  }
  const { rows: [env] } = await query('SELECT pid, pid_started_at FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (!env) return;
  await killPidGracefully(env.pid, { expectedStart: env.pid_started_at });
  await query(
    "UPDATE odoo_envs SET status='idle', pid=NULL, pid_started_at=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
    [projectId]
  );
}

async function nightlyShutdown() {
  const docker = await isDockerMode();
  const { rows } = await query("SELECT project_id, pid, pid_started_at FROM odoo_envs WHERE status='running'");
  for (const env of rows) {
    // 跳過使用中的 env：該專案有任務正在 deploy_testing／playwright_running，
    // 砍了會讓 deploy/E2E 中途死掉被誤歸因為程式問題（健檢：夜間 shutdown 誤歸因）
    const { rows: [busy] } = await query(
      "SELECT 1 FROM tasks WHERE project_id=$1 AND status IN ('deploy_testing','playwright_running') AND is_paused=false AND is_hidden=false LIMIT 1",
      [env.project_id]
    );
    if (busy) continue;
    if (docker) {
      const ctx = await dockerCtxFor(env.project_id);
      if (ctx) { await dockerEnv.stopContainer(ctx.container); await dockerEnv.removeContainer(ctx.container); }
    } else {
      await killPidGracefully(env.pid, { expectedStart: env.pid_started_at });
    }
    await query(
      "UPDATE odoo_envs SET status='idle', pid=NULL, pid_started_at=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
      [env.project_id]
    );
  }
}

// 該專案是否有「使用中」的測試環境：建立中／運行中，或已建置完成（.ready 仍在）。
// 用於防呆：環境使用中時不得移除其掛載的 repo。
async function envIsActive(projectId) {
  const { rows: [env] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (env && (env.status === 'setting_up' || env.status === 'running')) return true;
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [projectId]);
  if (!project) return false;
  const dirName = project.folder_name || project.name;
  if (await isDockerMode()) {
    const ctx = await dockerCtxFor(projectId);
    if (ctx && await dockerEnv.containerExists(ctx.container)) return true;
    return fs.existsSync(path.join(ENV_BASE, dirName, '.docker-ready'));
  }
  return fs.existsSync(path.join(ENV_BASE, dirName, '.ready'));
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

// ================= Docker 模式生命週期（ODOO_ENV_MODE=docker） =================
// 各函式對應 venv 版本，公開入口以 isDockerMode() 早退到這裡。所有 docker 參數組裝在 lib/docker-env.js
// （純函式、已單測）；此處只做「查 DB／落狀態／串起 docker 呼叫」。

// 建置＋啟動：build image → 起常駐容器（首次帶 -i base 裝底）→ 健康檢查 → 補相依 → seed。
async function _runEnvSetupDocker(projectId) {
  const ctx = await dockerCtxFor(projectId);
  if (!ctx) return;
  let port = ctx.project.port;
  if (!port) { port = await allocateProjectPort(); await query('UPDATE projects SET port=$2 WHERE id=$1', [projectId, port]); }
  const envHost = loopbackHostForPort(port);
  fs.mkdirSync(ctx.envDir, { recursive: true });
  const readyMarker = path.join(ctx.envDir, '.docker-ready');

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
    dbArgs: ctx.dbArgs, mounts: ctx.mounts, serverArgs: initArgs,
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

module.exports = { runEnvSetup, upgradeModules, installModuleRequirements, getDeclaredPythonDeps, installPythonPackage, pythonExternalDeps, runTourTests, uninstallModule, findChrome, stopEnv, syncUsers, nightlyShutdown, seedOdooUsers, envIsActive, cleanupProjectEnv, waitForPort, ENV_BASE, runtimeLogPath, resolveSystemPython, probePython, ODOO_PYTHON_PREFS, isDockerMode, dockerCtxFor };
