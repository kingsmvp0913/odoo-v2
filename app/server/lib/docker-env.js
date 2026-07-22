// Docker 驅動層：把 Odoo 測試區的生命週期建在官方 odoo:<major> image 上，
// 徹底避開「宿主 Python/相依版本地獄」（尤其 odoo13/14 的 gevent 編譯），達成自動涵蓋 13→未來 20+。
//
// 設計原則：所有「組 docker 參數」的邏輯都是純函式（無 side effect），可完整單元測試；
// 真正碰 docker CLI 的 IO 只有一個 runDocker（測試以 deps 注入 mock）。這樣正確性（參數怎麼組、
// localhost 如何改寫、addons 如何掛）都能離線驗證，實機首跑只需照 image 假設微調設定、不必翻程式。
//
// 與既有 lib/vpn-gateway.js 相同：平台已依賴 docker（VPN gateway 已用 Linux 容器），故不新增基礎設施。

const { spawn, execFileSync: realExecFileSync } = require('child_process');
const path = require('path');

// Docker Desktop（Windows）自動啟動的等待上限（秒）：冷啟動 Linux engine 常要 30~90 秒，放寬到 120 秒。
const DOCKER_START_TIMEOUT_SEC = 120;

// 官方 odoo image 內建核心 addons 目錄。傳 --addons-path 會「覆寫」image 的 odoo.conf 預設，
// 故必須把核心 addons 顯式列回，否則 base 都找不到。可用 env 覆寫以因應 image 版本差異（實機首跑檢查點）。
const CORE_ADDONS = process.env.ODOO_IMAGE_CORE_ADDONS || '/usr/lib/python3/dist-packages/odoo/addons';

// 容器內掛載自訂 addons 的根目錄（各 host repo 掛成此目錄下的子目錄）。
const EXTRA_ADDONS_ROOT = '/mnt/extra-addons';

// 大版本數字：'17.0'→'17'、17→'17'（取第一段的數字，避免 '17.0' 變成 '170'）。
function majorDigits(major) {
  return String(major).split('.')[0].replace(/\D/g, '');
}

// 平台自建的 odoo+chromium image 標籤（FROM odoo:<major> + chromium，供 tour 用）。
function imageTagFor(major) {
  return `odoo-idx:${majorDigits(major) || 'latest'}`;
}

// 容器名：固定前綴 + 專案目錄名（清成 docker 允許的字元 [a-zA-Z0-9_.-]）。
function containerNameFor(dirName) {
  const safe = String(dirName || '').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[-.]+/, '') || 'env';
  return `odoo-test-${safe}`;
}

// 把「宿主 localhost 的 Postgres」改寫成容器可達位址：容器內的 localhost 是容器自己，
// 連不到宿主 DB，需走 host.docker.internal（搭配 run 時的 --add-host=...:host-gateway）。
// 只改寫指向本機的 db_host；遠端 DB 位址原樣保留。回傳新的 odoo db 參數陣列。
function remapDbHostForContainer(dbArgs) {
  const out = [];
  for (let i = 0; i < dbArgs.length; i++) {
    out.push(dbArgs[i]);
    if (dbArgs[i] === '--db_host') {
      const host = dbArgs[i + 1];
      const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
      out.push(isLocal ? 'host.docker.internal' : host);
      i++; // 已消化 value
    }
  }
  // 未帶 --db_host（DATABASE_URL 缺 host）時也要能連宿主：補一個 host.docker.internal
  if (!dbArgs.includes('--db_host')) out.push('--db_host', 'host.docker.internal');
  return out;
}

// 把 host repo 路徑清單映射成容器掛載點：[{ host, container }]，容器路徑用 basename 掛在 EXTRA_ADDONS_ROOT 下。
// basename 撞名時綴序號，確保容器內路徑唯一（否則後者覆蓋前者、addons 遺失）。
function addonsMounts(hostPaths) {
  const seen = new Map();
  return (hostPaths || []).filter(Boolean).map((hostPath) => {
    let base = path.basename(hostPath.replace(/[/\\]+$/, '')) || 'addons';
    base = base.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const uniq = n === 1 ? base : `${base}-${n}`;
    return { host: hostPath, container: `${EXTRA_ADDONS_ROOT}/${uniq}` };
  });
}

// 容器內完整 addons-path 字串：核心 addons + 各掛載子目錄（順序：自訂優先於核心，與 venv 模式一致——
// venv 模式 addons-path = [src/addons, ...extraAddons]，自訂在後；此處核心置後以讓自訂覆蓋能力相同）。
function containerAddonsPath(mounts) {
  return [...(mounts || []).map(m => m.container), CORE_ADDONS].join(',');
}

// 掛載 addons 的 `-v` 片段（唯讀）；run/one-shot 共用。
function mountFlags(mounts) {
  const out = [];
  for (const m of mounts || []) out.push('-v', `${m.host}:${m.container}:ro`);
  return out;
}

// odoo 一律要帶的 DB 與 addons 參數（-d、--addons-path 含核心、已 remap 的 db 連線）；exec 路徑用
// （docker exec 不走 image entrypoint，CLI --db_* 直接生效）。run 路徑改走 dbEnvFlags，見下。
function odooDbAddonsArgs({ dbName, mounts = [], dbArgs = [] }) {
  return ['-d', dbName, '--addons-path', containerAddonsPath(mounts), ...remapDbHostForContainer(dbArgs)];
}

// 把 odoo db CLI 參數（--db_host/port/user/password，localhost 已 remap）轉成官方 odoo image 的
// entrypoint 認得的環境變數旗標（-e HOST=... 等）。docker run 專用：entrypoint 會依這組 env 在使用者
// 參數「後面」補一組 --db_host/... ，若我們仍走 CLI 傳，會被那組覆蓋（Odoo 參數重複時後者勝，見
// /entrypoint.sh）。故 run 的連線一律改用 env，讓 entrypoint 產生正確連線。
function dbEnvFlags(dbArgs = []) {
  const remapped = remapDbHostForContainer(dbArgs);
  const map = { '--db_host': 'HOST', '--db_port': 'PORT', '--db_user': 'USER', '--db_password': 'PASSWORD' };
  const out = [];
  for (let i = 0; i < remapped.length - 1; i++) {
    const envName = map[remapped[i]];
    if (envName) out.push('-e', `${envName}=${remapped[i + 1]}`);
  }
  return out;
}

// 組「常駐 server」的 `docker run -d ...`（純函式，供單測逐項驗證）。
//   name/image/host/port：容器名、image、宿主 loopback host（127.0.0.x）、對外埠 → 對映容器內 8069。
//   dbArgs：odoo db 參數（本函式 remap localhost）；mounts：addonsMounts 結果；
//   serverArgs：額外 server 參數（首次啟動帶 -i base 等 init 旗標，Odoo 裝完 base 後續跑 server）。
function buildRunArgs({ name, image, host, port, dbName, dbArgs = [], mounts = [], serverArgs = [], filestoreDir } = {}) {
  return ['run', '-d', '--name', name,
    // 宿主 DB 走 host-gateway；Linux 原生 docker 沒有 host.docker.internal，需顯式加。
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `${host || '127.0.0.1'}:${port}:8069`,
    ...mountFlags(mounts),
    // filestore（ir.attachment 二進位，含 asset bundle）持久化到宿主：容器是拋棄式的、會被 rm+run 重建，
    // 若 filestore 留在匿名 volume 會隨重建遺失，但宿主 DB 的 attachment 記錄還在 → asset 檔不見、每個
    // asset 請求 500。綁到宿主目錄讓它與 DB 同樣持久（rw，Odoo 需寫入）。未指定則沿用容器預設 volume。
    ...(filestoreDir ? ['-v', `${filestoreDir}:/var/lib/odoo/filestore`] : []),
    // DB 連線走 entrypoint env（見 dbEnvFlags）；-d／--addons-path 仍走 CLI（entrypoint 不碰）。
    ...dbEnvFlags(dbArgs),
    image, 'odoo',
    '--http-port=8069', '--http-interface=0.0.0.0',
    '-d', dbName, '--addons-path', containerAddonsPath(mounts),
    ...serverArgs,
  ];
}

// 組 `docker exec` 的 argv：對「運行中的常駐容器」跑一次性指令（升級/卸載/seed/tour/pip 補件）。
// 走 exec（而非另起 --rm 容器）＝共用該容器已裝的自訂模組 Python 相依，與 venv 模式「同一 venv 另起
// odoo-bin 進程」語意一致。interactive 加 -i（餵 stdin）；user 指定 -u（pip 補件需 root 寫 site-packages）；
// env 以 -e 傳入；argv 為容器內要跑的完整指令（如 ['odoo','-u','sale',...] 或 ['python','-m','pip',...]）。
function buildExecArgs({ container, argv = [], interactive = false, user, env = {} }) {
  const args = ['exec'];
  if (interactive) args.push('-i');
  if (user) args.push('-u', user);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(container, ...argv);
  return args;
}

// —— 唯一的 IO 邊界：實際呼叫 docker CLI。測試以 deps.spawn 注入 mock。 ——
// 回傳 { code, stdout, stderr }；不 reject（由呼叫端依 code 判定），逾時則 kill 並回 code=null。
function runDocker(args, { input, signal, timeoutMs = 600000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn('docker', args, { windowsHide: true, signal });
    let stdout = '', stderr = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ code: null, stdout, stderr: stderr + `\n[docker] 逾時（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', e => done({ code: null, stdout, stderr: stderr + String(e && e.message || e) }));
    child.on('close', code => done({ code, stdout, stderr }));
    if (input != null) { try { child.stdin.write(input); child.stdin.end(); } catch { /* ignore EPIPE */ } }
    else { try { child.stdin?.end(); } catch { /* ignore */ } }
  });
}

// docker 是否可用（daemon 有回應）。
async function dockerAvailable(deps = {}) {
  const { code } = await runDocker(['info'], deps);
  return code === 0;
}

// 同步版 daemon 檢查（供 ensureDockerRunning 的輪詢用；execFileSync 可注入 mock）。
function isDockerDaemonUp(execFileSync) {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Docker Desktop（Windows）裝好但引擎沒啟動時，背景幫使用者把引擎起來，省得每次操作都要
// 先手動開 Docker Desktop。用官方 `docker desktop start`：背景起引擎、不跳 GUI 視窗，且不帶
// -d 時會同步等到引擎就緒才回（--timeout 設上限）；比啟動 Docker Desktop.exe 乾淨（不開視窗、
// 不需寫死安裝路徑）。非 Windows（如未來的共用 Linux 主機，Docker 通常已是常駐服務）直接回錯，
// 交由環境本身管理 daemon 生命週期。daemon 已在跑則直接回、不啟動。
async function ensureDockerRunning(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const platform = deps.platform || process.platform;

  if (isDockerDaemonUp(execFileSync)) return;

  if (platform !== 'win32') {
    throw new Error('Docker 引擎未啟動，請手動啟動 Docker 服務');
  }

  try {
    execFileSync('docker', ['desktop', 'start', '--timeout', String(DOCKER_START_TIMEOUT_SEC)], { stdio: 'ignore' });
  } catch {
    // start 指令失敗／逾時／舊版無此子指令 → 下方再確認一次 daemon，仍不通就回報清楚錯誤
  }

  if (isDockerDaemonUp(execFileSync)) return;
  throw new Error('Docker 引擎啟動逾時，請手動確認 Docker Desktop');
}

// image 是否已存在本機。
async function imageExists(tag, deps = {}) {
  const { code, stdout } = await runDocker(['images', '-q', tag], deps);
  return code === 0 && stdout.trim().length > 0;
}

// 容器是否存在（含已停止）。
async function containerExists(name, deps = {}) {
  const { code, stdout } = await runDocker(['ps', '-a', '-q', '-f', `name=^${name}$`], deps);
  return code === 0 && stdout.trim().length > 0;
}

// 容器是否運行中。
async function containerRunning(name, deps = {}) {
  const { code, stdout } = await runDocker(['inspect', '-f', '{{.State.Running}}', name], deps);
  return code === 0 && stdout.trim() === 'true';
}

// 建平台自建 image（odoo-idx:<major> ＝ FROM odoo:<major> + chromium）。已存在則跳過（冪等）。
// contextDir 需含 Dockerfile.odoo。回傳 { ok, log }。
async function ensureImage(major, contextDir, deps = {}) {
  const tag = imageTagFor(major);
  if (await imageExists(tag, deps)) return { ok: true, log: `[image] ${tag} 已存在\n` };
  const dockerfile = path.join(contextDir, 'Dockerfile.odoo');
  const { code, stdout, stderr } = await runDocker(
    ['build', '-t', tag, '--build-arg', `ODOO_MAJOR=${majorDigits(major)}`, '-f', dockerfile, contextDir],
    { timeoutMs: 1800000, ...deps } // image build 較久（首次 pull base + apt install），放寬到 30 分
  );
  if (code !== 0) return { ok: false, log: `[image] build ${tag} 失敗\n${stderr || stdout}`.slice(-1000) };
  return { ok: true, log: `[image] build ${tag} OK\n` };
}

// 起容器（-d）。呼叫端先確保同名容器已移除（見 removeContainer）。回傳 { ok, log, stderr }。
async function runContainer(opts, deps = {}) {
  const { code, stdout, stderr } = await runDocker(buildRunArgs(opts), deps);
  return { ok: code === 0, log: (stdout || '') + (stderr || ''), stderr };
}

// 在運行中的常駐容器內跑一次性 odoo 指令（升級/卸載/seed/tour）。container 內另起一個 odoo 進程，
// 與常駐 server 併行、連同一宿主 DB。odooArgs 為 odoo 之後的參數；本函式補 odoo 與 db/addons 參數。
// interactive+input 供 odoo shell 讀 stdin 腳本。回傳 { code, stdout, stderr }（原樣供呼叫端解析）。
async function execOdoo({ container, dbName, dbArgs = [], mounts = [], odooArgs = [], interactive = false, env = {} }, io = {}) {
  // odoo 子指令（如 shell）必須緊接在 odoo 之後、排在 db/addons 參數之前；否則 odoo 走預設 server 指令、
  // 把子指令當多餘位置參數而報 "unrecognized parameters: 'shell'"。開頭非 '-' 者即視為子指令，提到最前。
  const hasSubcmd = odooArgs.length > 0 && !String(odooArgs[0]).startsWith('-');
  const subcmd = hasSubcmd ? [odooArgs[0]] : [];
  const rest = hasSubcmd ? odooArgs.slice(1) : odooArgs;
  const argv = ['odoo', ...subcmd, ...odooDbAddonsArgs({ dbName, mounts, dbArgs }), ...rest];
  return runDocker(buildExecArgs({ container, argv, interactive, env }), io);
}

// 在容器內以 root 補裝 Python 套件（自訂模組宣告的相依，image 未內建）。pkgs 已由呼叫端過白名單。
async function execPipInstall(container, pkgs, io = {}) {
  // 官方 odoo image（Debian 與 Ubuntu 皆然）只有 python3、沒有 python 別名——用 python 會 not found、
  // 導致自訂模組宣告的相依全部裝不進去、模組 import 時 ModuleNotFoundError。
  const argv = ['python3', '-m', 'pip', 'install', '--', ...pkgs];
  return runDocker(buildExecArgs({ container, argv, user: 'root' }), io);
}

async function stopContainer(name, deps = {}) {
  return runDocker(['stop', '-t', '10', name], deps);
}

async function removeContainer(name, deps = {}) {
  await runDocker(['rm', '-f', name], deps); // -f 連運行中一起移除；不存在不報錯（code!=0 但無害）
}

// 抓容器 log（供前端「查看 log」）。tail 限制行數避免無上限。
async function containerLogs(name, { tail = 2000 } = {}, deps = {}) {
  const { stdout, stderr } = await runDocker(['logs', '--tail', String(tail), name], deps);
  return `${stdout || ''}${stderr || ''}`;
}

module.exports = {
  // 純函式（單測用）
  imageTagFor, majorDigits, containerNameFor, remapDbHostForContainer, addonsMounts,
  containerAddonsPath, odooDbAddonsArgs, dbEnvFlags, buildRunArgs, buildExecArgs,
  // 低階 IO
  runDocker, dockerAvailable, isDockerDaemonUp, ensureDockerRunning,
  imageExists, containerExists, containerRunning,
  // 生命週期
  ensureImage, runContainer, execOdoo, execPipInstall, stopContainer, removeContainer, containerLogs,
  // 常數
  CORE_ADDONS, EXTRA_ADDONS_ROOT,
};
