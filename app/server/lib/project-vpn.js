// 專案 VPN 與測試區生命週期共管：測試區起 → 暖機該專案所有 vpn_enabled 連線的 VPN 隧道；
// 測試區停 → 收掉。VPN 用途不變（仍是 DB 查詢功能用的 socat 隧道，Odoo 容器不碰 VPN 網路），
// 此層只負責「何時起、何時停」。連線密碼/設定加密存 DB，沿用 db-query-routes 的 loadDecryptedConn 解密。
const { query } = require('../db');
const { loadDecryptedConn } = require('./db-connections');
const { ensureGatewayRunning, stopGateway } = require('./vpn-gateway');

// 測試區起後呼叫（fire-and-forget）：逐條備妥該專案的 VPN。逐條 try/catch 隔離——單條撥號失敗
// 只記字串、不影響其他條、整體不 throw（VPN 撥不通不該擋測試區，Odoo 本身不使用 VPN 網路）。
// 未配轉發埠的舊連線跳過（交由存連線時的既有配埠邏輯補）。回傳彙整 log 供呼叫端記錄。
async function startProjectVpns(projectId, deps = {}) {
  const { rows } = await query(
    'SELECT id FROM db_connections WHERE project_id=$1 AND vpn_enabled=true', [projectId]
  );
  const out = [];
  for (const { id } of rows) {
    let conn = null;
    try { conn = await loadDecryptedConn(id, projectId); } catch { /* 解密失敗略過該條 */ }
    if (!conn) continue;
    if (!conn.vpn_forward_port) { out.push(`[vpn] ${conn.name} SKIP 未配轉發埠`); continue; }
    try {
      await ensureGatewayRunning(conn, deps);
      out.push(`[vpn] ${conn.name} OK`);
    } catch (e) {
      out.push(`[vpn] ${conn.name} FAIL ${e.message}`);
    }
  }
  return out.join('\n');
}

// 測試區停時呼叫：只停不刪（stopGateway＝docker stop，SIGTERM 讓 openvpn 正常斷線）。永不 throw，
// 不擋測試區停機流程。免解密（stopGateway 只需容器名/id）。removeGateway（rm -f）維持只在刪連線時觸發。
async function stopProjectVpns(projectId, deps = {}) {
  const { rows } = await query(
    'SELECT id, vpn_container_name FROM db_connections WHERE project_id=$1 AND vpn_enabled=true', [projectId]
  );
  for (const conn of rows) {
    try { stopGateway(conn, deps); } catch { /* 永不擋停機 */ }
  }
}

module.exports = { startProjectVpns, stopProjectVpns };
