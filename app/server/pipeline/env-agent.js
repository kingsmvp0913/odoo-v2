const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { query } = require('../db');
const { ensureTestingBranch } = require('./git');

// 測試環境一律建在專案內 odoo-v2/odoo-envs（比照 REPOS_BASE 慣例），不得跑到專案外
const ENV_BASE = process.env.ODOO_ENV_BASE || path.resolve(__dirname, '..', '..', '..', 'odoo-envs');

function execCmd(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// 與 execCmd 相同，但把 input 餵進 stdin（execFile 非同步版不支援 input）
function execWithStdin(bin, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
    child.stdin.write(input);
    child.stdin.end();
  });
}

function findFreePort(start = 8069) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on('error', () => resolve(findFreePort(start + 1)));
    server.listen(start, () => { server.close(() => resolve(start)); });
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
    'SELECT name, folder_name, odoo_version FROM projects WHERE id = $1',
    [projectId]
  );
  if (!project) return;

  const port = await findFreePort(8069);
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

  const child = spawn(venvPython, [odooBin, '-d', dbName, `--http-port=${port}`, '--addons-path', addonsPath, ...odooDbArgs()], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  const pid = child.pid || null;
  log += `[start] PID=${pid} port=${port}\n`;

  await query(
    "UPDATE odoo_envs SET status='running', pid=$2, port=$3, url=$4, setup_log=$5, updated_at=NOW() WHERE project_id=$1",
    [projectId, pid, port, `http://localhost:${port}`, log]
  );
}

// 把本系統 users 全部建立/更新到 Odoo res.users，設為管理員（base.group_system）。
// password 直接寫入本系統的 pbkdf2_sha512 hash（與 Odoo passlib 相容），達成密碼互通。
async function seedOdooUsers({ venvPython, odooBin, dbName, addonsPath }) {
  const { rows: users } = await query(
    'SELECT username AS login, display_name AS name, password_hash AS password FROM users ORDER BY id'
  );
  if (!users.length) return '[seed] 無使用者可同步\n';
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
  const out = await execCmd(venvPython, [odooBin, '-u', modArg, '-d', dbName, '--stop-after-init', '--addons-path', addonsPath, ...odooDbArgs()]);
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

module.exports = { runEnvSetup, upgradeModules, stopEnv, syncUsers, nightlyShutdown, seedOdooUsers, envIsActive, cleanupProjectEnv, ENV_BASE };
