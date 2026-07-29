// db_connections 讀取＋解密（單一來源，供路由與 VPN 共管層共用）。
// 刻意獨立成 lib：不牽扯 auth／express，讓非 HTTP 情境（如 pipeline 的 project-vpn）也能安全 require，
// 不會把 auth.js 的 JWT_SECRET 載入需求拖進來。
const { query } = require('../db');
const { decrypt } = require('./crypto');
const { projectContainerName, targetHostPort } = require('./vpn-gateway');

// 專案層 VPN：憑證 + 該專案所有已啟用連線去重後的目標清單 + 待清的舊容器名。
// 專案沒上傳 .ovpn 就回 null——呼叫端據此報「尚未設定」，不要白撥號。
async function loadProjectVpn(projectId) {
  const { rows: [p] } = await query(
    'SELECT vpn_config_enc, vpn_username, vpn_password_enc FROM projects WHERE id=$1', [projectId]
  );
  if (!p || !p.vpn_config_enc) return null;

  const { rows } = await query(
    `SELECT connect_mode, ssh_host, ssh_port, db_host, db_port, vpn_forward_port, vpn_container_name
       FROM db_connections WHERE project_id=$1 AND vpn_enabled=true ORDER BY id`, [projectId]
  );

  const containerName = projectContainerName(projectId);
  const targets = [];
  const seen = new Set();
  const stale = new Set();
  for (const r of rows) {
    // vpn_container_name 是死欄，唯一例外用途：找出遷移前留下的舊容器好清掉
    if (r.vpn_container_name && r.vpn_container_name !== containerName) stale.add(r.vpn_container_name);
    if (!r.vpn_forward_port) continue;
    const t = targetHostPort(r);
    const key = `${t.host}:${t.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ forwardPort: r.vpn_forward_port, host: t.host, port: t.port });
  }

  return {
    containerName,
    config: decrypt(p.vpn_config_enc),
    username: p.vpn_username || '',
    password: p.vpn_password_enc ? decrypt(p.vpn_password_enc) : '',
    targets,
    staleContainers: [...stale],
  };
}

// 讀單一連線並就地解密敏感欄位（ssh/db 密碼、金鑰）。找不到回 null。
// VPN 憑證已上移專案層，透過 conn.vpn 帶出（連線沒開 VPN 就不查）。
async function loadDecryptedConn(cid, projectId) {
  const { rows: [c] } = await query('SELECT * FROM db_connections WHERE id=$1 AND project_id=$2', [cid, projectId]);
  if (!c) return null;
  c.ssh_password = c.ssh_password_enc ? decrypt(c.ssh_password_enc) : '';
  c.ssh_key = c.ssh_key_enc ? decrypt(c.ssh_key_enc) : '';
  c.db_password = c.db_password_enc ? decrypt(c.db_password_enc) : '';
  c.vpn = c.vpn_enabled ? await loadProjectVpn(projectId) : null;
  return c;
}

module.exports = { loadDecryptedConn, loadProjectVpn };
