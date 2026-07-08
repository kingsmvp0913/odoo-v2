const { query } = require('./db');

// 每個專案在「建立時」固定分配一個專屬測試埠（projects.port），執行期只讀不挑，
// 從根本消除多人並行開測試區時「兩專案動態選到同埠→同網址→互蓋」的 race。
// 刪專案為硬刪除（DELETE FROM projects）→ 該列的 port 隨之釋放，下次建立自動回收。
const PORT_MIN = 8069;
const PORT_MAX = 20068; // 12000 個槽；因埠會回收，只需容納「同時存在」的專案數（>2000 仍大量餘裕），且遠低於 OS ephemeral 埠段（32768）

// 取 [PORT_MIN, PORT_MAX] 內最低未被占用的埠（自動回收已刪專案釋出的埠）。
// 並行同時建立偶爾會選到同埠，靠 projects.port 的 UNIQUE 擋下、由呼叫端 retry。
async function allocateProjectPort() {
  const { rows } = await query('SELECT port FROM projects WHERE port IS NOT NULL');
  const used = new Set(rows.map(r => r.port));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(`無可用測試埠：${PORT_MIN}-${PORT_MAX} 已全數配發`);
}

// 每個測試區用不同的 loopback host（127.0.0.0/8 全段在 Windows/Linux 皆路由到本機），
// 讓瀏覽器 cookie 依 host 隔離：多開不同專案測試區不再互蓋 session（Odoo「操作已過期」）。
// 用字面 IP 而非 *.localhost 子網域——curl／Playwright／瀏覽器免 DNS 直接解析，Windows 也不會解析失敗。
// 由 port 推導（port 已每專案唯一），故 host 亦唯一且穩定。
function loopbackHostForPort(port) {
  const n = (port - PORT_MIN) + 2; // 跳過 127.0.0.0（網段）與 127.0.0.1（既用）
  const a = (n >> 8) & 255;
  const b = n & 255;
  return `127.0.${a}.${b}`;
}

module.exports = { allocateProjectPort, loopbackHostForPort, PORT_MIN, PORT_MAX };
