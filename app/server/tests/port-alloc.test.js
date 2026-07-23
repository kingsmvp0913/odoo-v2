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

// 探測 stub：既有案例只驗「DB 佔用」的邏輯，不該真的去綁宿主的埠（會隨執行環境而 flaky）。
const ALL_FREE = { isPortFree: async () => true };

test('無專案 → 配起點 8069', async () => {
  expect(await allocateProjectPort(ALL_FREE)).toBe(8069);
});

test('已配 8069、8070 → 給 8071（往上遞增）', async () => {
  await mkProject('a', 8069);
  await mkProject('b', 8070);
  expect(await allocateProjectPort(ALL_FREE)).toBe(8071);
});

test('中間空洞（8070 已被刪專案釋放）→ 回收最低空埠 8070', async () => {
  await mkProject('a', 8069);
  await mkProject('c', 8071);
  expect(await allocateProjectPort(ALL_FREE)).toBe(8070);
});

// 意圖：DB 記錄不等於宿主現況——同一台機器上其他服務／容器可能已佔用該埠。配發時若不實際探測，
// 專案建立會成功但測試區 docker run 失敗，症狀（「測試區建置失敗」）完全不指向真正的佔用者。
test('宿主已被佔用的埠會被跳過（DB 內毫無記錄也擋得下）', async () => {
  const busyOnHost = new Set([8069, 8070]);
  const port = await allocateProjectPort({ isPortFree: async (host, p) => !busyOnHost.has(p) });
  expect(port).toBe(8071);
});

// 意圖：探測位址必須與 docker 待會實際綁定的位址一致。衝突多來自他人綁 0.0.0.0:<port>，
// 而 0.0.0.0 被佔時再綁 127.0.0.x 同埠會 EADDRINUSE；探 0.0.0.0 或 127.0.0.1 都會漏判。
test('探測的是該埠對應的 loopback host，而非 0.0.0.0 或 127.0.0.1', async () => {
  const probed = [];
  await allocateProjectPort({ isPortFree: async (host, p) => { probed.push([host, p]); return true; } });
  expect(probed[0]).toEqual(['127.0.0.2', 8069]);
});

// 意圖：DB 佔用與宿主佔用是兩個獨立來源，必須同時生效。
test('DB 佔用與宿主佔用同時存在時，兩者都要跳過', async () => {
  await mkProject('a', 8069);
  const busyOnHost = new Set([8070]);
  const port = await allocateProjectPort({ isPortFree: async (host, p) => !busyOnHost.has(p) });
  expect(port).toBe(8071);
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
