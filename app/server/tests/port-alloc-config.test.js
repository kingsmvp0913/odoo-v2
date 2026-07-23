// 意圖：測試區埠範圍必須「可依機器設定」，但預設行為不得改變——另一台 Windows 機共用同一份
// 程式碼且其 DB 內既有專案的埠都落在舊區段。且 loopback host 的推導基準必須與 PORT_MIN 脫鉤，
// 否則某機調高 PORT_MIN 後，該機既有低位埠會算出負數 n → 無效 host → 既有專案測試區網址壞掉。

// 每個案例都要拿「重新載入後的模組」，因為 PORT_MIN/PORT_MAX 是模組載入時決定的。
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

test('未設定時維持既有預設 8069/20068（Windows 機零影響）', () => {
  const mod = loadFresh();
  expect(mod.PORT_MIN).toBe(8069);
  expect(mod.PORT_MAX).toBe(20068);
});

test('PROJECT_PORT_MIN/MAX 可覆寫成本機專用區段', () => {
  const mod = loadFresh({ PROJECT_PORT_MIN: '21000', PROJECT_PORT_MAX: '24000' });
  expect(mod.PORT_MIN).toBe(21000);
  expect(mod.PORT_MAX).toBe(24000);
});

test('LOOPBACK_BASE 固定 8069，不隨 PORT_MIN 移動', () => {
  expect(loadFresh().LOOPBACK_BASE).toBe(8069);
  expect(loadFresh({ PROJECT_PORT_MIN: '21000' }).LOOPBACK_BASE).toBe(8069);
});

test('PORT_MIN 調高後，既有低位埠的 host 映射不變（不得產生負數 n）', () => {
  const mod = loadFresh({ PROJECT_PORT_MIN: '21000', PROJECT_PORT_MAX: '24000' });
  expect(mod.loopbackHostForPort(8069)).toBe('127.0.0.2');
  expect(mod.loopbackHostForPort(8070)).toBe('127.0.0.3');
});

test('新區段 21000-24000 映射到合法且唯一的 127/8 位址', () => {
  const mod = loadFresh({ PROJECT_PORT_MIN: '21000', PROJECT_PORT_MAX: '24000' });
  expect(mod.loopbackHostForPort(21000)).toBe('127.0.50.133');
  expect(mod.loopbackHostForPort(24000)).toBe('127.0.62.61');
  const hosts = [21000, 21001, 22500, 24000].map(mod.loopbackHostForPort);
  expect(new Set(hosts).size).toBe(hosts.length);
});
