// 意圖：未設 context7 API key 時走匿名額度，配額用盡**不會**變成錯誤——MCP 照常回應、內容是一句
// "Monthly quota exceeded"，工具呼叫仍算成功。於是各關拿不到 Odoo 官方寫法，改用 WebSearch 抓
// 原始碼（慢、不準、常不記帳），全程無告警。此模組是那把 key 的載入／快取／失效出口。
//
// 快取是刻意的：context7ConfigPath() 必須同步取得 key（見 rules/testing 26），
// 故非同步只發生在啟動載入與管理員存檔。
const { newDb } = require('pg-mem');

process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-for-context7-auth';

let dbModule, context7Auth, encrypt;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ encrypt } = require('../lib/crypto'));
  context7Auth = require('../lib/context7-auth');
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('UPDATE teams_settings SET context7_api_key_enc = NULL WHERE id = 1');
  context7Auth._setForTesting(null);
});

// 回 null 而非空字串：呼叫端據此決定「不寫 env」，寫 '' 會蓋掉手動設定的 CONTEXT7_API_KEY
test('未設定 → getContext7ApiKey 回 null（不得回空字串）', async () => {
  await context7Auth.loadContext7Key();
  expect(context7Auth.getContext7ApiKey()).toBe(null);
});

test('已設定 → 解密後回傳明文 key', async () => {
  await dbModule.query('UPDATE teams_settings SET context7_api_key_enc = $1 WHERE id = 1', [encrypt('ctx7-abc123')]);
  await context7Auth.loadContext7Key();
  expect(context7Auth.getContext7ApiKey()).toBe('ctx7-abc123');
});

// 快取語意：讀取端同步，DB 改了但沒 reset 就不該生效。
// 這正是「管理員存檔後不必重啟 server」的實作依據。
test('DB 換了 key 但未 reset → 維持舊值；resetContext7KeyCache 後才換新', async () => {
  await dbModule.query('UPDATE teams_settings SET context7_api_key_enc = $1 WHERE id = 1', [encrypt('old-key')]);
  await context7Auth.loadContext7Key();
  await dbModule.query('UPDATE teams_settings SET context7_api_key_enc = $1 WHERE id = 1', [encrypt('new-key')]);
  expect(context7Auth.getContext7ApiKey()).toBe('old-key');
  await context7Auth.resetContext7KeyCache();
  expect(context7Auth.getContext7ApiKey()).toBe('new-key');
});

// APP_SECRET 換過／blob 損壞：啟動載入若 throw 會讓整台 server 起不來，退回匿名額度即可
test('密文壞掉 → 視為未設定，不得 throw', async () => {
  await dbModule.query("UPDATE teams_settings SET context7_api_key_enc = 'not-a-valid-blob' WHERE id = 1");
  await expect(context7Auth.loadContext7Key()).resolves.toBeUndefined();
  expect(context7Auth.getContext7ApiKey()).toBe(null);
});
