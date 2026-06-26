const net = require('net');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { query } = require('../db');

function execCmd(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function findFreePort(start = 8069) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on('error', () => resolve(findFreePort(start + 1)));
    server.listen(start, () => { server.close(() => resolve(start)); });
  });
}

async function runEnvSetup(projectId) {
  const { rows: [project] } = await query(
    'SELECT name, folder_name, odoo_version FROM projects WHERE id = $1',
    [projectId]
  );
  if (!project) return;

  const { rows: [primaryRepo] } = await query(
    'SELECT local_path FROM project_repos WHERE project_id=$1 AND is_primary=true LIMIT 1',
    [projectId]
  );

  const port = await findFreePort(8069);
  const major = (project.odoo_version || '17.0').split('.')[0];
  const baseDir = process.env.ODOO_ENV_BASE || '/opt/odoo-envs';
  const dirName = project.folder_name || project.name;
  const envDir = `${baseDir}/${dirName}`;
  const srcDir = `${envDir}/src`;
  const venvBin = `${envDir}/venv/bin`;
  const odooBin = `${srcDir}/odoo-bin`;
  const dbName = `test_${project.name}`;
  const extraAddons = primaryRepo?.local_path || null;
  const addonsPath = extraAddons ? `${srcDir}/addons,${extraAddons}` : `${srcDir}/addons`;

  await query(
    `INSERT INTO odoo_envs (project_id, status, port, updated_at)
     VALUES ($1, 'setting_up', $2, NOW())
     ON CONFLICT (project_id) DO UPDATE SET status='setting_up', error_msg=NULL, setup_log=NULL, port=$2, updated_at=NOW()`,
    [projectId, port]
  );

  // venv always created with python3, so python3 binary is guaranteed to exist in venv/bin
  const venvPython = `${venvBin}/python3`;

  const steps = [
    ...(!fs.existsSync(srcDir) ? [
      { name: 'clone', bin: 'git', args: ['clone', 'https://github.com/odoo/odoo.git', '--branch', `${major}.0`, '--depth=1', srcDir] }
    ] : []),
    { name: 'venv', bin: 'python3', args: ['-m', 'venv', '--clear', '--copies', `${envDir}/venv`] },
    { name: 'pip',  bin: venvPython, args: ['-m', 'pip', 'install', '--upgrade', 'pip'] },
    { name: 'pip-req', bin: venvPython, args: ['-m', 'pip', 'install', '-r', `${srcDir}/requirements.txt`] },
    { name: 'init', bin: venvPython, args: [odooBin, '-d', dbName, '--stop-after-init', '-i', 'base', '--without-demo=all', '--addons-path', addonsPath] },
  ];

  let log = '';
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

  const child = spawn(venvPython, [odooBin, '-d', dbName, `--http-port=${port}`, '--addons-path', addonsPath], {
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

module.exports = { runEnvSetup, stopEnv, nightlyShutdown };
