// db_connections 讀取＋解密（單一來源，供路由與 VPN 共管層共用）。
// 刻意獨立成 lib：不牽扯 auth／express，讓非 HTTP 情境（如 pipeline 的 project-vpn）也能安全 require，
// 不會把 auth.js 的 JWT_SECRET 載入需求拖進來。
const { query } = require('../db');
const { decrypt } = require('./crypto');

// 讀單一連線並就地解密敏感欄位（ssh/db 密碼、金鑰、VPN 設定與密碼）。找不到回 null。
async function loadDecryptedConn(cid, projectId) {
  const { rows: [c] } = await query('SELECT * FROM db_connections WHERE id=$1 AND project_id=$2', [cid, projectId]);
  if (!c) return null;
  c.ssh_password = c.ssh_password_enc ? decrypt(c.ssh_password_enc) : '';
  c.ssh_key = c.ssh_key_enc ? decrypt(c.ssh_key_enc) : '';
  c.db_password = c.db_password_enc ? decrypt(c.db_password_enc) : '';
  c.vpn_config = c.vpn_config_enc ? decrypt(c.vpn_config_enc) : '';
  c.vpn_password = c.vpn_password_enc ? decrypt(c.vpn_password_enc) : '';
  return c;
}

module.exports = { loadDecryptedConn };
