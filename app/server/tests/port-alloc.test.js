// 意圖：port 改租約制——啟動測試區時借、停止時還，故專案總數不再受對外放行埠數限制。
// 租約載體是 odoo_envs.port（非 projects.port）；併發撞埠由 partial UNIQUE 擋下、呼叫端重取。
const { newDb } = require('pg-mem');

let dbModule, leasePort, releasePort;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ leasePort, releasePort } = require('../port-alloc'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
  await dbModule.query('DELETE FROM teams_settings');
});

async function mkProject(name) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id", [name]
  );
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'idle')", [p.id]);
  return p.id;
}

// 探測 stub：本檔驗的是「DB 佔用」邏輯，不該真的去綁宿主的埠（會隨執行環境而 flaky）。
const ALL_FREE = { isPortFree: async () => true };

test('無人租用 → 借到池起點 21000', async () => {
  const pid = await mkProject('a');
  expect(await leasePort(pid, ALL_FREE)).toBe(21000);
});

test('借到的埠會寫進 odoo_envs.port（租約載體不是 projects.port）', async () => {
  const pid = await mkProject('a');
  await leasePort(pid, ALL_FREE);
  const { rows: [env] } = await dbModule.query('SELECT port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(env.port).toBe(21000);
  const { rows: [proj] } = await dbModule.query('SELECT port FROM projects WHERE id=$1', [pid]);
  expect(proj.port).toBeNull();
});

test('21000、21001 已被租用 → 借到 21002（往上遞增）', async () => {
  const a = await mkProject('a'); await leasePort(a, ALL_FREE);
  const b = await mkProject('b'); await leasePort(b, ALL_FREE);
  const c = await mkProject('c');
  expect(await leasePort(c, ALL_FREE)).toBe(21002);
});

// 意圖：這正是租約制的核心價值——還回去的埠必須真的能再借出，否則池子會單向耗盡。
test('releasePort 後該埠回到池中，下一個借得到', async () => {
  const a = await mkProject('a'); await leasePort(a, ALL_FREE);
  const b = await mkProject('b'); await leasePort(b, ALL_FREE); // 21001
  await releasePort(a); // 還掉 21000
  const c = await mkProject('c');
  expect(await leasePort(c, ALL_FREE)).toBe(21000);
});

test('releasePort 把 odoo_envs.port 設回 NULL', async () => {
  const pid = await mkProject('a');
  await leasePort(pid, ALL_FREE);
  await releasePort(pid);
  const { rows: [env] } = await dbModule.query('SELECT port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(env.port).toBeNull();
});

// 意圖：DB 記錄不等於宿主現況——同機其他服務可能已佔用該埠。不實際探測的話，
// 借埠會成功但 docker run 失敗，症狀完全不指向真正的佔用者。
test('宿主已被佔用的埠會被跳過（DB 內毫無記錄也擋得下）', async () => {
  const pid = await mkProject('a');
  const busyOnHost = new Set([21000, 21001]);
  const port = await leasePort(pid, { isPortFree: async (host, p) => !busyOnHost.has(p) });
  expect(port).toBe(21002);
});

// 意圖：探測位址必須與 docker 待會實際綁定的位址一致。衝突多來自他人綁 0.0.0.0:<port>，
// 而 0.0.0.0 被佔時再綁 127.0.0.x 同埠會 EADDRINUSE；探 0.0.0.0 或 127.0.0.1 都會漏判。
test('探測的是該埠對應的 loopback host，而非 0.0.0.0 或 127.0.0.1', async () => {
  const pid = await mkProject('a');
  const probed = [];
  await leasePort(pid, { isPortFree: async (host, p) => { probed.push([host, p]); return true; } });
  expect(probed[0]).toEqual(['127.0.50.133', 21000]);
});

test('池範圍可由 teams_settings 縮小，借埠即刻遵守', async () => {
  await dbModule.query('INSERT INTO teams_settings (id, port_pool_min, port_pool_max) VALUES (1, 21005, 21006)');
  const pid = await mkProject('a');
  expect(await leasePort(pid, ALL_FREE)).toBe(21005);
});

// 意圖：撞 partial UNIQUE 時必須自動重取下一個埠，而不是把 23505 拋給使用者。
// pg-mem 不保證支援 partial index，故直接注入一個「第一次寫入必撞」的 stub 來驗重取路徑。
test('寫入撞 UNIQUE（23505）→ 自動重取下一個埠', async () => {
  const pid = await mkProject('a');
  let firstWrite = true;
  const port = await leasePort(pid, {
    isPortFree: async () => true,
    claim: async (projectId, p) => {
      if (firstWrite) { firstWrite = false; const e = new Error('dup'); e.code = '23505'; throw e; }
      await dbModule.query('UPDATE odoo_envs SET port=$2 WHERE project_id=$1', [projectId, p]);
      return true;
    },
  });
  expect(port).toBe(21001);
});

test('池全滿且無可徵收 → 拋出錯誤，訊息含池範圍', async () => {
  await dbModule.query('INSERT INTO teams_settings (id, port_pool_min, port_pool_max) VALUES (1, 21000, 21001)');
  const a = await mkProject('a'); await leasePort(a, ALL_FREE);
  const b = await mkProject('b'); await leasePort(b, ALL_FREE);
  const c = await mkProject('c');
  await expect(leasePort(c, ALL_FREE)).rejects.toThrow(/21000-21001/);
});
