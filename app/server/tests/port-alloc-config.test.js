// 意圖：測試區埠範圍必須「可依機器設定」，且優先序為 DB 設定 > env > 預設值——
// 管理員在介面改完要立刻生效（執行期讀取），但既有只設 config.json 的部署行為不得改變。
// 預設值採高位段 21000-21012：8069/8080 是 Odoo 與 Tomcat 等常見服務的預設埠，本機開發極易相撞。
// loopback host 的推導基準必須與 PORT_MIN 脫鉤，否則調高 PORT_MIN 後既有低位埠會算出負數 n → 無效 host。
const { newDb } = require('pg-mem');

function loadFresh(env = {}) {
  jest.resetModules();
  const saved = {};
  for (const k of ['PROJECT_PORT_MIN', 'PROJECT_PORT_MAX']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const mod = require('../port-alloc');
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return mod;
}

// 意圖：內部池不再受 NAT 放行段限制，上限只受主機資源限制。
test('未設定時預設 21000/21019（高位段，避開 8069/8080 常見服務）', () => {
  const mod = loadFresh();
  expect(mod.DEFAULT_PORT_MIN).toBe(21000);
  expect(mod.DEFAULT_PORT_MAX).toBe(21019);
});

test('LOOPBACK_BASE 固定 8069，不隨 PORT_MIN 移動', () => {
  expect(loadFresh().LOOPBACK_BASE).toBe(8069);
  expect(loadFresh({ PROJECT_PORT_MIN: '30000' }).LOOPBACK_BASE).toBe(8069);
});

test('PORT_MIN 調高後，既有低位埠的 host 映射不變（不得產生負數 n）', () => {
  const mod = loadFresh({ PROJECT_PORT_MIN: '30000', PROJECT_PORT_MAX: '30100' });
  expect(mod.loopbackHostForPort(8069)).toBe('127.0.0.2');
  expect(mod.loopbackHostForPort(8070)).toBe('127.0.0.3');
});

test('21000-21012 映射到合法且唯一的 127/8 位址', () => {
  const mod = loadFresh();
  expect(mod.loopbackHostForPort(21000)).toBe('127.0.50.133');
  const hosts = [21000, 21001, 21006, 21012].map(mod.loopbackHostForPort);
  expect(new Set(hosts).size).toBe(hosts.length);
});

describe('getPoolRange 優先序', () => {
  let dbModule, getPoolRange;

  beforeAll(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    ({ getPoolRange } = require('../port-alloc'));
  });

  afterAll(() => { dbModule._setPoolForTesting(null); });

  beforeEach(async () => { await dbModule.query('DELETE FROM teams_settings'); });

  test('DB 未設 + env 未設 → 用預設值 21000/21019', async () => {
    delete process.env.PROJECT_PORT_MIN;
    delete process.env.PROJECT_PORT_MAX;
    expect(await getPoolRange()).toEqual({ min: 21000, max: 21019 });
  });

  test('DB 未設 + env 有設 → 用 env（既有只設 config.json 的部署行為不變）', async () => {
    process.env.PROJECT_PORT_MIN = '30000';
    process.env.PROJECT_PORT_MAX = '30050';
    try {
      expect(await getPoolRange()).toEqual({ min: 30000, max: 30050 });
    } finally {
      delete process.env.PROJECT_PORT_MIN;
      delete process.env.PROJECT_PORT_MAX;
    }
  });

  // 意圖：管理員在介面改完必須「下一次借埠就生效」，不能要求重啟 server。
  test('DB 有設 → 蓋過 env，且不需重新載入模組即生效', async () => {
    process.env.PROJECT_PORT_MIN = '30000';
    process.env.PROJECT_PORT_MAX = '30050';
    try {
      await dbModule.query('INSERT INTO teams_settings (id, port_pool_min, port_pool_max) VALUES (1, 21000, 21030)');
      expect(await getPoolRange()).toEqual({ min: 21000, max: 21030 });
      await dbModule.query('UPDATE teams_settings SET port_pool_max=21040 WHERE id=1');
      expect(await getPoolRange()).toEqual({ min: 21000, max: 21040 });
    } finally {
      delete process.env.PROJECT_PORT_MIN;
      delete process.env.PROJECT_PORT_MAX;
    }
  });

  test('DB 只設了一半（min 有值 max 為 NULL）→ 該項退回 env／預設，不當成 0', async () => {
    await dbModule.query('INSERT INTO teams_settings (id, port_pool_min) VALUES (1, 21005)');
    expect(await getPoolRange()).toEqual({ min: 21005, max: 21019 });
  });
});
