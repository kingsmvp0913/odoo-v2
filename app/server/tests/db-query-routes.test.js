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
}));
const { allocateForwardPort } = require('../lib/vpn-gateway');

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

// 主題 E-3：DB 連線管理與對正式庫查詢限 admin；GET 清單（僅 metadata）一般 user 仍可讀
test('E-3 非 admin：POST 建立連線 → 403，GET 清單仍 200', async () => {
  const uauth = { Authorization: `Bearer ${userToken}` };
  const post = await request(app).post(`/api/projects/${projectId}/db-connections`).set(uauth).send({
    name: 'x', ssh_host: 'h', ssh_user: 'u', db_name: 'd'
  });
  expect(post.status).toBe(403);
  const list = await request(app).get(`/api/projects/${projectId}/db-connections`).set(uauth);
  expect(list.status).toBe(200);
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

test('/test 端點：非 admin → 403', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`)
    .set({ Authorization: `Bearer ${userToken}` }).send({ connect_mode: 'direct', db_host: 'h', db_user: 'u', db_password: 'p', db_name: 'd' });
  expect(res.status).toBe(403);
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
    expect(JSON.stringify(res.body)).not.toMatch(/dev tun|Aicd5/);
  });

  // 「留空＝不變」是連線表單既有慣例，VPN 卡片必須一致，否則使用者改帳號就會把 .ovpn 清掉
  test('PUT 只帶帳號時，不動已存的設定檔與密碼', async () => {
    await request(app).put(`/api/projects/${projectId}/vpn`).set(auth())
      .send({ vpn_config: 'cfg', vpn_username: 'old', vpn_password: 'pw' });
    await request(app).put(`/api/projects/${projectId}/vpn`).set(auth()).send({ vpn_username: 'new' });

    const res = await request(app).get(`/api/projects/${projectId}/vpn`).set(auth());
    expect(res.body).toEqual({ has_config: true, vpn_username: 'new' });
  });

  test('一般使用者可讀但不可寫', async () => {
    const userAuth = { Authorization: `Bearer ${userToken}` };
    expect((await request(app).get(`/api/projects/${projectId}/vpn`).set(userAuth)).status).toBe(200);
    expect((await request(app).put(`/api/projects/${projectId}/vpn`).set(userAuth).send({ vpn_username: 'x' })).status).toBe(403);
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
});
