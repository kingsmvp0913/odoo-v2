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

function execCmd(bin, args) {
  return new Promise((resolve, reject) => {
    // maxBuffer 預設僅 1MB，Odoo 升級 log 超過會以 maxBuffer exceeded 假失敗
    execFile(bin, args, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // 保留完整診斷：只留 stderr 的話，「幾秒就死、stderr 只有 banner」的失敗會無從鑑識（健檢根因 C）
        const e = new Error(stderr || err.message);
        e.exitCode = err.code; e.killed = !!err.killed; e.stdout = stdout; e.stderr = stderr;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}

// 與 execCmd 相同，但把 input 餵進 stdin（execFile 非同步版不支援 input）
function execWithStdin(bin, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
    child.stdin.write(input);
    child.stdin.end();
  });
}

// 探測埠是否真的接受連線（Odoo 已 listen）。逾時內反覆重試，最終回 true/false。
// 用於啟動後健康檢查：Odoo spawn 後需數秒載入才 listen，唯有實測連得上才算「running」，
// 否則 process 崩了卻標 running（stale running）→ 死掉的 URL 被餵給 E2E 卻永遠好不了。
function waitForPort(port, timeoutMs = 90000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
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

// 專案所有已 clone 完成的 repo 路徑，全部掛進 addons-path（primary 優先，不依賴是否勾選 primary）
async function projectAddonsPaths(projectId) {
  const { rows } = await query(
    "SELECT local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [projectId]
  );
  return rows.map(r => r.local_path);
}

async function runEnvSetup(projectId) {
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
  const systemPython = process.env.PYTHON_BIN || (isWin ? 'python' : 'python3');
  // 完整建置成功後寫入；存在即代表 clone/venv/pip/init 都已完成，停止後可直接快速啟動
  const readyMarker = path.join(envDir, '.ready');

  await query(
    `INSERT INTO odoo_envs (project_id, status, port, updated_at)
     VALUES ($1, 'setting_up', $2, NOW())
     ON CONFLICT (project_id) DO UPDATE SET status='setting_up', error_msg=NULL, setup_log=NULL, port=$2, updated_at=NOW()`,
    [projectId, port]
  );

  const steps = [
    ...(!fs.existsSync(srcDir) ? [
      { name: 'clone', bin: 'git', args: ['clone', 'https://github.com/odoo/odoo.git', '--branch', `${major}.0`, '--depth=1', srcDir] }
    ] : []),
    { name: 'venv', bin: systemPython, args: ['-m', 'venv', '--clear', '--copies', venvDir] },
    { name: 'pip',  bin: venvPython, args: ['-m', 'pip', 'install', '--upgrade', 'pip'] },
    { name: 'pip-req', bin: venvPython, args: ['-m', 'pip', 'install', '-r', path.join(srcDir, 'requirements.txt')] },
    { name: 'init', bin: venvPython, args: [odooBin, '-d', dbName, '--stop-after-init', '-i', 'base', '--without-demo=all', '--load-language=zh_TW', '--addons-path', addonsPath, ...odooDbArgs()] },
  ];

  // 停止後再啟動：偵測到既有 .ready 標記與 venv，跳過整套建置，只重新啟動 process
  const alreadyBuilt = fs.existsSync(readyMarker) && fs.existsSync(venvPython);

  let log = '';
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
  const child = spawn(serverPython, [odooBin, '-d', dbName, `--http-port=${port}`, '--http-interface=0.0.0.0', '--addons-path', addonsPath, ...odooDbArgs()], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true  // 背景運行，不另開 Windows 主控台視窗（pythonw 為主要手段，此為輔）
  });
  // detached/unref 的子行程，仍會在父程序存活期間送出 exit 事件；用來偵測「啟動即崩」。
  let earlyExit = null;
  child.once('exit', (code, sig) => { earlyExit = { code, sig }; });
  child.unref();
  const pid = child.pid || null;

  // 啟動後健康檢查：探測埠真的 listen（或偵測到 process 提早結束）才標 running。
  // 逾時／崩潰 → 標 error（非 running），避免 stale running 把死掉的 URL 交給 E2E（本次事故根因）。
  const healthy = await waitForPort(port);
  if (earlyExit || !healthy) {
    const reason = earlyExit
      ? `Odoo process 啟動後隨即結束（exit=${earlyExit.code}${earlyExit.sig ? `/${earlyExit.sig}` : ''}）`
      : `Odoo 啟動逾時：90 秒內埠 ${port} 未進入監聽`;
    log += `[start] PID=${pid} port=${port} → 健康檢查失敗：${reason}\n`;
    try { if (pid) process.kill(pid, 'SIGTERM'); } catch {}
    await query(
      "UPDATE odoo_envs SET status='error', pid=NULL, url=NULL, error_msg=$2, setup_log=$3, updated_at=NOW() WHERE project_id=$1",
      [projectId, reason, log]
    );
    return;
  }
  log += `[start] PID=${pid} port=${port} 健康檢查通過\n`;

  await query(
    "UPDATE odoo_envs SET status='running', pid=$2, port=$3, url=$4, setup_log=$5, updated_at=NOW() WHERE project_id=$1",
    [projectId, pid, port, `http://${envHost}:${port}`, log]
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
async function upgradeModules(projectId, modules) {
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
  const out = await execCmd(venvPython, [odooBin, ...modFlags, '-d', dbName, '--stop-after-init', '--addons-path', addonsPath, ...odooDbArgs()]);
  return { ok: true, log: out };
}

async function stopEnv(projectId) {
  const { rows: [env] } = await query('SELECT pid FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (!env) return;
  if (env.pid) {
    try { process.kill(env.pid, 'SIGTERM'); } catch {}
  }
  await query(
    "UPDATE odoo_envs SET status='idle', pid=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
    [projectId]
  );
}

async function nightlyShutdown() {
  const { rows } = await query("SELECT project_id, pid FROM odoo_envs WHERE status='running'");
  for (const env of rows) {
    // 跳過使用中的 env：該專案有任務正在 deploy_testing／playwright_running，
    // 砍了會讓 deploy/E2E 中途死掉被誤歸因為程式問題（健檢：夜間 shutdown 誤歸因）
    const { rows: [busy] } = await query(
      "SELECT 1 FROM tasks WHERE project_id=$1 AND status IN ('deploy_testing','playwright_running') AND is_paused=false AND is_hidden=false LIMIT 1",
      [env.project_id]
    );
    if (busy) continue;
    if (env.pid) {
      try { process.kill(env.pid, 'SIGTERM'); } catch {}
    }
    await query(
      "UPDATE odoo_envs SET status='idle', pid=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
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

module.exports = { runEnvSetup, upgradeModules, stopEnv, syncUsers, nightlyShutdown, seedOdooUsers, envIsActive, cleanupProjectEnv, waitForPort, ENV_BASE };
