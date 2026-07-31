process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-dbq';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));
jest.mock('../lib/vpn-gateway', () => ({
  allocateForwardPort: jest.fn(() => 22000),
  targetHostPort: (c) => ((c.connect_mode || 'docker') === 'direct'
    ? { host: c.db_host, port: c.db_port || 5432 }
    : { host: c.ssh_host, port: c.ssh_port || 22 }),
  stopGateway: jest.fn(),
  removeGateway: jest.fn(),
  projectContainerName: (id) => `vpn-proj-${id}`,
}));
const { allocateForwardPort, stopGateway, removeGateway } = require('../lib/vpn-gateway');

let dbModule, app, token, userToken, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name,role) VALUES ('u','h','U','admin') RETURNING id");
  token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { rows: [nu] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name,role) VALUES ('nu','h','NU','user') RETURNING id");
  userToken = jwt.sign({ userId: nu.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('P','17.0') RETURNING id");
  projectId = p.id;
  const a = express(); a.use(express.json());
  require('../db-query-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));
const auth = () => ({ Authorization: `Bearer ${token}` });

let cid;
test('POST 建立連線（回傳不含密碼）', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
    name: 'c1', ssh_host: '1.2.3.4', ssh_user: 'root', auth_type: 'password', ssh_password: 'secret',
    connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_prd'
  });
  expect(res.status).toBe(201);
  expect(res.body.ssh_password_enc).toBeUndefined();
  cid = res.body.id;
});

test('GET 列出（不含密碼）', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/db-connections`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body[0].ssh_password_enc).toBeUndefined();
  expect(res.body[0].name).toBe('c1');
});

test('POST query 呼叫 runSelect 並回結果', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['id'], rows: [['1']], row_count: 1 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/${cid}/query`).set(auth()).send({ sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(res.body.row_count).toBe(1);
  // runSelect 收到的 conn 應含解密後的明文密碼
  expect(mockRunSelect.mock.calls[0][0].ssh_password).toBe('secret');
});

test('DELETE 移除連線', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}/db-connections/${cid}`).set(auth());
  expect(res.status).toBe(200);
});

test('401 無 token', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/db-connections`);
  expect(res.status).toBe(401);
});

// 原 E-3 主題是「連線管理與查詢限 admin」，已刻意改為開放給所有登入者：這組連線的主要
// 受益者是一般使用者（Chat／客服 agent 靠它查正式區），限管理員等於讓最需要的人設不了。
// 保留的界線是「要登入」——未登入仍 401（見上一條），而查詢端本身只放行 SELECT。
test('一般使用者可建立連線並讀清單（不再限管理員）', async () => {
  const uauth = { Authorization: `Bearer ${userToken}` };
  const post = await request(app).post(`/api/projects/${projectId}/db-connections`).set(uauth).send({
    name: 'by-normal-user', ssh_host: 'h', ssh_user: 'u', db_name: 'd'
  });
  expect(post.status).toBe(201);
  const list = await request(app).get(`/api/projects/${projectId}/db-connections`).set(uauth);
  expect(list.status).toBe(200);
  expect(list.body.some(c => c.name === 'by-normal-user')).toBe(true);
  // 開放寫入不等於開放外洩：回傳仍不得帶任何加密欄位
  expect(post.body.ssh_password_enc).toBeUndefined();
  await request(app).delete(`/api/projects/${projectId}/db-connections/${post.body.id}`).set(uauth);
});

// direct 模式（DBeaver 直連）：不需 SSH 欄位，必填 db_host/db_user/db_password/db_name
let dcid;
test('direct POST 建立（不需 ssh 欄位，回傳含 db_host 不含密碼）', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
    name: 'dconn', connect_mode: 'direct', db_engine: 'mssql',
    db_host: 'db.example.com', db_port: 5432, db_user: 'reader', db_password: 'dbsecret', db_name: 'odoo_prd', db_ssl: true
  });
  expect(res.status).toBe(201);
  expect(res.body.db_host).toBe('db.example.com');
  expect(res.body.db_engine).toBe('mssql');
  expect(res.body.db_ssl).toBe(true);
  expect(res.body.db_password_enc).toBeUndefined();
  expect(res.body.ssh_password_enc).toBeUndefined();
  dcid = res.body.id;
});

test('direct POST 缺 db_host → 400', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
    name: 'bad', connect_mode: 'direct', db_user: 'reader', db_password: 'x', db_name: 'd'
  });
  expect(res.status).toBe(400);
});

test('direct query：runSelect 收到解密後的 db_password 明文', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['x'], rows: [['1']], row_count: 1 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/${dcid}/query`).set(auth()).send({ sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(mockRunSelect.mock.calls.at(-1)[0].db_password).toBe('dbsecret');
});

test('/test 端點：以表單值呼叫 runSelect(SELECT 1) 並回 ok', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['?column?'], rows: [['1']], row_count: 1 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
    connect_mode: 'direct', db_host: 'h', db_user: 'u', db_password: 'formpw', db_name: 'd'
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const call = mockRunSelect.mock.calls.at(-1);
  expect(call[0].db_password).toBe('formpw');
  expect(call[1]).toBe('SELECT 1');
});

test('/test 端點：編輯時密碼留空 → 回填已存密碼', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: [], rows: [], row_count: 0 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
    id: dcid, connect_mode: 'direct', db_host: 'db.example.com', db_user: 'reader', db_name: 'odoo_prd'
    // db_password 留空
  });
  expect(res.status).toBe(200);
  expect(mockRunSelect.mock.calls.at(-1)[0].db_password).toBe('dbsecret');
});

// 資安：不得用「已存連線的密碼」去連「表單改過的主機」→ 憑證外洩
test('/test 端點：改了 db_host 但密碼留空 → 不沿用已存密碼（防外洩）', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: false, error: 'auth failed' });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
    id: dcid, connect_mode: 'direct', db_host: 'attacker.example.com', db_user: 'reader', db_name: 'odoo_prd'
    // db_password 留空，但主機被換成攻擊者主機
  });
  expect(res.status).toBe(200);
  expect(mockRunSelect.mock.calls.at(-1)[0].db_password).toBe('');
});

test('/test 端點：一般使用者也能測（不再限管理員），但未登入仍 401', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`)
    .set({ Authorization: `Bearer ${userToken}` }).send({ connect_mode: 'direct', db_host: 'h', db_user: 'u', db_password: 'p', db_name: 'd' });
  expect(res.status).toBe(200);
  const anon = await request(app).post(`/api/projects/${projectId}/db-connections/test`)
    .send({ connect_mode: 'direct', db_host: 'h', db_user: 'u', db_password: 'p', db_name: 'd' });
  expect(anon.status).toBe(401);
});

// 舊版「VPN 欄位 CRUD」描述區塊（連線層存憑證、DELETE 呼叫 removeGateway）已隨本次改動
// 整段作廢，改由下方「專案層 VPN 設定」與「連線的 VPN 開關與配埠」取代。

describe('專案層 VPN 設定', () => {
  test('未設定時 GET 回 has_config:false', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/vpn`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ has_config: false, vpn_username: '' });
  });

  test('PUT 存入後 GET 回 has_config:true 與帳號，且不外洩設定檔與密碼', async () => {
    const put = await request(app).put(`/api/projects/${projectId}/vpn`).set(auth())
      .send({ vpn_config: 'client\ndev tun', vpn_username: 'aicd5', vpn_password: 'Aicd5' });
    expect(put.status).toBe(200);

    const res = await request(app).get(`/api/projects/${projectId}/vpn`).set(auth());
    expect(res.body).toEqual({ has_config: true, vpn_username: 'aicd5' });
  });

  // 「留空＝不變」是連線表單既有慣例，VPN 卡片必須一致，否則使用者改帳號就會把 .ovpn 清掉
  test('PUT 只帶帳號時，不動已存的設定檔與密碼', async () => {
    await request(app).put(`/api/projects/${projectId}/vpn`).set(auth())
      .send({ vpn_config: 'cfg', vpn_username: 'old', vpn_password: 'pw' });
    await request(app).put(`/api/projects/${projectId}/vpn`).set(auth()).send({ vpn_username: 'new' });

    const res = await request(app).get(`/api/projects/${projectId}/vpn`).set(auth());
    expect(res.body).toEqual({ has_config: true, vpn_username: 'new' });
  });

  // 連線管理開放給所有登入者後，VPN 設定必須一起開：只開連線、不開 VPN，一般使用者建得了
  // 需要 VPN 的連線卻設不了隧道憑證，等於留一個永遠連不上的半殘設定。
  test('一般使用者可讀也可寫（未登入仍擋）', async () => {
    const userAuth = { Authorization: `Bearer ${userToken}` };
    expect((await request(app).get(`/api/projects/${projectId}/vpn`).set(userAuth)).status).toBe(200);
    expect((await request(app).put(`/api/projects/${projectId}/vpn`).set(userAuth).send({ vpn_username: 'x' })).status).toBe(200);
    expect((await request(app).put(`/api/projects/${projectId}/vpn`).send({ vpn_username: 'y' })).status).toBe(401);
  });

  // Finding 2：容器 label 指紋只涵蓋 targets、不涵蓋憑證，換帳密／設定檔後執行中的容器不會
  // 自動換憑證。砍掉舊容器讓下次用到時用新憑證重建，是目前唯一能讓「改憑證」生效的地方。
  // 一定要先 stopGateway（SIGTERM）再 removeGateway（rm -f）：直接 rm -f 是 SIGKILL，會讓
  // VPN 伺服器端殘留未正常結束的 session，下一次重連（改密碼後往往只隔幾秒）容易被誤判為
  // 衝突而拒絕——這正是本專案要避免的核心風險，不能為了砍容器反而製造它。
  test('PUT 成功後會先 stopGateway 再 removeGateway（不能直接 SIGKILL 還活著的隧道），讓執行中的容器帶著新憑證重建', async () => {
    stopGateway.mockClear();
    removeGateway.mockClear();
    const res = await request(app).put(`/api/projects/${projectId}/vpn`).set(auth())
      .send({ vpn_username: 'changed' });
    expect(res.status).toBe(200);
    expect(stopGateway).toHaveBeenCalledWith(expect.objectContaining({ containerName: `vpn-proj-${projectId}` }));
    expect(removeGateway).toHaveBeenCalledWith(expect.objectContaining({ containerName: `vpn-proj-${projectId}` }));
    expect(stopGateway.mock.invocationCallOrder[0]).toBeLessThan(removeGateway.mock.invocationCallOrder[0]);
  });
});

describe('連線的 VPN 開關與配埠', () => {
  test('建立時打開 VPN 會配埠，且不接受憑證欄位（憑證只在專案層）', async () => {
    allocateForwardPort.mockReturnValueOnce(22000);
    const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'vpnconn', ssh_host: '192.168.1.233', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_tst',
      vpn_enabled: true, vpn_config: 'SHOULD_BE_IGNORED', vpn_username: 'ignored', vpn_password: 'ignored',
    });
    expect(res.status).toBe(201);
    expect(res.body.vpn_enabled).toBe(true);

    const { rows: [row] } = await dbModule.query('SELECT vpn_forward_port, vpn_config_enc, vpn_username FROM db_connections WHERE id=$1', [res.body.id]);
    expect(row.vpn_forward_port).toBe(22000);
    expect(row.vpn_config_enc).toBeNull();   // 憑證欄位是死欄，不得再被寫入
    expect(row.vpn_username).toBeNull();
  });

  test('配埠時把同專案已配的目標傳給 allocateForwardPort（同目標才共用得到埠）', async () => {
    allocateForwardPort.mockClear();
    await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'vpnconn2', ssh_host: '192.168.1.233', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_prd', vpn_enabled: true,
    });
    const [usedPorts, projectTargets, target] = allocateForwardPort.mock.calls[0];
    expect(Array.isArray(usedPorts)).toBe(true);
    expect(projectTargets).toContainEqual({ host: '192.168.1.233', port: 22, forwardPort: 22000 });
    expect(target).toEqual({ host: '192.168.1.233', port: 22 });
  });

  // 同專案共用一個容器：若改了目標主機卻沿用舊埠，會跟另一條連線搶同一個轉發埠的 listen，
  // 容器起不來（見 Finding 2）。反過來目標沒變就不能重配，否則每次存檔都可能換埠＝每次都重建容器。
  test('目標沒變時 PUT 存檔不會換埠（避免無謂重建容器）', async () => {
    allocateForwardPort.mockReturnValueOnce(22010);
    const create = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'vpnconn3', ssh_host: '10.0.0.1', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_a', vpn_enabled: true,
    });
    const cid = create.body.id;
    const { rows: [before] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [cid]);
    expect(before.vpn_forward_port).toBe(22010);

    allocateForwardPort.mockClear();
    const put = await request(app).put(`/api/projects/${projectId}/db-connections/${cid}`).set(auth())
      .send({ description: '改個備註而已，沒動主機' });
    expect(put.status).toBe(200);
    expect(allocateForwardPort).not.toHaveBeenCalled();

    const { rows: [after] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [cid]);
    expect(after.vpn_forward_port).toBe(22010);
  });

  test('改掉目標主機（ssh_host）後會重配轉發埠，不再沿用舊值', async () => {
    allocateForwardPort.mockReturnValueOnce(22020);
    const create = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'vpnconn4', ssh_host: '10.0.0.2', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_b', vpn_enabled: true,
    });
    const cid = create.body.id;

    allocateForwardPort.mockReturnValueOnce(22030);
    const put = await request(app).put(`/api/projects/${projectId}/db-connections/${cid}`).set(auth())
      .send({ ssh_host: '10.0.0.99' }); // 打錯 IP 修正：目標主機真的變了
    expect(put.status).toBe(200);

    const { rows: [after] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [cid]);
    expect(after.vpn_forward_port).toBe(22030);
    expect(after.vpn_forward_port).not.toBe(22020);
  });

  // Finding 1：conn B 指向 H 啟用 VPN 得埠 → 停用 B（埠留著不清）→ 新建 conn A 也指向 H，
  // 若配埠時看不到「已停用」的 B 就會另外分到一個埠 → 兩條連線指向同一台機器卻各佔一個埠，
  // 之後 loadProjectVpn 用 host:port 去重＋容器只 publish 存活那個埠時，另一條連線就會連到
  // 沒 publish 的埠而 ECONNREFUSED。驗證：assignForwardPort 傳給 allocateForwardPort 的 peers
  // 陣列要包含停用中的連線（Fix 1a）；且重新啟用一定要重配、不能因為「已有埠」就跳過（Fix 1b）。
  test('Fix1：停用連線的目標仍要被視為既有埠，重新啟用一定要重配，最終同目標的兩條連線埠一致', async () => {
    allocateForwardPort.mockReturnValueOnce(22040);
    const createB = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'connB', ssh_host: '10.9.9.9', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_h', vpn_enabled: true,
    });
    const bId = createB.body.id;
    let row = (await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [bId])).rows[0];
    expect(row.vpn_forward_port).toBe(22040);

    // 停用 B：埠留著（既有行為，DELETE 也不動 docker，這裡也不動 vpn_forward_port）
    const disableB = await request(app).put(`/api/projects/${projectId}/db-connections/${bId}`).set(auth())
      .send({ vpn_enabled: false });
    expect(disableB.status).toBe(200);

    // 新建 conn A 也指向 H：驗證 peers 陣列有把「已停用」的 B 算進去（Fix 1a）
    allocateForwardPort.mockClear();
    allocateForwardPort.mockReturnValueOnce(22040); // 沿用 B 的埠（同目標理應共用）
    const createA = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'connA', ssh_host: '10.9.9.9', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_h2', vpn_enabled: true,
    });
    const aId = createA.body.id;
    const [, peersAtCreateA] = allocateForwardPort.mock.calls[0];
    expect(peersAtCreateA).toContainEqual({ host: '10.9.9.9', port: 22, forwardPort: 22040 });

    // 重新啟用 B：即使「已有埠」也要重配（Fix 1b），不能因為 justEnabled 舊邏輯只看「沒配過埠」而跳過
    allocateForwardPort.mockClear();
    allocateForwardPort.mockReturnValueOnce(22040);
    const enableB = await request(app).put(`/api/projects/${projectId}/db-connections/${bId}`).set(auth())
      .send({ vpn_enabled: true });
    expect(enableB.status).toBe(200);
    expect(allocateForwardPort).toHaveBeenCalled();

    const { rows: [aRow] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [aId]);
    const { rows: [bRow] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [bId]);
    expect(aRow.vpn_forward_port).toBe(22040);
    expect(bRow.vpn_forward_port).toBe(22040);
  });

  // 防止 Fix 1b 退化成「vpn_enabled 每次是 true 就重配」：沒有 false→true 轉換時不能重配，
  // 否則每次存檔都可能換埠＝每次都重建容器＝斷線重撥。
  test('Fix1b 反例：vpn_enabled 已是 true 時再送一次 true（無轉換）不會重配埠', async () => {
    allocateForwardPort.mockReturnValueOnce(22050);
    const create = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'connC', ssh_host: '10.9.9.5', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_c', vpn_enabled: true,
    });
    const cid = create.body.id;

    allocateForwardPort.mockClear();
    const put = await request(app).put(`/api/projects/${projectId}/db-connections/${cid}`).set(auth())
      .send({ vpn_enabled: true }); // 已經是 true，再送一次 true：不是 false→true 轉換
    expect(put.status).toBe(200);
    expect(allocateForwardPort).not.toHaveBeenCalled();

    const { rows: [row] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [cid]);
    expect(row.vpn_forward_port).toBe(22050);
  });

  // Finding（re-review）：Fix1b 只認 false→true 轉換的話，「vpn_enabled=true 但 vpn_forward_port
  // 是 NULL」的孤兒連線（POST 建立時 assignForwardPort 曾失敗、或遷移半途中斷留下的）再怎麼存檔
  // 都補不回埠。ssh-sql.js 給使用者的錯誤訊息正是「請重新儲存一次連線設定」——這支測試同時是
  // 「照著錯誤訊息做真的有效」的守門員：故意存檔一次不相干的欄位，斷言埠會被補上。
  test('已啟用但轉發埠是 NULL 的連線，照錯誤訊息「重新儲存一次」真的能補回埠', async () => {
    allocateForwardPort.mockReturnValueOnce(22060);
    const create = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'connOrphan', ssh_host: '10.9.9.6', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_orphan', vpn_enabled: true,
    });
    const cid = create.body.id;
    // 模擬孤兒狀態：vpn_enabled 已是 true，但埠因故是 NULL（不透過 PUT，直接還原成故障後的樣子）
    await dbModule.query('UPDATE db_connections SET vpn_forward_port=NULL WHERE id=$1', [cid]);

    allocateForwardPort.mockClear();
    allocateForwardPort.mockReturnValueOnce(22070);
    const put = await request(app).put(`/api/projects/${projectId}/db-connections/${cid}`).set(auth())
      .send({ description: '照錯誤訊息重新儲存一次' }); // 不動 vpn_enabled、不動主機，純粹「重存」
    expect(put.status).toBe(200);
    expect(allocateForwardPort).toHaveBeenCalled();

    const { rows: [row] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [cid]);
    expect(row.vpn_forward_port).toBe(22070);
  });
});

// Fix A：以前 /test 路由組出的 conn 完全沒有 vpn_enabled/vpn/vpn_forward_port，
// runSelect 因此永遠跳過 VPN 分支直連內網位址——遷移後平台主機已不在 VPN 網路內，
// 這會讓每條 vpn_enabled 連線的「測試連線」按鈕必定逾時。
describe('/test 端點：VPN 轉發（Fix A）', () => {
  let vcid;
  test('先建一條 VPN 連線供本組測試使用', async () => {
    allocateForwardPort.mockReturnValueOnce(22080);
    const create = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
      name: 'vpnTestConn', ssh_host: '10.9.9.50', ssh_user: 'root', connect_mode: 'docker',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_vt', vpn_enabled: true,
    });
    vcid = create.body.id;
    const { rows: [row] } = await dbModule.query('SELECT vpn_forward_port FROM db_connections WHERE id=$1', [vcid]);
    expect(row.vpn_forward_port).toBe(22080);
  });

  test('編輯既有 VPN 連線點測試連線：從已存那筆帶出 vpn(Gw) 與 vpn_forward_port', async () => {
    mockRunSelect.mockResolvedValueOnce({ ok: true, columns: [], rows: [], row_count: 0 });
    const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
      id: vcid, connect_mode: 'docker', ssh_host: '10.9.9.50', ssh_user: 'root',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_vt', vpn_enabled: true,
    });
    expect(res.status).toBe(200);
    const call = mockRunSelect.mock.calls.at(-1);
    expect(call[0].vpn_enabled).toBe(true);
    expect(call[0].vpn_forward_port).toBe(22080);
    expect(call[0].vpn).toEqual(expect.objectContaining({ containerName: `vpn-proj-${projectId}` }));
  });

  // 新建連線還沒存檔，天生沒有轉發埠；不該為了「能測」去現場配埠（配埠會寫 DB，測試連線不該有副作用）。
  // 但要帶出專案的 Gw，讓 runSelect 報「此連線尚未配置轉發埠」而不是更上游、會誤導的「專案尚未設定 VPN」。
  test('新建連線（未帶 id）勾 VPN：帶出專案 Gw 但沒有轉發埠，且不觸發配埠', async () => {
    allocateForwardPort.mockClear();
    mockRunSelect.mockResolvedValueOnce({ ok: false, error: '[VPN] 此連線尚未配置轉發埠，請重新儲存一次連線設定' });
    const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
      connect_mode: 'docker', ssh_host: '10.9.9.51', ssh_user: 'root',
      docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_vt2', vpn_enabled: true,
    });
    expect(res.status).toBe(200);
    const call = mockRunSelect.mock.calls.at(-1);
    expect(call[0].vpn_enabled).toBe(true);
    expect(call[0].vpn_forward_port).toBeUndefined();
    expect(call[0].vpn).toEqual(expect.objectContaining({ containerName: `vpn-proj-${projectId}` }));
    expect(allocateForwardPort).not.toHaveBeenCalled();
  });

  test('未勾 VPN 的一般連線：不帶 vpn 物件，不查專案 VPN', async () => {
    mockRunSelect.mockResolvedValueOnce({ ok: true, columns: [], rows: [], row_count: 0 });
    const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
      connect_mode: 'direct', db_host: 'h2', db_user: 'u', db_password: 'p', db_name: 'd',
    });
    expect(res.status).toBe(200);
    const call = mockRunSelect.mock.calls.at(-1);
    expect(call[0].vpn).toBeUndefined();
  });
});
