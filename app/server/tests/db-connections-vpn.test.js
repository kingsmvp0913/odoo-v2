// 意圖：conn.vpn 是「一專案一隧道」的資料入口。三件事錯了會直接害查詢連不上：
//   ①目標沒去重 → 容器 publish 重複埠、指紋每次都不同 → 每次查詢都重建隧道
//   ②專案沒設定卻回了物件 → 白撥號、錯誤訊息也不對
//   ③舊容器沒被收進 staleContainers → 遷移後同帳號雙重撥號
process.env.APP_SECRET = 'test-secret';
const { newDb } = require('pg-mem');
const { encrypt } = require('../lib/crypto');
const { loadDecryptedConn, loadProjectVpn } = require('../lib/db-connections');

let dbModule, projectId;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('P','17.0') RETURNING id");
  projectId = p.id;
});
afterEach(() => dbModule._setPoolForTesting(null));

async function addConn(over = {}) {
  const c = {
    name: `c${Math.random()}`, connect_mode: 'docker', ssh_host: '192.168.1.233', ssh_port: 22,
    db_host: null, db_port: null, vpn_enabled: true, vpn_forward_port: 22000, vpn_container_name: null, ...over,
  };
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO db_connections (project_id,name,ssh_host,ssh_port,ssh_user,connect_mode,db_host,db_port,db_name,vpn_enabled,vpn_forward_port,vpn_container_name)
     VALUES ($1,$2,$3,$4,'root',$5,$6,$7,'odoo_tst',$8,$9,$10) RETURNING id`,
    [projectId, c.name, c.ssh_host, c.ssh_port, c.connect_mode, c.db_host, c.db_port, c.vpn_enabled, c.vpn_forward_port, c.vpn_container_name]
  );
  return r.id;
}

async function setProjectVpn() {
  await dbModule.query(
    'UPDATE projects SET vpn_config_enc=$1, vpn_username=$2, vpn_password_enc=$3 WHERE id=$4',
    [encrypt('client\ndev tun'), 'aicd5', encrypt('Aicd5'), projectId]
  );
}

test('專案有 VPN 設定時，conn.vpn 帶解密後的憑證與容器名', async () => {
  await setProjectVpn();
  const cid = await addConn();
  const conn = await loadDecryptedConn(cid, projectId);
  expect(conn.vpn.containerName).toBe(`vpn-proj-${projectId}`);
  expect(conn.vpn.config).toBe('client\ndev tun');
  expect(conn.vpn.username).toBe('aicd5');
  expect(conn.vpn.password).toBe('Aicd5');
});

test('同專案打去同一台機器的多條連線，targets 只留一筆（去重）', async () => {
  await setProjectVpn();
  const cid = await addConn();
  await addConn({ vpn_forward_port: 22000 });                    // 同目標
  await addConn({ connect_mode: 'direct', ssh_host: '', db_host: '192.168.1.240', db_port: 1433, vpn_forward_port: 22001 });
  const conn = await loadDecryptedConn(cid, projectId);
  expect(conn.vpn.targets).toEqual([
    { forwardPort: 22000, host: '192.168.1.233', port: 22 },
    { forwardPort: 22001, host: '192.168.1.240', port: 1433 },
  ]);
});

test('未配轉發埠的連線不進 targets（不會讓容器少 publish 一個埠就宣稱涵蓋）', async () => {
  await setProjectVpn();
  const cid = await addConn();
  await addConn({ connect_mode: 'direct', ssh_host: '', db_host: '9.9.9.9', db_port: 5432, vpn_forward_port: null });
  const conn = await loadDecryptedConn(cid, projectId);
  expect(conn.vpn.targets).toHaveLength(1);
});

test('遷移前留下的舊容器名被收進 staleContainers，去重且排除新容器名', async () => {
  await setProjectVpn();
  const cid = await addConn({ vpn_container_name: 'vpn-conn-1' });
  await addConn({ vpn_container_name: 'vpn-conn-1' });
  await addConn({ vpn_container_name: `vpn-proj-${projectId}` });
  const conn = await loadDecryptedConn(cid, projectId);
  expect(conn.vpn.staleContainers).toEqual(['vpn-conn-1']);
});

test('專案沒有 VPN 設定時 conn.vpn 為 null（呼叫端據此報「尚未設定」而非撥號）', async () => {
  const cid = await addConn();
  const conn = await loadDecryptedConn(cid, projectId);
  expect(conn.vpn).toBeNull();
});

test('連線本身沒開 VPN 時不去查專案設定，conn.vpn 為 null', async () => {
  await setProjectVpn();
  const cid = await addConn({ vpn_enabled: false, vpn_forward_port: null });
  const conn = await loadDecryptedConn(cid, projectId);
  expect(conn.vpn).toBeNull();
});

test('loadProjectVpn 可獨立呼叫（測試區起停用）', async () => {
  await setProjectVpn();
  await addConn();
  const gw = await loadProjectVpn(projectId);
  expect(gw.targets).toHaveLength(1);
  expect(gw.username).toBe('aicd5');
});
