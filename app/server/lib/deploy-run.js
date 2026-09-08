// 單次部署的執行器。
//
// 所有外部依賴（git、SFTP、SSH）都從 deps 注入，測試才餵得進假的——這支要驗的是
// 「判成敗、決定回不回滾」那段邏輯，SSH 本身不是。
const path = require('path');
const { query } = require('../db');
const { maskSecrets } = require('./log-parse');
const { sshExec } = require('./ssh-exec');
const {
  pickModules, buildUpgradeCmd, buildRestartCmd, buildHealthCmd, buildSwapCmd, buildRollbackCmd,
} = require('./deploy-cmd');

// EXITCODE= 是 buildUpgradeCmd 自己 echo 進 log 的。取最後一個：log 內容可能剛好含這串，
// 我們寫的那個永遠在最後。
// 不能改看 ssh 那層的 code——那是整串指令的碼（最後一條是 cat，必定為 0）。
function readExitCode(stdout) {
  const all = [...String(stdout || '').matchAll(/^EXITCODE=(-?\d+)$/gm)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

// 時間戳只當目錄名用，格式固定成 IDENT_RE 過得了的樣子（不含冒號與連字號以外的符號）
function stampNow() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}

async function runDeploy(targetId, { trigger, taskId = null, userId = null }, deps = {}) {
  const { rows: [t] } = await query('SELECT * FROM project_deploy_targets WHERE id = $1', [targetId]);
  if (!t) return { ok: false, error: '找不到部署目標' };

  const git = deps.git || defaultGit(t);
  const exec = deps.exec || sshExec;
  const upload = deps.upload || defaultUpload;

  let toSha, changed;
  try {
    toSha = await git.headSha(t.branch);
    changed = t.last_deployed_sha ? await git.changedPaths(t.last_deployed_sha, toSha) : [];
  } catch (e) {
    return { ok: false, error: `取不到分支 ${t.branch} 的狀態：${e.message}` };
  }
  const modules = pickModules(changed, t.modules, t.last_deployed_sha);

  const { rows: [run] } = await query(
    `INSERT INTO deploy_runs (target_id, task_id, triggered_by, trigger, from_sha, to_sha, modules, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running') RETURNING id`,
    [targetId, taskId, userId, trigger, t.last_deployed_sha, toSha, modules]
  );

  // 沒有模組要動 ＝ 成功，且完全不連遠端。這不是失敗，別讓它變紅燈。
  if (!modules.length) {
    await query("UPDATE deploy_runs SET status='success', finished_at=NOW(), log=$2 WHERE id=$1",
      [run.id, '本次沒有屬於此目標的模組變更，略過']);
    return { ok: true, runId: run.id, status: 'success', modules: [] };
  }

  const { loadDecryptedConn } = require('./db-connections');
  const conn = await loadDecryptedConn(t.conn_id, t.project_id);
  if (!conn) {
    await query("UPDATE deploy_runs SET status='failed', finished_at=NOW(), log=$2 WHERE id=$1",
      [run.id, '這個部署目標的連線設定已不存在，請重新評估']);
    return { ok: false, runId: run.id, status: 'failed', modules, error: '連線設定已不存在' };
  }

  let target = conn;
  if (conn.vpn_enabled) {
    const { ensureGatewayRunning } = require('./vpn-gateway');
    try { await ensureGatewayRunning(conn.vpn); }
    catch (e) {
      await query("UPDATE deploy_runs SET status='failed', finished_at=NOW(), log=$2 WHERE id=$1",
        [run.id, `[VPN] ${e.message}`]);
      return { ok: false, runId: run.id, status: 'failed', modules, error: `[VPN] ${e.message}` };
    }
    target = { ...conn, ssh_host: '127.0.0.1', ssh_port: conn.vpn_forward_port };
  }

  const ts = stampNow();
  let logBuf = '';
  const say = (s) => { if (s) logBuf += String(s).replace(/\s+$/, '') + '\n'; };

  async function finish(status, error) {
    // 客戶 conf 內是明碼密碼，Odoo 啟動時會印出來——寫進 DB 之前一定要遮
    await query('UPDATE deploy_runs SET status=$2, log=$3, finished_at=NOW() WHERE id=$1',
      [run.id, status, maskSecrets(logBuf)]);
    return { ok: status === 'success', runId: run.id, status, modules, error };
  }

  try {
    say(`[DEPLOY] ${t.env} / ${modules.join(', ')} / ${t.last_deployed_sha || '(初次)'} → ${toSha}`);

    // 1. 平台端打包，逐模組送上去（SFTP 不經 shell，檔名注入不成立）
    for (const m of modules) {
      const tar = await git.archive(toSha, m);
      await upload(target, tar, `${t.addons_dir}/.deploy-staging/${m}.tgz`);
    }

    // 2. 解檔 + 原子替換
    const swap = await exec(target, buildSwapCmd(t, modules, ts));
    say(swap.stdout); say(swap.stderr);

    // 3. 升級（含重啟）
    const upg = await exec(target, buildUpgradeCmd(t, conn, modules));
    say(upg.stdout); say(upg.stderr);
    const rc = readExitCode(upg.stdout);
    if (rc !== 0) throw new Error(`模組升級失敗（EXITCODE=${rc === null ? '讀不到' : rc}）`);

    // 4. 健康檢查
    const hc = await exec(target, buildHealthCmd(t));
    say(hc.stdout);
    if (!/HEALTH_OK/.test(hc.stdout)) throw new Error('健康檢查未通過，服務沒有回來');

    await query('UPDATE project_deploy_targets SET last_deployed_sha=$2, updated_at=NOW() WHERE id=$1',
      [targetId, toSha]);
    say('[DEPLOY] 完成');
    return await finish('success');
  } catch (err) {
    say(`[FAIL] ${err.message}`);
    // 回滾只還原檔案。資料庫的改動留在原地——沒有備份（使用者裁決），這是已知取捨。
    try {
      const rb = await exec(target, buildRollbackCmd(t, modules, ts));
      say(rb.stdout); say(rb.stderr);
      const rs = await exec(target, buildRestartCmd(t, conn));
      say(rs.stdout); say(rs.stderr);
      say('[ROLLBACK] 檔案已還原並重啟；資料庫的改動未還原');
    } catch (e2) {
      say(`[ROLLBACK-FAIL] ${e2.message}`);
    }
    return await finish('rolled_back', err.message);
  }
}

// --- 真實依賴（測試一律注入假的，不會走到這裡）---

function defaultGit(t) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const pExecFile = promisify(execFile);
  const repoPath = () => query('SELECT local_path FROM project_repos WHERE id = $1', [t.repo_id])
    .then(r => (r.rows[0] && r.rows[0].local_path) || null);

  return {
    async headSha(branch) {
      const cwd = await repoPath();
      if (!cwd) throw new Error('這個部署目標沒有對應的 repo');
      await pExecFile('git', ['-C', cwd, 'fetch', 'origin', branch]);
      const { stdout } = await pExecFile('git', ['-C', cwd, 'rev-parse', `origin/${branch}`]);
      return stdout.trim();
    },
    async changedPaths(from, to) {
      const cwd = await repoPath();
      const { stdout } = await pExecFile('git', ['-C', cwd, 'diff', '--name-only', `${from}..${to}`]);
      return stdout.split('\n').map(s => s.trim()).filter(Boolean);
    },
    async archive(sha, module) {
      const cwd = await repoPath();
      // 參數陣列傳入，模組名不經 shell 拼接
      const { stdout } = await pExecFile('git',
        ['-C', cwd, 'archive', '--format=tar.gz', sha, '--', module],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      return stdout;
    },
  };
}

// SFTP 上傳。走 ssh2 的 sftp 通道，檔名不經 shell。
function defaultUpload(conn, buffer, remotePath) {
  const { Client } = require('ssh2');
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => {
      c.sftp((err, sftp) => {
        if (err) { c.end(); return reject(err); }
        const dir = path.posix.dirname(remotePath);
        // mkdir -p 的等價：逐層建，已存在的忽略
        const parts = dir.split('/').filter(Boolean);
        let acc = '';
        const next = (i) => {
          if (i >= parts.length) {
            const ws = sftp.createWriteStream(remotePath);
            ws.on('close', () => { c.end(); resolve(); });
            ws.on('error', (e) => { c.end(); reject(e); });
            ws.end(buffer);
            return;
          }
          acc += '/' + parts[i];
          sftp.mkdir(acc, () => next(i + 1));   // 已存在時的錯誤刻意忽略
        };
        next(0);
      });
    }).on('error', reject);
    const cfg = { host: conn.ssh_host, port: conn.ssh_port || 22, username: conn.ssh_user, readyTimeout: 20000 };
    if (conn.auth_type === 'key' && conn.ssh_key) cfg.privateKey = Buffer.from(conn.ssh_key, 'utf8');
    else cfg.password = conn.ssh_password;
    c.connect(cfg);
  });
}

module.exports = { runDeploy, readExitCode };
