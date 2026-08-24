// Docker 驅動層：把 Odoo 測試區的生命週期建在官方 odoo:<major> image 上，
// 徹底避開「宿主 Python/相依版本地獄」（尤其 odoo13/14 的 gevent 編譯），達成自動涵蓋 13→未來 20+。
//
// 設計原則：所有「組 docker 參數」的邏輯都是純函式（無 side effect），可完整單元測試；
// 真正碰 docker CLI 的 IO 只有一個 runDocker（測試以 deps 注入 mock）。這樣正確性（參數怎麼組、
// localhost 如何改寫、addons 如何掛）都能離線驗證，實機首跑只需照 image 假設微調設定、不必翻程式。
//
// 與既有 lib/vpn-gateway.js 相同：平台已依賴 docker（VPN gateway 已用 Linux 容器），故不新增基礎設施。

const { spawn, execFile: realExecFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Docker Desktop（Windows）自動啟動的等待上限（秒）：冷啟動 Linux engine 常要 30~90 秒，放寬到 120 秒。
const DOCKER_START_TIMEOUT_SEC = 120;

// 官方 odoo image 內建核心 addons 目錄。傳 --addons-path 會「覆寫」image 的 odoo.conf 預設，
// 故必須把核心 addons 顯式列回，否則 base 都找不到。可用 env 覆寫以因應 image 版本差異（實機首跑檢查點）。
const CORE_ADDONS = process.env.ODOO_IMAGE_CORE_ADDONS || '/usr/lib/python3/dist-packages/odoo/addons';

// 容器內掛載自訂 addons 的根目錄（各 host repo 掛成此目錄下的子目錄）。
const EXTRA_ADDONS_ROOT = '/mnt/extra-addons';

// 平台自帶 addons（app/docker/addons，含 idx_aidev_sso 免密登入模組）：必須掛進「每個」測試區並列入
// addons-path，否則平台簽發 token 導向的 /aidev/sso 端點在測試區根本不存在。與專案 repo 分開（固定容器
// 路徑 _platform，不與 addonsMounts 的 basename 命名衝突），唯讀掛載。host 路徑由本檔位置推導
// （app/server/lib → app/docker/addons），不寫死絕對路徑。
const PLATFORM_ADDONS_HOST = path.resolve(__dirname, '..', '..', 'docker', 'addons');
const PLATFORM_ADDONS_CONTAINER = `${EXTRA_ADDONS_ROOT}/_platform`;

// 企業版 addons 的固定容器掛載點：與專案 repo 的 /mnt/extra-addons/<basename> 分開，避免和 basename
// 撞名；固定路徑讓 addons-path 的「專案自訂 → enterprise → 核心」順序可預期。
const ENTERPRISE_CONTAINER_DIR = '/mnt/enterprise';

// 跳脫 regex 特殊字元，供 dbfilter 把 dbName 當純字面比對（而非 pattern）用。
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 大版本數字：'17.0'→'17'、17→'17'（取第一段的數字，避免 '17.0' 變成 '170'）。
function majorDigits(major) {
  return String(major).split('.')[0].replace(/\D/g, '');
}

// 平台自建的 odoo+chromium image 標籤（FROM odoo:<major> + chromium，供 tour 用）。
function imageTagFor(major) {
  return `odoo-idx:${majorDigits(major) || 'latest'}`;
}

// image 上記錄「內建了哪些相依」的兩個 label。判「要不要重 build」一律比對 idx.deps 這個內容指紋，
// 不可只看 image 存不存在——早退會讓「改了相依清單／Dockerfile」毫無效果（同一個坑在 vpn-gateway
// 的 entrypoint.sh 上踩過一次：九關程式碼審查全綠但實機完全無效）。
const DEPS_LABEL = 'idx.deps';
const PIP_LABEL = 'idx.pip'; // 'image'＝相依已預裝進 image；'fallback'＝預裝失敗、退回容器層 pip

// 相依內容指紋：pip 清單（去重排序）＋ Dockerfile 全文一起雜湊，同一份輸入恆得同一值。
// Dockerfile 全文也要進來：系統套件（unixodbc／FreeTDS）寫死在 Dockerfile，只改它而指紋不變的話
// 舊 image 會被當成已是最新。用「內容雜湊」而非人工維護的版號，是因為人工 bump 必然有忘記的一天。
function depsFingerprint(pipPkgs = [], dockerfileText = '') {
  const list = normalizePkgs(pipPkgs);
  return crypto.createHash('sha256')
    .update(`${String(dockerfileText)}\0${list.join(' ')}`)
    .digest('hex').slice(0, 16);
}

function normalizePkgs(pkgs) {
  return [...new Set((pkgs || []).map(s => String(s).trim()).filter(Boolean))].sort();
}

// 容器名：固定前綴 + 專案目錄名（清成 docker 允許的字元 [a-zA-Z0-9_.-]）。
// 純非 ASCII 的名稱（如「凌越生醫」——folder_name 留空時 dirName 會拿 name 當值）整串被換成 `-`
// 再被剝光成空字串，舊版一律 fallback 到固定的 'env'，於是**所有純中文專案塌縮成同一個
// odoo-test-env**。而建立環境的第一步就是 removeContainer(同名)，第二個中文專案一啟動就會直接
// 砍掉第一個正在跑的容器，DB 卻仍記 running——症狀是「測試區突然變空白」，完全不指向命名。
// fallback 改用 project id 保證唯一；未帶 projectId 的呼叫端維持原本的 'env'，語意不變。
function containerNameFor(dirName, projectId) {
  const safe = String(dirName || '').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[-.]+/, '');
  if (safe) return `odoo-test-${safe}`;
  return `odoo-test-${projectId ? `p${projectId}` : 'env'}`;
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
  return [PLATFORM_ADDONS_CONTAINER, ...(mounts || []).map(m => m.container), CORE_ADDONS].join(',');
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
    // 平台自帶 addons（含 idx_aidev_sso 免密登入模組）：唯讀掛入每個測試區，並由 containerAddonsPath 列入 addons-path。
    '-v', `${PLATFORM_ADDONS_HOST}:${PLATFORM_ADDONS_CONTAINER}:ro`,
    // filestore（ir.attachment 二進位，含 asset bundle）持久化到宿主：容器是拋棄式的、會被 rm+run 重建，
    // 若 filestore 留在匿名 volume 會隨重建遺失，但宿主 DB 的 attachment 記錄還在 → asset 檔不見、每個
    // asset 請求 500。綁到宿主目錄讓它與 DB 同樣持久（rw，Odoo 需寫入）。未指定則沿用容器預設 volume。
    ...(filestoreDir ? ['-v', `${filestoreDir}:/var/lib/odoo/filestore`] : []),
    // DB 連線走 entrypoint env（見 dbEnvFlags）；-d／--addons-path 仍走 CLI（entrypoint 不碰）。
    ...dbEnvFlags(dbArgs),
    image, 'odoo',
    '--http-port=8069', '--http-interface=0.0.0.0',
    // 反代模式：信任 nginx 送的 X-Forwarded-Proto/Host，否則 Odoo 認連線為 http、
    // 產絕對 redirect 用 http:// → 打到只收 TLS 的 nginx port 回 400。直連模式無 X-Forwarded-*
    // 標頭故不受影響（Odoo 用真實值）。前提：後端埠只有 nginx 連得到（綁 docker0 + VPN/白名單）。
    '--proxy-mode',
    // hardening：關未認證 DB 列舉、鎖此容器只認自己的 DB（Odoo CLI 選項名為 --db-filter，
    // 非 config 檔的 dbfilter；master 密碼 admin_passwd 無對應 CLI，且 list_db=False 已關管理介面故不設）。
    '--no-database-list', `--db-filter=^${escapeRegExp(dbName)}$`,
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
      // timedOut 是「我方主動砍掉」與「指令自己非 0 結束」的唯一區別（兩者 code 都可能是 null）。
      // 呼叫端據此標 err.killed——deploy 的「逾時重試無益，直接停等人工」守衛只認那一欄。
      done({ code: null, timedOut: true, stdout, stderr: stderr + `\n[docker] 逾時（${Math.round(timeoutMs / 1000)}s）` });
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

// 跑一次 docker CLI，只關心成敗。預設走非同步 execFile：`docker desktop start` 這類指令會等到
// 引擎就緒才回（最長 DOCKER_START_TIMEOUT_SEC），用 execFileSync 會把整個 Node 事件迴圈凍住
// ——平台是單進程常駐，那段期間所有 HTTP 請求、cron、pipeline 全部停擺（最壞 start+restart 兩
// 輪＝約 4 分鐘）。
// deps.execFile（非同步）優先；deps.execFileSync 是 legacy 注入路徑，僅為既有呼叫端
//（lib/vpn-gateway.js 及其測試以同步 mock 注入 deps）保留，不片面更動它們的契約。
function dockerCli(deps, args, timeoutMs) {
  if (!deps.execFile && deps.execFileSync) {
    let ok = true;
    try { deps.execFileSync('docker', args, { stdio: 'ignore' }); } catch { ok = false; }
    return Promise.resolve(ok);
  }
  const execFile = deps.execFile || realExecFile;
  return new Promise((resolve) => {
    execFile('docker', args, { windowsHide: true, timeout: timeoutMs }, (err) => resolve(!err));
  });
}

// Docker Desktop（Windows）裝好但引擎沒啟動時，背景幫使用者把引擎起來，省得每次操作都要
// 先手動開 Docker Desktop。用官方 `docker desktop start`：背景起引擎、不跳 GUI 視窗，且不帶
// -d 時會同步等到引擎就緒才回（--timeout 設上限）；比啟動 Docker Desktop.exe 乾淨（不開視窗、
// 不需寫死安裝路徑）。非 Windows（如未來的共用 Linux 主機，Docker 通常已是常駐服務）直接回錯，
// 交由環境本身管理 daemon 生命週期。daemon 已在跑則直接回、不啟動。
//
// 陷阱：Docker Desktop「App 外殼在跑、但 Linux 引擎（WSL2 的 docker-desktop distro）停了」時，
// `docker desktop start` 只看外殼、會秒回 "already running" 卻不去把停掉的引擎拉回來 → daemon 仍不通。
// 故 start 後再探一次，若仍不通就改用 `docker desktop restart` 強制整個後端重拉（restart 較重，只在
// start 救不回來時才動）；再不通才 fail loud，代表 WSL2 distro 可能已損壞，非平台可解、交回使用者。
async function ensureDockerRunning(deps = {}) {
  const platform = deps.platform || process.platform;
  const T = String(DOCKER_START_TIMEOUT_SEC);
  // 指令自身的等待上限已由 --timeout 控制；外層再給 30 秒緩衝，避免 CLI 卡死時這個 Promise 永不 settle。
  const cliTimeoutMs = (DOCKER_START_TIMEOUT_SEC + 30) * 1000;
  const daemonUp = () => dockerCli(deps, ['info'], 20000);

  if (await daemonUp()) return;

  if (platform !== 'win32') {
    throw new Error('Docker 引擎未啟動，請手動啟動 Docker 服務');
  }

  // start 指令失敗／逾時／舊版無此子指令都不特別處理 → 下方再確認一次 daemon，仍不通就走 restart 退回
  await dockerCli(deps, ['desktop', 'start', '--timeout', T], cliTimeoutMs);
  if (await daemonUp()) return;

  // 走到這＝start 沒能把引擎拉起來（含「already running」但 WSL2 引擎停掉的情況）→ 強制重拉後端
  await dockerCli(deps, ['desktop', 'restart', '--timeout', T], cliTimeoutMs);
  if (await daemonUp()) return;

  throw new Error('Docker 引擎啟動失敗：Docker Desktop 在跑但 Linux 引擎拉不起來，請手動重啟或重裝 Docker Desktop');
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

// 讀 image 上的相依 label。image 不存在或沒有 label 都回空字串（→ 視為需要 build）。
async function imageDepsLabels(tag, deps = {}) {
  const fmt = `{{index .Config.Labels "${DEPS_LABEL}"}}|{{index .Config.Labels "${PIP_LABEL}"}}`;
  const { code, stdout } = await runDocker(['image', 'inspect', '-f', fmt, tag], deps);
  if (code !== 0) return { fingerprint: '', pip: '' };
  const clean = v => { const s = String(v || '').trim(); return s === '<no value>' ? '' : s; };
  const [f, p] = String(stdout).trim().split('|');
  return { fingerprint: clean(f), pip: clean(p) };
}

// 退回容器層 pip 時的警告：這顆 image 沒有內建相依，容器一被 rm 就會再次缺件（見 env-agent 的
// initArgs 註解）。每次建環境都要重申，不能因為「指紋相符不用 build」就再也看不到。
const FALLBACK_WARN = '[image] ⚠️ 本 image 未內建 Python 相依（預裝曾失敗），改由容器層 pip 補裝——容器一被移除就會再次缺件\n';

// 建平台自建 image（odoo-idx:<major> ＝ FROM odoo:<major> + chromium + 相依）。
// pipPkgs＝全平台所有專案宣告的 Python 相依聯集，預裝進 image 讓它不隨容器消失。
// contextDir 需含 Dockerfile.odoo。回傳 { ok, log }。
async function ensureImage(major, contextDir, opts = {}, deps = {}) {
  const pipPkgs = normalizePkgs(opts.pipPkgs);
  const tag = imageTagFor(major);
  const dockerfile = path.join(contextDir, 'Dockerfile.odoo');
  let dockerfileText = '';
  try { dockerfileText = fs.readFileSync(dockerfile, 'utf8'); } catch { /* 讀不到就交給 build 報錯 */ }
  const want = depsFingerprint(pipPkgs, dockerfileText);
  const cur = await imageDepsLabels(tag, deps);
  if (cur.fingerprint === want) {
    return { ok: true, log: `[image] ${tag} 已存在\n` + (cur.pip === 'fallback' ? FALLBACK_WARN : '') };
  }
  // 兩次 build 都標同一個指紋：退回產生的 image 也要能被認成「已是最新」，否則每次建環境都要
  // 白付一次 30 分鐘 build。「有沒有內建相依」改由 PIP_LABEL 表達。
  const build = (pkgs, pipMode) => runDocker(
    ['build', '-t', tag,
      '--build-arg', `ODOO_MAJOR=${majorDigits(major)}`,
      '--build-arg', `PIP_PKGS=${pkgs.join(' ')}`,
      '--label', `${DEPS_LABEL}=${want}`,
      '--label', `${PIP_LABEL}=${pipMode}`,
      '-f', dockerfile, contextDir],
    { timeoutMs: 1800000, ...deps } // image build 較久（首次 pull base + apt install），放寬到 30 分
  );

  const first = await build(pipPkgs, 'image');
  if (first.code === 0) return { ok: true, log: `[image] build ${tag} OK（預裝 ${pipPkgs.length} 個 Python 相依）\n` };

  // 預裝失敗不得讓「全平台都建不了測試區」——某個專案宣告一個裝不動的套件是遲早的事。退回現行的
  // 容器層 pip 路徑（installModuleRequirements 照跑），但真因要留在 setup_log 裡，不得靜默降級。
  const why = `${first.stderr || first.stdout || ''}`.slice(-800);
  if (!pipPkgs.length) return { ok: false, log: `[image] build ${tag} 失敗\n${why}` };
  const second = await build([], 'fallback');
  if (second.code !== 0) return { ok: false, log: `[image] build ${tag} 失敗\n${why}` };
  return { ok: true, log: `[image] build ${tag} OK，但相依預裝失敗、已退回容器層 pip：\n${why}\n` };
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

// 重啟常駐容器（沿用建立時的 CMD，含 -i idx_aidev_sso）。用途只有一個：模組的 Python 相依是
// 容器起來後才用 execPipInstall 補的，補之前啟動的常駐進程 registry 已載入失敗、-i 被回滾；
// 而 execOdoo 另起進程去裝只會寫進 DB，常駐進程仍沒 import 過該模組的 controllers → route 照樣
// 404（見 env-agent.js 的 initArgs 註解）。唯有重啟常駐進程才會既裝上又 import。
async function restartContainer(name, deps = {}) {
  return runDocker(['restart', '-t', '10', name], deps);
}

// 刪除宿主上的環境目錄。Odoo 在容器內是以 image 內建的 odoo user（uid 101）寫 filestore／sessions，
// 產出的檔案與目錄屬於那個 uid 且是 755——平台進程（非 root、uid 由部署決定）遞迴刪到裡面必吃
// EACCES，整個「刪除環境」500 收場，只留下孤兒 filestore 佔著磁碟，而 stopEnv 早已把容器與 port
// 收乾淨、DB 也標回 idle，狀態就此不一致。退路是借一個 root 容器把目錄刪掉：平台本來就依賴
// docker（容器都是它起的），不新增基礎設施。image 可用 env 覆蓋以配合離線／私有 registry 的機器。
const ROOT_RM_IMAGE = process.env.DOCKER_ROOT_RM_IMAGE || 'alpine:3';

// 掛 parent 而非 dir 本身：掛載點自己刪不掉（會變成清空內容但目錄還在）。
function buildRootRmArgs(dir, image = ROOT_RM_IMAGE) {
  return ['run', '--rm', '-v', `${path.dirname(dir)}:/target`, image, 'rm', '-rf', `/target/${path.basename(dir)}`];
}

// 呼叫端須自行確認 dir 落在允許的根目錄下（env-routes 的 DELETE 已做 path.resolve 前綴檢查）——
// 這裡會用 root 權限刪整棵樹，不做二次判斷但也絕不接受未驗證的路徑。
async function removeDirForce(dir, deps = {}) {
  const fsMod = deps.fs || fs;
  if (!fsMod.existsSync(dir)) return { removed: false, viaDocker: false };
  try {
    fsMod.rmSync(dir, { recursive: true, force: true });
    return { removed: true, viaDocker: false };
  } catch (err) {
    // 只有權限類錯誤才值得動用 root 容器；ENOTEMPTY／EBUSY 等是別的毛病，掩蓋掉會更難查。
    if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    const { code, stderr } = await runDocker(buildRootRmArgs(dir), deps);
    if (code !== 0) throw new Error(`${dir} 權限不足無法刪除，root 容器退路也失敗：${stderr || `exit ${code}`}`);
    // rm -rf 對「刪不掉」有時只在 stderr 抱怨仍回 0，實際確認才算數（fail loud）。
    if (fsMod.existsSync(dir)) throw new Error(`${dir} 已試過 root 容器退路，目錄仍然存在`);
    return { removed: true, viaDocker: true };
  }
}

// 「刪除環境」時要保住的子項：filestore 是 ir.attachment 的二進位本體，與宿主 DB 裡的 attachment
// 記錄是同一份資料的兩半。平台從不 drop 任何 Odoo DB（全 repo 查無 DROP DATABASE），所以 DB 一定
// 留著——filestore 一旦跟著目錄被砍，重建後每一筆 attachment 都指向不存在的檔案：asset bundle 與
// 使用者頭像全數 500，而 DB 資料看起來好好的，完全指不向「是刪除環境造成的」。
// 2026-08-24 萊峰19 就是這樣丟掉 634 個檔（不可回復）。要改成「連 DB 一起刪」是另一個產品決策，
// 在那之前這兩者必須同生共死。
const ENV_DIR_KEEP = ['filestore'];

// 刪除環境目錄的內容，但保留 ENV_DIR_KEEP。逐項刪而非整棵刪：標記檔（.docker-ready／.ready）要清掉
// 才會重新走建置流程，filestore 則必須原地留著。
async function removeEnvDir(dir, deps = {}) {
  const fsMod = deps.fs || fs;
  if (!fsMod.existsSync(dir)) return { removed: false, kept: [] };
  const kept = [];
  for (const entry of fsMod.readdirSync(dir)) {
    if (ENV_DIR_KEEP.includes(entry)) { kept.push(entry); continue; }
    await removeDirForce(path.join(dir, entry), deps);
  }
  return { removed: true, kept };
}

// 抓容器 log（供前端「查看 log」）。tail 限制行數避免無上限。
async function containerLogs(name, { tail = 2000 } = {}, deps = {}) {
  const { stdout, stderr } = await runDocker(['logs', '--tail', String(tail), name], deps);
  return `${stdout || ''}${stderr || ''}`;
}

module.exports = {
  // 純函式（單測用）
  imageTagFor, depsFingerprint, majorDigits, containerNameFor, remapDbHostForContainer, addonsMounts,
  containerAddonsPath, odooDbAddonsArgs, dbEnvFlags, buildRunArgs, buildExecArgs, buildRootRmArgs,
  // 低階 IO
  runDocker, dockerAvailable, ensureDockerRunning,
  imageExists, containerExists, containerRunning,
  // 生命週期
  ensureImage, runContainer, execOdoo, execPipInstall, stopContainer, removeContainer, restartContainer, containerLogs, removeEnvDir,
  removeDirForce,
  // 常數
  CORE_ADDONS, EXTRA_ADDONS_ROOT, PLATFORM_ADDONS_HOST, PLATFORM_ADDONS_CONTAINER,
  ENTERPRISE_CONTAINER_DIR,
};
