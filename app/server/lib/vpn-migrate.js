// VPN 憑證上移專案層的一次性遷移。獨立成模組而非塞進 db.js，是為了能用 pg-mem 單獨測，
// 且 db.js 不必在自己的頂層 require 到 docker 相關的 vpn-gateway 依賴鏈——本模組仍會
// require 到它，但延後到 db.js 的 migrate() 呼叫時才發生（見 db.js 內的 require('./lib/vpn-migrate')）。
const { allocateForwardPort, targetHostPort } = require('./vpn-gateway');

const PORT_RANGE_START = 22000;
const PORT_RANGE_END = 22999;
const inRange = (p) => Number.isInteger(p) && p >= PORT_RANGE_START && p <= PORT_RANGE_END;

async function migrateVpnToProjects(query) {
  // ① 憑證上移：每個專案取「id 最小且有設定檔」的那條，密文原樣複製（不解密，故不依賴 APP_SECRET）。
  //    只在 projects 該欄仍為 NULL 時做 → 重跑不覆蓋使用者後來在 UI 改的憑證。
  //    不用 DISTINCT ON 是因為 pg-mem 對它支援不完整，改在 JS 端取每組第一筆。
  const { rows: candidates } = await query(
    `SELECT c.project_id, c.id, c.vpn_config_enc, c.vpn_username, c.vpn_password_enc
       FROM db_connections c
       JOIN projects p ON p.id = c.project_id
      WHERE c.vpn_config_enc IS NOT NULL AND p.vpn_config_enc IS NULL
      ORDER BY c.project_id, c.id`
  );
  const firstByProject = new Map();
  for (const r of candidates) if (!firstByProject.has(r.project_id)) firstByProject.set(r.project_id, r);

  for (const [projectId, r] of firstByProject) {
    await query(
      'UPDATE projects SET vpn_config_enc=$1, vpn_username=$2, vpn_password_enc=$3 WHERE id=$4',
      [r.vpn_config_enc, r.vpn_username, r.vpn_password_enc, projectId]
    );
    // ② 使用者決定：遷移時把該專案所有連線一併打開，新機開箱即用。
    await query('UPDATE db_connections SET vpn_enabled=true WHERE project_id=$1', [projectId]);
  }

  // ③ 埠回填：同專案同目標沿用同一個埠；不在新範圍內的舊埠（如 11000）一律重配。
  //    這段每次開機都跑，但收斂後就是 0 次 UPDATE。
  const { rows: conns } = await query(
    `SELECT id, project_id, connect_mode, ssh_host, ssh_port, db_host, db_port, vpn_forward_port
       FROM db_connections WHERE vpn_enabled=true ORDER BY project_id, id`
  );
  if (!conns.length) return;

  const { rows: usedRows } = await query(
    'SELECT vpn_forward_port FROM db_connections WHERE vpn_forward_port IS NOT NULL'
  );
  const used = usedRows.map(r => r.vpn_forward_port).filter(inRange);

  const byProject = new Map();
  for (const c of conns) {
    if (!byProject.has(c.project_id)) byProject.set(c.project_id, []);
    byProject.get(c.project_id).push(c);
  }

  for (const list of byProject.values()) {
    const assigned = new Map();   // 'host:port' → forwardPort
    for (const c of list) {
      const t = targetHostPort(c);
      const key = `${t.host}:${t.port}`;
      if (inRange(c.vpn_forward_port) && !assigned.has(key)) assigned.set(key, c.vpn_forward_port);
    }
    for (const c of list) {
      const t = targetHostPort(c);
      const key = `${t.host}:${t.port}`;
      let port = assigned.get(key);
      if (!port) {
        port = allocateForwardPort(used);
        used.push(port);
        assigned.set(key, port);
      }
      if (c.vpn_forward_port !== port) {
        await query('UPDATE db_connections SET vpn_forward_port=$1 WHERE id=$2', [port, c.id]);
      }
    }
  }
}

module.exports = { migrateVpnToProjects };
