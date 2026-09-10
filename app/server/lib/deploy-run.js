// 單次部署的執行器。
//
// 所有外部依賴（git、SFTP、SSH）都從 deps 注入，測試才餵得進假的——這支要驗的是
// 「判成敗、決定回不回滾」那段邏輯，SSH 本身不是。
const path = require('path');
const { query } = require('../db');
const { maskSecrets } = require('./log-parse');
const { sshExec } = require('./ssh-exec');
const {
  pickModules, buildUpgradeCmd, buildUpgradeCmdMulti, readExitCodesByDb,
  buildRestartCmd, buildHealthCmd, buildSwapCmd, buildRollbackCmd,
  groupTargets, groupKey,
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

// 單一目標的部署。實作是 runDeployGroup 的單元素特例，指令格式與過去完全相同。
async function runDeploy(targetId, opts, deps = {}) {
  const [r] = await runDeployGroup([targetId], opts, deps);
  return r;
}

// 一組共用一次停機的目標。N=1 時走原本的單 DB 指令，行為與過去一致。
async function runDeployGroup(targetIds, { trigger, taskId = null, userId = null }, deps = {}) {
  const items = [];
  for (const id of targetIds) {
    const { rows: [t] } = await query('SELECT * FROM project_deploy_targets WHERE id = $1', [id]);
    if (!t) return targetIds.map(x => ({ targetId: x, ok: false, error: '找不到部署目標' }));
    items.push({ target: t });
  }
  const head = items[0].target;
  const git = deps.git || defaultGit(head);
  const exec = deps.exec || sshExec;
  const upload = deps.upload || defaultUpload;

  // 同組共用同一個 branch，所以 sha 只取一次；但每個目標的 last_deployed_sha 各自不同，
  // 所以「這次要動哪些模組」仍要一個一個算。
  let toSha;
  try { toSha = await git.headSha(head.branch); }
  catch (e) {
    return items.map(i => ({ targetId: i.target.id, ok: false, error: `取不到分支 ${head.branch} 的狀態：${e.message}` }));
  }

  for (const it of items) {
    const t = it.target;
    try {
      const changed = t.last_deployed_sha ? await git.changedPaths(t.last_deployed_sha, toSha) : [];
      it.modules = pickModules(changed, t.modules, t.last_deployed_sha);
    } catch (e) {
      it.modules = [];
      it.preError = `取不到變更清單：${e.message}`;
    }
    const { rows: [run] } = await query(
      `INSERT INTO deploy_runs (target_id, task_id, triggered_by, trigger, from_sha, to_sha, modules, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running') RETURNING id`,
      [t.id, taskId, userId, trigger, t.last_deployed_sha, toSha, it.modules]
    );
    it.runId = run.id;
  }

  for (const it of items.filter(i => i.preError)) {
    await query("UPDATE deploy_runs SET status='failed', finished_at=NOW(), log=$2 WHERE id=$1",
      [it.runId, it.preError]);
  }
  // 沒有模組要動 ＝ 成功，且完全不連遠端。這不是失敗，別讓它變紅燈。
  for (const it of items.filter(i => !i.preError && !i.modules.length)) {
    await query("UPDATE deploy_runs SET status='success', finished_at=NOW(), log=$2 WHERE id=$1",
      [it.runId, '本次沒有屬於此目標的模組變更，略過']);
  }
  const active = items.filter(i => !i.preError && i.modules.length);

  // 每個目標各自回一筆結果；有動到的那些由 extra 帶入實際成敗。
  const done = (extra = {}) => items.map(i => ({
    targetId: i.target.id,
    runId: i.runId,
    ...(i.preError ? { ok: false, status: 'failed', modules: [], error: i.preError }
      : i.modules.length ? extra[i.target.id]
        : { ok: true, status: 'success', modules: [] }),
  }));
  if (!active.length) return done();

  // 整組共用同一條連線，失敗時整組一起標
  async function failAll(logText, error) {
    for (const it of active) {
      await query("UPDATE deploy_runs SET status='failed', finished_at=NOW(), log=$2 WHERE id=$1",
        [it.runId, logText]);
    }
    return done(Object.fromEntries(active.map(i =>
      [i.target.id, { ok: false, status: 'failed', modules: i.modules, error }])));
  }

  const { loadDecryptedConn } = require('./db-connections');
  const conn = await loadDecryptedConn(head.conn_id, head.project_id);
  if (!conn) return failAll('這個部署目標的連線設定已不存在，請重新評估', '連線設定已不存在');

  let target = conn;
  if (conn.vpn_enabled) {
    const { ensureGatewayRunning } = require('./vpn-gateway');
    try { await ensureGatewayRunning(conn.vpn); }
    catch (e) { return failAll(`[VPN] ${e.message}`, `[VPN] ${e.message}`); }
    target = { ...conn, ssh_host: '127.0.0.1', ssh_port: conn.vpn_forward_port };
  }

  const ts = stampNow();
  let logBuf = '';
  const say = (s) => { if (s) logBuf += String(s).replace(/\s+$/, '') + '\n'; };

  // 同組共用同一份 addons 目錄，所以檔案只送一次；log 也是同一份，每個目標各存一份副本。
  const allModules = [...new Set(active.flatMap(i => i.modules))];

  async function finishAll(status, error) {
    for (const it of active) {
      // 客戶 conf 內是明碼密碼，Odoo 啟動時會印出來——寫進 DB 之前一定要遮
      await query('UPDATE deploy_runs SET status=$2, log=$3, finished_at=NOW() WHERE id=$1',
        [it.runId, status, maskSecrets(logBuf)]);
    }
    return done(Object.fromEntries(active.map(i =>
      [i.target.id, { ok: status === 'success', status, modules: i.modules, error }])));
  }

  try {
    say(`[DEPLOY] ${active.map(i => `${i.target.env}/${i.target.db_name}`).join('、')}`
      + ` / ${allModules.join(', ')} / ${head.last_deployed_sha || '(初次)'} → ${toSha}`);
    if (active.length > 1) say(`[DEPLOY] ${active.length} 個資料庫共用一次停機`);

    // 1. 平台端打包，逐模組送上去（SFTP 不經 shell，檔名注入不成立）
    for (const m of allModules) {
      const tar = await git.archive(toSha, m);
      await upload(target, tar, `${head.addons_dir}/.deploy-staging/${m}.tgz`);
    }

    // 2. 解檔 + 原子替換
    const swap = await exec(target, buildSwapCmd(head, allModules, ts));
    say(swap.stdout); say(swap.stderr);

    // 3. 升級（含重啟）。多個 DB 時停一次、逐個升、起一次。
    if (active.length === 1) {
      const only = active[0];
      const upg = await exec(target, buildUpgradeCmd(only.target, conn, only.modules));
      say(upg.stdout); say(upg.stderr);
      const rc = readExitCode(upg.stdout);
      if (rc !== 0) throw new Error(`模組升級失敗（EXITCODE=${rc === null ? '讀不到' : rc}）`);
    } else {
      const upg = await exec(target, buildUpgradeCmdMulti(active, conn));
      say(upg.stdout); say(upg.stderr);
      const codes = readExitCodesByDb(upg.stdout);
      // 讀不到那個 DB 的 marker 一律當失敗：漏讀比誤判成功安全
      const bad = active
        .map(i => ({ db: i.target.db_name, rc: codes.has(i.target.db_name) ? codes.get(i.target.db_name) : null }))
        .filter(x => x.rc !== 0);
      if (bad.length) {
        throw new Error('模組升級失敗：' + bad
          .map(x => `${x.db}（EXITCODE=${x.rc === null ? '讀不到' : x.rc}）`).join('、'));
      }
    }

    // 4. 健康檢查
    const hc = await exec(target, buildHealthCmd(head));
    say(hc.stdout);
    if (!/HEALTH_OK/.test(hc.stdout)) throw new Error('健康檢查未通過，服務沒有回來');

    for (const it of active) {
      await query('UPDATE project_deploy_targets SET last_deployed_sha=$2, updated_at=NOW() WHERE id=$1',
        [it.target.id, toSha]);
    }
    say('[DEPLOY] 完成');
    return await finishAll('success');
  } catch (err) {
    say(`[FAIL] ${err.message}`);
    // 回滾只還原檔案。資料庫的改動留在原地——沒有備份（使用者裁決），這是已知取捨。
    // 同組共用一份檔案，所以還原是整組一起的：其中一個 DB 升級失敗，另一個也不能留在新碼上。
    try {
      const rb = await exec(target, buildRollbackCmd(head, allModules, ts));
      say(rb.stdout); say(rb.stderr);
      const rs = await exec(target, buildRestartCmd(head, conn));
      say(rs.stdout); say(rs.stderr);
      say('[ROLLBACK] 檔案已還原並重啟；資料庫的改動未還原');
    } catch (e2) {
      say(`[ROLLBACK-FAIL] ${e2.message}`);
    }
    return await finishAll('rolled_back', err.message);
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

// groupTargets／groupKey 轉出只為相容既有匯入，真身在 deploy-cmd（純函式那一側）
module.exports = { runDeploy, runDeployGroup, groupTargets, groupKey, readExitCode };
