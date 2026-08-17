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
    'SELECT clone_status, local_path, source_type FROM enterprise_sources WHERE odoo_version=$1', [major]
  );
  if (!src) {
    return { ok: false, error: `Odoo ${major} 的企業版來源尚未設定，請管理員先到「企業版來源」設定並同步` };
  }
  // 指路的動詞要對得上該型態在畫面上的按鈕，否則管理員照著訊息去找一個不存在的「同步」鍵
  const verb = src.source_type === 'local' ? '檢查' : '同步';
  if (src.clone_status !== 'done') {
    return { ok: false, error: `Odoo ${major} 的企業版來源尚未${verb}成功（目前狀態：${src.clone_status}），請管理員到「企業版來源」重新${verb}` };
  }
  const dir = src.local_path || localPathFor(major);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `Odoo ${major} 的企業版目錄不存在（${dir}），請管理員到「企業版來源」重新${verb}` };
  }
  return { ok: true, path: dir };
}

const MANIFEST = '__manifest__.py';

// 目錄下有幾個 Odoo 模組（＝有 __manifest__.py 的子目錄）。純資訊，給管理員確認「這包看起來對不對」。
function countModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, MANIFEST))).length;
}

// 檢查 mode 位元而非用 fs.access：要問的是「容器內那個 odoo uid 讀不讀得到」，不是「平台這個
// 行程讀不讀得到」。兩者不同 uid，且平台若以 root 跑，access 對任何檔案都回可讀——這個檢查會
// 整個失效，然後掛進容器變成一個空 addons 目錄（又是一次靜默降級）。
function lacksMode(p, bits) {
  return (fs.statSync(p).mode & bits) !== bits;
}

// 本地目錄來源的「同步」＝驗證。這裡擋的是三種放錯法，共同點是 Odoo 都不會報錯，只會安靜地
// 用社群版 web 啟動——沒有任何跡象能讓人發現自己測的不是企業版。故一律在登記當下擋掉。
function verifyLocalDir(major) {
  const dir = localPathFor(major);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `目錄不存在：${dir}。請先建立該目錄並把企業版 addons 放進去` };
  }
  const weDir = path.join(dir, 'web_enterprise');
  const weManifest = path.join(weDir, MANIFEST);
  if (!fs.existsSync(weManifest)) {
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    // 解壓 tarball 最常見的結果是 <dir>/enterprise-17.0/web_enterprise。此時 addons-path 指到的
    // 那層一個模組都沒有。只有「恰好一個子目錄」時這個推斷才成立——目錄裡本來就散著多個模組卻
    // 缺 web_enterprise 是另一回事（放成社群版 addons／只放了部分模組），不可套同一句話誤導。
    if (subs.length === 1) {
      return { ok: false, error: `${dir} 底下找不到 web_enterprise，只有單一子目錄 ${subs[0]}／——是不是多包了一層？請把 ${subs[0]} 裡的內容直接移到 ${dir} 底下` };
    }
    return { ok: false, error: `${dir} 底下找不到 web_enterprise/${MANIFEST}——這包不是企業版 addons，或版本目錄放錯了` };
  }
  // 目錄要 o+rx（進得去、列得出），檔案要 o+r
  for (const [p, bits, hint] of [[dir, 0o005, 'o+rx'], [weDir, 0o005, 'o+rx'], [weManifest, 0o004, 'o+r']]) {
    if (lacksMode(p, bits)) {
      return { ok: false, error: `${p} 權限不足（需 ${hint}）：容器內的 odoo 是另一個 uid，讀不到就等於掛了一個空目錄。請執行 chmod -R o+rX ${dir}` };
    }
  }
  // 刻意不驗「這包是不是該大版本」：官方 addons 的 manifest version 是模組自身版本（實測 Odoo 17
  // 企業版 585 個模組全是 1.0／1.1，社群版核心同樣），series 前綴是 Odoo 載入時才補的，包裡也沒有
  // release.py。版本以「管理員把它放進哪個目錄」為準，平台不猜。
  return { ok: true, path: dir, moduleCount: countModules(dir) };
}

// 同步某大版本的企業版來源。git 型態走 clone／fetch（gitEnv 為 lib/git-identity 產出的 PAT 注入
// env，私有 repo 必需，未帶則沿用機器憑證）；local 型態不碰 git，改為驗證管理員放進去的目錄。
// git 的更新走 fetch + reset --hard 而非 pull：此目錄是唯讀來源，只需收斂到遠端狀態，reset 可
// 避開 shallow clone 的 pull 行為差異與本地殘留造成的衝突。
async function syncSource(major, gitEnv) {
  major = String(major);
  const { rows: [src] } = await query('SELECT repo_url, branch, source_type FROM enterprise_sources WHERE odoo_version=$1', [major]);
  if (!src) return { ok: false, error: `Odoo ${major} 的企業版來源尚未設定` };

  if (src.source_type === 'local') {
    const r = verifyLocalDir(major);
    if (r.ok) {
      await query(
        `UPDATE enterprise_sources SET clone_status='done', local_path=$2, error_msg=NULL,
                last_synced_at=NOW(), updated_at=NOW() WHERE odoo_version=$1`,
        [major, r.path]
      );
    } else {
      await query(
        "UPDATE enterprise_sources SET clone_status='error', error_msg=$2, updated_at=NOW() WHERE odoo_version=$1",
        [major, r.error.slice(0, 500)]
      );
    }
    return r;
  }

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
      // origin 是首次 clone 當下寫進 .git/config 的 URL；管理員事後用「編輯」改 repo_url
      // 只改 DB，若不在此收斂 remote，fetch 抓的仍是舊 repo——會回報同步成功，掛進容器的卻是錯的來源。
      await runGit(['-C', dest, 'remote', 'set-url', 'origin', src.repo_url], opts);
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

module.exports = { ENTERPRISE_BASE_DIR, localPathFor, resolveEnterprisePath, syncSource, verifyLocalDir };
