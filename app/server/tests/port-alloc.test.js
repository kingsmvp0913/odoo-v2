// 意圖：每專案固定分配專屬測試埠，取 [8069, PORT_MAX] 內「最低未占用」的埠。
// 刪專案（硬刪除）釋放的埠會被下一次建立回收——故中間空洞要能被填回，不是只會往上爬。
const { newDb } = require('pg-mem');

let dbModule, allocateProjectPort, loopbackHostForPort;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ allocateProjectPort, loopbackHostForPort } = require('../port-alloc'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => { await dbModule.query('DELETE FROM projects'); });

async function mkProject(name, port) {
  await dbModule.query("INSERT INTO projects (name, odoo_version, port) VALUES ($1,'17.0',$2)", [name, port]);
}

test('無專案 → 配起點 8069', async () => {
  expect(await allocateProjectPort()).toBe(8069);
});

test('已配 8069、8070 → 給 8071（往上遞增）', async () => {
  await mkProject('a', 8069);
  await mkProject('b', 8070);
  expect(await allocateProjectPort()).toBe(8071);
});

test('中間空洞（8070 已被刪專案釋放）→ 回收最低空埠 8070', async () => {
  await mkProject('a', 8069);
  await mkProject('c', 8071);
  expect(await allocateProjectPort()).toBe(8070);
});

// 意圖：每專案專屬 loopback host，cookie 依 host 隔離；起點跳過 127.0.0.1，且進位正確。
test('起點 port 8069 → 127.0.0.2（跳過 .0/.1）；相鄰 port 得相鄰 host', () => {
  expect(loopbackHostForPort(8069)).toBe('127.0.0.2');
  expect(loopbackHostForPort(8070)).toBe('127.0.0.3');
});

test('跨 octet 進位正確（第 254 個 → 127.0.1.0）', () => {
  // n = (8069+254-8069)+2 = 256 → 127.0.1.0
  expect(loopbackHostForPort(8069 + 254)).toBe('127.0.1.0');
});

test('不同 port → 不同 host（cookie 隔離的前提）', () => {
  const hosts = [8069, 8070, 8323, 9000].map(loopbackHostForPort);
  expect(new Set(hosts).size).toBe(hosts.length);
});
