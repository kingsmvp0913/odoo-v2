// 企業版 addons 來源：Odoo 企業版與社群版的 server 本體相同，差別只在多一包 addons 目錄
// （web_enterprise 覆蓋社群 web）。故平台不為此分 image，只按「大版本」各存一份共用目錄，
// 測試區啟動時以唯讀掛入。此目錄刻意不進 project_repos——不被開 testing 分支、不被 coding agent
// 讀寫、不被 deploy commit/push，與 app/docker/addons 的平台共用 addons 同一個模式。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { query } = require('../db');
const { majorDigits } = require('./docker-env');

// 共用目錄根：預設 <repo 根>/enterprise（app/server/lib → 上溯三層），可用 env 覆寫；不寫死絕對路徑。
const ENTERPRISE_BASE_DIR = process.env.ENTERPRISE_BASE_DIR
  || path.resolve(__dirname, '..', '..', '..', 'enterprise');

function localPathFor(major) {
  return path.join(ENTERPRISE_BASE_DIR, String(major));
}

function runGit(args, opts) {
  return new Promise((resolve, reject) => {
    execFile('git', args, opts, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

// 解析某專案版本該掛哪個 enterprise 目錄。任何「不可用」都回明確錯誤字串，呼叫端據此讓 setup 失敗——
// 絕不回空值讓流程默默跑成社群版（那會讓人以為在測企業版，實際不是，且毫無跡象）。
async function resolveEnterprisePath(odooVersion) {
  const major = majorDigits(odooVersion);
  const { rows: [src] } = await query(
    'SELECT clone_status, local_path FROM enterprise_sources WHERE odoo_version=$1', [major]
  );
  if (!src) {
    return { ok: false, error: `Odoo ${major} 的企業版來源尚未設定，請管理員先到「企業版來源」設定並同步` };
  }
  if (src.clone_status !== 'done') {
    return { ok: false, error: `Odoo ${major} 的企業版來源尚未同步成功（目前狀態：${src.clone_status}），請管理員到「企業版來源」重新同步` };
  }
  const dir = src.local_path || localPathFor(major);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `Odoo ${major} 的企業版目錄不存在（${dir}），請管理員到「企業版來源」重新同步` };
  }
  return { ok: true, path: dir };
}

// 同步（clone 或更新）某大版本的 enterprise repo。gitEnv 為 lib/git-identity 產出的 PAT 注入 env
// （私有 repo 必需），未帶則沿用機器憑證。更新走 fetch + reset --hard 而非 pull：此目錄是唯讀來源，
// 只需收斂到遠端狀態，reset 可避開 shallow clone 的 pull 行為差異與本地殘留造成的衝突。
async function syncSource(major, gitEnv) {
  major = String(major);
  const { rows: [src] } = await query('SELECT repo_url, branch FROM enterprise_sources WHERE odoo_version=$1', [major]);
  if (!src) return { ok: false, error: `Odoo ${major} 的企業版來源尚未設定` };

  const dest = localPathFor(major);
  const opts = { timeout: 900000 };
  if (gitEnv) opts.env = { ...process.env, ...gitEnv };

  await query(
    "UPDATE enterprise_sources SET clone_status='syncing', error_msg=NULL, updated_at=NOW() WHERE odoo_version=$1",
    [major]
  );
  try {
    if (fs.existsSync(path.join(dest, '.git'))) {
      const ref = src.branch || 'HEAD';
      await runGit(['-C', dest, 'fetch', '--depth', '1', 'origin', ref], opts);
      await runGit(['-C', dest, 'reset', '--hard', 'FETCH_HEAD'], opts);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const args = ['clone', '--depth', '1'];
      if (src.branch) args.push('--branch', src.branch);
      args.push('--', src.repo_url, dest);
      await runGit(args, opts);
    }
    await query(
      `UPDATE enterprise_sources SET clone_status='done', local_path=$2, error_msg=NULL,
              last_synced_at=NOW(), updated_at=NOW() WHERE odoo_version=$1`,
      [major, dest]
    );
    return { ok: true, path: dest };
  } catch (err) {
    const msg = (err.stderr || err.message || 'git 同步失敗').slice(0, 500);
    await query(
      "UPDATE enterprise_sources SET clone_status='error', error_msg=$2, updated_at=NOW() WHERE odoo_version=$1",
      [major, msg]
    );
    return { ok: false, error: msg };
  }
}

module.exports = { ENTERPRISE_BASE_DIR, localPathFor, resolveEnterprisePath, syncSource };
