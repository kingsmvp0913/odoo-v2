const net = require('net');
const { query } = require('./db');

// 測試區 port 採「租約制」：專案啟動測試區時從池中借一個、停止時歸還（見 leasePort/releasePort）。
// 池範圍必須與「nginx 容器 publish 的埠段 ＋ 對外 NAT／防火牆放行段」逐字一致——平台改得了池設定，
// 改不了那兩層，設定超出放行範圍時測試區會靜默連不上（管理員介面的常駐警語即為此）。
// 預設 21000-21012：高位段乾淨，且避開 8069（Odoo）／8080（Tomcat 等）這類本機常見服務。
// 優先序 DB（teams_settings）> env > 預設值；DB 於執行期讀取，管理員改完免重啟即生效。
const DEFAULT_PORT_MIN = 21000;
const DEFAULT_PORT_MAX = 21012;

// loopback host 的推導基準：固定值，不隨 PORT_MIN 移動。若跟著 PORT_MIN 走，一旦某機把
// PORT_MIN 調高，該機 DB 內既有的低位埠會算出負的 n，(n >> 8) & 255 產生無效 host →
// 既有專案測試區網址整個壞掉，且錯誤訊息不會指向埠設定。
const LOOPBACK_BASE = 8069;

// 池範圍的單一真相來源。每次借埠都重讀，故管理員介面改完下一次借埠就生效（不需重啟 server）。
// 三層各自獨立退回：DB 只設了 min 沒設 max 時，max 仍退回 env／預設，不會被當成 0。
async function getPoolRange() {
  let row = null;
  try {
    const { rows } = await query('SELECT port_pool_min, port_pool_max FROM teams_settings WHERE id=1');
    row = rows[0] || null;
  } catch { /* 尚未 migrate 或無 teams_settings：退回 env／預設 */ }
  const envMin = Number(process.env.PROJECT_PORT_MIN) || DEFAULT_PORT_MIN;
  const envMax = Number(process.env.PROJECT_PORT_MAX) || DEFAULT_PORT_MAX;
  return {
    min: row?.port_pool_min ?? envMin,
    max: row?.port_pool_max ?? envMax,
  };
}

// —— 唯一的 IO 邊界：實際嘗試綁定，測試以 deps.isPortFree 注入 mock。 ——
// 探測位址必須是 docker 待會要綁的完全相同位址（該埠的 loopback host）：衝突多來自其他服務綁
// 0.0.0.0:<port>，而 0.0.0.0 被佔用時再綁 127.0.0.x 的同埠會 EADDRINUSE——改探 0.0.0.0 或
// 127.0.0.1 都會漏判。Windows 上另可擋掉 Hyper-V/WinNAT 保留埠段（綁不起來且錯誤不指向成因）。
function isPortFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// 把埠寫進該專案的租約列。抽成可注入的一步，讓「撞 UNIQUE 要重取」這條路徑能被單測驗證
// （pg-mem 不保證支援 partial unique index）。回 true 表示搶到。
async function claimPort(projectId, port) {
  await query('UPDATE odoo_envs SET port=$2, updated_at=NOW() WHERE project_id=$1', [projectId, port]);
  return true;
}

// 掃一輪池子，找到就借。回 null 表示這輪全滿。
async function _tryLease(projectId, probe, claim, min, max) {
  const { rows } = await query('SELECT port FROM odoo_envs WHERE port IS NOT NULL');
  const used = new Set(rows.map(r => r.port));
  for (let p = min; p <= max; p++) {
    if (used.has(p)) continue;
    if (!await probe(loopbackHostForPort(p), p)) continue;
    try {
      await claim(projectId, p);
      return p;
    } catch (err) {
      if (err.code === '23505') continue; // 併發搶同埠：換下一個
      throw err;
    }
  }
  return null;
}

// 借一個埠給該專案：取池內最低「未被租用且宿主可實際綁定」的埠，寫進 odoo_envs.port 並回傳。
// 探測與寫入之間存在 TOCTOU 空窗，由 odoo_envs_port_idx（partial UNIQUE）擋下併發撞埠，
// 撞到就往下一個埠重試——這是原本「建立時固定配發＋projects.port UNIQUE」那套保護的等價替代。
//
// 池滿時先徵收一個閒置夠久的測試區讓位（deps.reclaim 由呼叫端注入，未注入即不徵收）。
// 徵收只做一輪：做成迴圈的話尖峰時會連環砍掉一整排測試區，使用者體感是「一直被別人踢掉」。
async function leasePort(projectId, deps = {}) {
  const probe = deps.isPortFree || isPortFree;
  const claim = deps.claim || claimPort;
  const { min, max } = await getPoolRange();

  const first = await _tryLease(projectId, probe, claim, min, max);
  if (first != null) return first;

  if (deps.reclaim) {
    const { findReclaimable } = require('./lib/port-reclaim');
    const victim = await findReclaimable();
    if (victim) {
      await deps.reclaim(victim.project_id);
      const second = await _tryLease(projectId, probe, claim, min, max);
      if (second != null) return second;
    }
  }

  throw new Error(`測試區併發已滿（埠池 ${min}-${max}）且無閒置可回收，請先停止其他專案的測試區，或聯絡管理員擴充 port 範圍`);
}

// 歸還租約。停機／夜間關機／閒置回收／刪除專案皆須呼叫，否則池子會單向耗盡。
async function releasePort(projectId) {
  await query('UPDATE odoo_envs SET port=NULL, updated_at=NOW() WHERE project_id=$1', [projectId]);
}

// 每個測試區用不同的 loopback host（127.0.0.0/8 全段在 Windows/Linux 皆路由到本機），
// 讓瀏覽器 cookie 依 host 隔離：多開不同專案測試區不再互蓋 session（Odoo「操作已過期」）。
// 用字面 IP 而非 *.localhost 子網域——curl／Playwright／瀏覽器免 DNS 直接解析，Windows 也不會解析失敗。
// 由 port 推導（port 已每專案唯一），故 host 亦唯一且穩定。
function loopbackHostForPort(port) {
  const n = (port - LOOPBACK_BASE) + 2; // 跳過 127.0.0.0（網段）與 127.0.0.1（既用）
  const a = (n >> 8) & 255;
  const b = n & 255;
  return `127.0.${a}.${b}`;
}

// 測試區容器實際發佈到宿主的哪個位址。預設每專案一個 127.0.0.x（上方的 cookie 隔離）。
// 反向代理佈署時必須改掉：nginx 多跑在另一個容器（bridge 網路），連不到宿主的 loopback，
// 設成 docker 橋接閘道位址（entrypoint 偵測 docker0 的同一個值）才反代得到測試區。
// 注意此位址會實際對外監聽——測試區內有 seed 進去的固定帳密，設定前先確認該介面不對外網開放。
function envBindHost(port) {
  return process.env.ENV_BIND_HOST || loopbackHostForPort(port);
}

// 使用者瀏覽器要開的測試區網址。未設樣板時＝直連綁定位址，與未反代時逐字相同。
// 掛在公司網域下時瀏覽器與平台不在同一台機器，127.0.0.x 指向「使用者自己的電腦」而非測試區
// ——畫面上連結看起來正常、點了卻連不上，本機重現不了，故網址必須能與綁定位址脫鉤。
// 樣板可用 {folder}（專案目錄名）／{port}／{host}，例：https://{folder}.aidev.example.com
function envPublicUrl(port, folder) {
  const host = envBindHost(port);
  const tpl = process.env.ENV_PUBLIC_URL_TEMPLATE;
  if (!tpl) return `http://${host}:${port}`;
  return tpl.replace(/\{folder\}/g, folder || '').replace(/\{port\}/g, String(port)).replace(/\{host\}/g, host);
}

module.exports = {
  leasePort, releasePort, getPoolRange, loopbackHostForPort, envBindHost, envPublicUrl, isPortFree,
  DEFAULT_PORT_MIN, DEFAULT_PORT_MAX, LOOPBACK_BASE,
};
