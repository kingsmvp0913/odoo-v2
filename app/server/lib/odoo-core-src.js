// Odoo 核心原始碼供給：把 odoo-idx:<major> image 內的核心 addons 解壓到 host 唯讀快取，
// 讓在 worktree 內作業的 pipeline agent（coding／qa／analysis…）能直接 Grep／Read 原生 template／
// class／xpath 目標——取代「worktree 沒核心碼、只能盲查 Context7 猜結構」的長尾亂跑。
//
// 一律同步（execFileSync）＋marker 快取：首次某版本約 1.6s、537MB，之後只做 fs.existsSync＝即時。
// 刻意不改 async——render builder 是同步的，改 async 會讓既有「呼叫後同步對 mock 發事件」的測試失效
// （見 rules/testing.md #26）。任何失敗都回空字串（呼叫端據此退回 Context7-only），絕不 throw 擋 pipeline。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dockerEnv = require('./docker-env');

// 唯讀快取根目錄（env 覆寫，勿寫死絕對路徑；比照 data/logs 的 data/ 慣例）
const CORE_SRC_ROOT = process.env.ODOO_CORE_SRC_DIR
  || path.join(__dirname, '..', '..', '..', 'data', 'odoo-core');

// image 內核心 addons 路徑（官方 odoo debian 套件 site-packages 位置，13~20+ 皆同，已實測 17／19）
const IMAGE_ADDONS_PATH = '/usr/lib/python3/dist-packages/odoo/addons';

// 大版本數字：完全複用 docker-env 的正規化（與 env-agent 建 image 用的同一套），
// 不寫死 17——'17.0'→'17'、'19.0'→'19'、'saas~17'→'17'、''／無數字→''（呼叫端據此退回 Context7）。
function majorOf(odooVersion) {
  return dockerEnv.majorDigits(odooVersion || '');
}

// 解壓核心 addons 到 <root>/<major>/addons，回絕對路徑；已解過或任何失敗分別回既有路徑／空字串。
function ensureOdooCoreSrc(odooVersion) {
  const major = majorOf(odooVersion);
  if (!major) return '';
  const destDir = path.join(CORE_SRC_ROOT, major);
  const addonsDir = path.join(destDir, 'addons');
  const marker = path.join(destDir, '.extracted');
  // 快取命中：marker＋addons 都在就直接回，同一大版本只解壓一次、之後只做兩個 existsSync（不再複製）。
  if (fs.existsSync(marker) && fs.existsSync(addonsDir)) return addonsDir;

  const image = dockerEnv.imageTagFor(major);   // 與 env-agent 建/用的 image 同一個 tag 來源
  let cid = '';
  try {
    fs.mkdirSync(destDir, { recursive: true });
    cid = execFileSync('docker', ['create', image], { encoding: 'utf8', timeout: 60000 }).trim();
    if (!cid) return '';
    // 先解到暫存再原子 rename——半途失敗不會留下殘缺目錄被下一輪當成「已完成」。
    const tmp = path.join(destDir, '.addons.tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    // docker cp <src 目錄> <不存在的 dest> → dest 直接成為該目錄的內容（模組平鋪在 dest 下）。
    execFileSync('docker', ['cp', `${cid}:${IMAGE_ADDONS_PATH}`, tmp], { timeout: 180000 });
    fs.rmSync(addonsDir, { recursive: true, force: true });
    fs.renameSync(tmp, addonsDir);
    fs.writeFileSync(marker, `${image}\n${new Date().toISOString()}\n`);
    return addonsDir;
  } catch (e) {
    console.warn(`[ODOO-CORE-SRC] 解壓核心 addons 失敗（image=${image}）：${e.message}`);
    return '';
  } finally {
    if (cid) { try { execFileSync('docker', ['rm', '-f', cid], { timeout: 30000 }); } catch { /* 清不掉不影響結果 */ } }
  }
}

// 給 source-routing.md 的 {{odoo_core_src}}：依核心 source 取得與否，回不同的資料來源守則整段。
// 取得到 → 教它先 Grep 唯讀核心路徑（真相來源）、Context7 退為補充；取不到 → 維持既有安全行為
//（只用 Context7、嚴禁掃碟），避免逼 agent 掃硬碟被守衛中止。
function coreSourceGuidance(odooVersion) {
  const dir = ensureOdooCoreSrc(odooVersion);
  if (!dir) {
    return '**只用 Context7 MCP**。Odoo 核心原始碼不在你的 worktree（本次快取取不到），**嚴禁**用 `find`／`ls`／`Get-ChildItem` 掃硬碟找 odoo 核心／odoo-bin／odoo-envs／venv（`find /`、掃 `C:\\`、`/c/odoo` 這類廣掃會被平台掃碟守衛中止、白燒整回合）。Context7 查不到就依 Odoo 慣例謹慎判斷，**不要掃碟**。';
  }
  return [
    '本專案 Odoo 版本的核心 addons 已解壓到**唯讀**路徑，內部結構問題一律**先在這裡 Grep／Read**（這是真相來源，比 Context7 準）：',
    `  ${dir}`,
    '- 查原生 template／view 長怎樣、某個 xpath 對不對得到目標節點、某個 class／method 怎麼實作、原生 selector／class 名 → 直接 Grep 這條路徑，別只靠 Context7 猜結構。',
    '- 這裡**唯讀不可改、也不要 `cd` 進去跑 git**；要改的碼永遠在上面本任務的 repo。',
    '- 抽象的 API 概念、版本差異、decorator 慣例，或這條路徑裡確實找不到時，才用 Context7 MCP 補。',
    '- 一樣**嚴禁** `find /`／掃整顆硬碟找核心（會被掃碟守衛中止、白燒整輪）——核心就在上面這條路徑，不要去別處找。'
  ].join('\n');
}

module.exports = { ensureOdooCoreSrc, coreSourceGuidance, majorOf, CORE_SRC_ROOT };
