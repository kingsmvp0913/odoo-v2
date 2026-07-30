// 專案 VPN 與測試區生命週期共管：測試區起 → 備妥該專案的共用隧道；測試區停 → 收掉。
// VPN 用途不變（仍是 DB 查詢用的 socat 隧道，Odoo 容器不碰 VPN 網路），此層只負責「何時起、何時停」。
// 一個專案一個容器：撥號只發生一次，容器內對多個目標各起一個轉發。
const { loadProjectVpn } = require('./db-connections');
const { ensureGatewayRunning, stopGateway, projectContainerName } = require('./vpn-gateway');

// 測試區起後呼叫（fire-and-forget）。永不 throw——VPN 撥不通不該擋測試區。回傳彙整 log 供呼叫端記錄。
async function startProjectVpns(projectId, deps = {}) {
  let gw = null;
  try {
    gw = await loadProjectVpn(projectId);
  } catch (e) {
    return `[vpn] FAIL 讀取專案 VPN 設定失敗：${e.message}`;
  }
  if (!gw) return '';
  if (!gw.targets.length) return `[vpn] ${gw.containerName} SKIP 沒有已配轉發埠的連線`;
  try {
    await ensureGatewayRunning(gw, deps);
    return `[vpn] ${gw.containerName} OK（${gw.targets.length} 個目標）`;
  } catch (e) {
    return `[vpn] ${gw.containerName} FAIL ${e.message}`;
  }
}

// 測試區停時呼叫：只停不刪（SIGTERM 讓 openvpn 正常斷線通知伺服器）。永不 throw。
// 與 startProjectVpns 一樣先確認該專案真的有 VPN 設定才動 docker：沒有這道早退的話，
// 任何停機路徑都會對宿主機盲發 `docker stop vpn-proj-<id>`，而 stopGateway 對「容器不存在」
// 是靜默的，砍錯完全沒有訊號（實測跑測試就停掉過本機同名的真容器）。
// 取捨：設定讀不出來（DB 掛了／APP_SECRET 換過導致解密失敗）時寧可不發指令、留著殘留容器，
// 也不要退回盲打。「設定被清掉但容器還在」不構成漏網——PUT /vpn 沒有能清空 vpn_config_enc
// 的路徑（留空＝不變）且它自己就會 stop+rm；刪專案則是先 stopEnv 才刪 projects 列，
// 走到這裡時專案還在。
async function stopProjectVpns(projectId, deps = {}) {
  let gw = null;
  try { gw = await loadProjectVpn(projectId); } catch { return; }
  if (!gw) return;
  try { await stopGateway({ containerName: projectContainerName(projectId) }, deps); } catch { /* 永不擋停機 */ }
}

module.exports = { startProjectVpns, stopProjectVpns };
