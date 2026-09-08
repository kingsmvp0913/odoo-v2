const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-switch';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, sw;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1)');
  sw = require('../lib/auto-deploy-switch');
});

test('預設關閉', async () => {
  expect(await sw.isAutoDeployEnabled()).toBe(false);
});

// 意圖（Rule 9）：這是整支測試存在的理由。平台是常駐進程，若開關值被快取在模組變數，
// 使用者關掉開關後要重啟 server 才生效——症狀是「我明明關了它還在部署」，最難查。
// 有人加快取時這條會立刻紅。
test('開關改值後下一次呼叫立刻吃到新值（不可快取）', async () => {
  await dbModule.query('UPDATE teams_settings SET auto_deploy_enabled = true WHERE id = 1');
  expect(await sw.isAutoDeployEnabled()).toBe(true);
  await dbModule.query('UPDATE teams_settings SET auto_deploy_enabled = false WHERE id = 1');
  expect(await sw.isAutoDeployEnabled()).toBe(false);
});

test('teams_settings 整列不存在時視為關閉，不是 throw', async () => {
  await dbModule.query('DELETE FROM teams_settings WHERE id = 1');
  expect(await sw.isAutoDeployEnabled()).toBe(false);
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1)');
});

test('middleware 關閉時回 403', async () => {
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } };
  let nextCalled = false;
  await sw.requireAutoDeploy({}, res, () => { nextCalled = true; });
  expect(nextCalled).toBe(false);
  expect(res.statusCode).toBe(403);
  expect(res.body.error).toMatch(/停用/);
});

test('middleware 開啟時放行', async () => {
  await dbModule.query('UPDATE teams_settings SET auto_deploy_enabled = true WHERE id = 1');
  let nextCalled = false;
  await sw.requireAutoDeploy({}, { status() { return this; }, json() {} }, () => { nextCalled = true; });
  expect(nextCalled).toBe(true);
});
