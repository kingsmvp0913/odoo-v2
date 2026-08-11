// Odoo 核心原始碼供給：把 odoo-idx:<major> image 內的核心 addons 解壓到 host 唯讀快取，
// 讓在 worktree 內作業的 pipeline agent（coding／qa／analysis…）能直接 Grep／Read 原生 template／
// class／xpath 目標——取代「worktree 沒核心碼、只能盲查 Context7 猜結構」的長尾亂跑。
//
// 兩層分工，刻意不讓 docker 進到「組 prompt」這條同步路徑：
//   coreSourceGuidance()：純同步、只做 fs.existsSync。快取有就把路徑寫進 prompt；沒有就回既有的
//     Context7-only 守則，並在背景啟動解壓。呼叫端（render builder）維持同步，不必 async 化
//     （rules/testing.md #26：為了注入設定把同步函式改 async，會讓既有 spawn 時序測試整片失效）。
//   ensureOdooCoreSrc()：非同步 execFile 跑 docker。docker create／cp 動輒數秒到數分鐘，用
//     execFileSync 會凍住整個 Node 事件迴圈＝全平台一起卡死（見 1e721aa7 對 lib/vpn-gateway.js 的同一課）。
// 代價：某大版本第一次遇到的那一關拿不到核心路徑（照舊走 Context7），下一關起才有。
// 任何失敗都不 throw、只記冷卻時間，避免 docker 沒開／image 未建時每關 prompt build 都重敲一次。
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dockerEnv = require('./docker-env');

// 唯讀快取根目錄（env 覆寫，勿寫死絕對路徑；比照 data/logs 的 data/ 慣例）
const CORE_SRC_ROOT = process.env.ODOO_CORE_SRC_DIR
  || path.join(__dirname, '..', '..', '..', 'data', 'odoo-core');

// 解壓失敗後的冷卻期：docker 沒開／image 還沒建時，六個關卡的 prompt build 不必一路重試
const FAIL_COOLDOWN_MS = parseInt(process.env.ODOO_CORE_SRC_COOLDOWN_MS || '600000', 10);

const _inflight = new Map();   // major → 進行中的解壓 Promise（同版本只跑一份）
const _failedAt = new Map();   // major → 上次失敗時間戳（冷卻用）

// 大版本數字：完全複用 docker-env 的正規化（與 env-agent 建 image 用的同一套），
// 不寫死 17——'17.0'→'17'、'19.0'→'19'、'saas~17'→'17'、''／無數字→''（呼叫端據此退回 Context7）。
function majorOf(odooVersion) {
  return dockerEnv.majorDigits(odooVersion || '');
}

function pathsFor(major) {
  const destDir = path.join(CORE_SRC_ROOT, major);
  return { destDir, addonsDir: path.join(destDir, 'addons'), marker: path.join(destDir, '.extracted') };
}

// 快取查詢（同步、只碰檔案系統）：marker＋addons 都在才算解壓完成，否則回空字串。
function cachedCoreSrc(major) {
  if (!major) return '';
  const { addonsDir, marker } = pathsFor(major);
  return (fs.existsSync(marker) && fs.existsSync(addonsDir)) ? addonsDir : '';
}

// 單一 docker IO 出口。刻意用 callback 式而非 util.promisify：真的 execFile 帶 promisify.custom
// （resolve 成 {stdout,stderr}），測試注入的 jest.fn 沒有，promisify 會讓測試與正式碼走不同語意。
function docker(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || '').trim());
    });
  });
}

// docker cp 直接寫檔案系統時，會在「指向複製範圍外的 symlink」上整個中止：實測 odoo-idx:17 的
// point_of_sale/static/src/fonts/Inconsolata.otf 指到 image 的 /share/fonts/…，cp 回
// `invalid symlink` 並 exit 1（2 秒就死，不是逾時），已複製的 387/643 個模組留在暫存目錄、
// rename 永遠等不到，於是每一關都退回「只用 Context7」——這功能從上線起沒成功過一次。
// 改讓 cp 吐 tar 串流（dest 用 `-`）再由本機 tar 解開：tar 原樣保存 symlink、不驗證目標，
// 實測 643/643 全數解出、20 秒。
// 自己用 spawn 接管道而不是 sh -c 'a | b'：管道的 exit code 只反映最後一段，cp 的失敗會被
// tar 的 0 蓋掉讀成成功（rules/always #12 已因此誤判三次）。
function cpTarStream(cid, srcPath, destDir, timeout) {
  return new Promise((resolve, reject) => {
    const errs = [];
    let settled = false, cpCode = null, tarCode = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const dock = spawn('docker', ['cp', `${cid}:${srcPath}`, '-']);
    const untar = spawn('tar', ['-xf', '-', '-C', destDir]);
    const timer = setTimeout(() => {
      dock.kill('SIGKILL'); untar.kill('SIGKILL');
      finish(new Error(`docker cp 逾時（${timeout}ms）`));
    }, timeout);
    // 任一端提早死掉時，對已關閉的管道寫入會發 EPIPE；歸因由下面的 close code 負責，這裡吞掉即可
    dock.stdout.on('error', () => {});
    untar.stdin.on('error', () => {});
    dock.stderr.on('data', (d) => errs.push(String(d)));
    untar.stderr.on('data', (d) => errs.push(String(d)));
    dock.on('error', finish);
    untar.on('error', finish);
    const check = () => {
      if (cpCode === null || tarCode === null) return;
      if (cpCode === 0 && tarCode === 0) return finish();
      finish(new Error(`docker cp/tar 失敗（cp=${cpCode} tar=${tarCode}）：${errs.join('').trim().slice(0, 300)}`));
    };
    dock.on('close', (c) => { cpCode = c; check(); });
    untar.on('close', (c) => { tarCode = c; check(); });
    dock.stdout.pipe(untar.stdin);
  });
}

async function extract(major) {
  const { destDir, addonsDir, marker } = pathsFor(major);
  const image = dockerEnv.imageTagFor(major);   // 與 env-agent 建/用的 image 同一個 tag 來源
  let cid = '';
  try {
    fs.mkdirSync(destDir, { recursive: true });
    cid = await docker(['create', image], 60000);
    if (!cid) return '';
    // 先解到暫存再原子 rename——半途失敗不會留下殘缺目錄被下一輪當成「已完成」。
    const tmp = path.join(destDir, '.addons.tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });      // tar -C 要求目錄先存在
    // image 內核心 addons 路徑取自 docker-env（可用 ODOO_IMAGE_CORE_ADDONS 覆寫），不另存一份會漂移的副本。
    // tar 串流以來源目錄名為根 → 解出來是 <tmp>/addons，取它去 rename。
    await cpTarStream(cid, dockerEnv.CORE_ADDONS, tmp, 180000);
    fs.rmSync(addonsDir, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, path.posix.basename(dockerEnv.CORE_ADDONS)), addonsDir);
    fs.rmSync(tmp, { recursive: true, force: true });   // 只剩空殼，留著會讓下一輪誤以為有殘留
    fs.writeFileSync(marker, `${image}\n${new Date().toISOString()}\n`);
    return addonsDir;
  } catch (e) {
    _failedAt.set(major, Date.now());
    console.warn(`[ODOO-CORE-SRC] 解壓核心 addons 失敗（image=${image}）：${e.message}`);
    return '';
  } finally {
    if (cid) { try { await docker(['rm', '-f', cid], 30000); } catch { /* 清不掉不影響結果 */ } }
  }
}

// 解壓核心 addons 到 <root>/<major>/addons（非同步）：已解過回既有路徑、進行中共用同一份、
// 冷卻期內或任何失敗回空字串。呼叫端據此決定守則內容，本函式永不 reject。
function ensureOdooCoreSrc(odooVersion) {
  const major = majorOf(odooVersion);
  if (!major) return Promise.resolve('');
  const hit = cachedCoreSrc(major);
  if (hit) return Promise.resolve(hit);
  if (_inflight.has(major)) return _inflight.get(major);
  if (Date.now() - (_failedAt.get(major) || 0) < FAIL_COOLDOWN_MS) return Promise.resolve('');
  const p = extract(major).finally(() => _inflight.delete(major));
  _inflight.set(major, p);
  return p;
}

// 給 source-routing.md 的 {{odoo_core_src}}：依核心 source 取得與否，回不同的資料來源守則整段。
// 取得到 → 教它先 Grep 唯讀核心路徑（真相來源）、Context7 退為補充；取不到 → 維持既有安全行為
//（只用 Context7、嚴禁掃碟），避免逼 agent 掃硬碟被守衛中止，同時在背景把快取備好給下一關。
function coreSourceGuidance(odooVersion) {
  const major = majorOf(odooVersion);
  const dir = cachedCoreSrc(major);
  if (!dir) {
    if (major) ensureOdooCoreSrc(odooVersion).catch(() => {});   // 背景解壓，不阻塞本次組 prompt
    return '**只用 Context7 MCP**。Odoo 核心原始碼不在你的 worktree（本次快取取不到），**嚴禁**用 `find`／`ls`／`Get-ChildItem` 掃硬碟找 odoo 核心／odoo-bin／odoo-envs／venv（`find /`、掃 `C:\\`、`/c/odoo` 這類廣掃會被平台掃碟守衛中止、白燒整回合）。Context7 查不到就依 Odoo 慣例謹慎判斷，**不要掃碟**。';
  }
  return [
    '本專案 Odoo 版本的核心 addons 已解壓到**唯讀**路徑，內部結構問題一律**先在這裡 Grep／Read**（這是真相來源，比 Context7 準）：',
    `  ${dir}`,
    '- 查原生 template／view 長怎樣、某個 xpath 對不對得到目標節點、原生 module 的 class／method 怎麼實作、原生 selector／class 名 → 直接 Grep 這條路徑，別只靠 Context7 猜結構。',
    '- 這裡只有 addons（原生模組）；ORM 本體（`models.py`／`fields.py`／`http.py`／`tools/`）不在，那類問題仍走 Context7。',
    '- 這裡**唯讀不可改、也不要 `cd` 進去跑 git**；要改的碼永遠在上面本任務的 repo。',
    '- 抽象的 API 概念、版本差異、decorator 慣例，或這條路徑裡確實找不到時，才用 Context7 MCP 補。',
    '- 一樣**嚴禁** `find /`／掃整顆硬碟找核心（會被掃碟守衛中止、白燒整輪）——核心就在上面這條路徑，不要去別處找。'
  ].join('\n');
}

module.exports = { ensureOdooCoreSrc, coreSourceGuidance, majorOf, CORE_SRC_ROOT };
