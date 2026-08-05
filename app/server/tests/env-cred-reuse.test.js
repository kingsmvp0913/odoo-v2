// 意圖（#1 SSO bad sig 根因）：SSO 簽章 secret 平台端存 odoo_envs、Odoo 端存 ir.config_parameter，
// 兩者必須逐字相同才驗得過章。若每次建置都重產 secret 並立刻寫進 odoo_envs，重建期間（Odoo 端尚未
// 被 seed 重寫、舊容器仍在服務）平台與 Odoo 的 secret 會脫鉤 → 隨機 bad sig、F5 才好。
// _ensureEnvCredentials 必須「沿用既有 secret、只在缺值時才產」，讓兩端恆為同一把。
// 這支測 intent（reuse），不是測「有沒有呼叫 randomBytes」——後者用 env-agent.test.js 的靜態斷言鎖。
const { newDb } = require('pg-mem');

let dbModule, envAgent;
const PID = 7001;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-cred', '17.0', 'credx')`
  );
  envAgent = require('../pipeline/env-agent');
});

afterAll(async () => {
  dbModule._setPoolForTesting(null);
});

beforeEach(async () => {
  await dbModule.query('DELETE FROM odoo_envs');
});

test('既有 secret → 沿用（不因重建而換新，兩端不脫鉤）', async () => {
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, sso_secret, e2e_password) VALUES ($1,'setting_up','KEEP_SECRET','KEEP_PW')",
    [PID]
  );
  const creds = await envAgent._ensureEnvCredentials(PID);
  expect(creds.ssoSecret).toBe('KEEP_SECRET');
  expect(creds.e2ePassword).toBe('KEEP_PW');
  const { rows: [row] } = await dbModule.query('SELECT sso_secret, e2e_password FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(row.sso_secret).toBe('KEEP_SECRET');
  expect(row.e2e_password).toBe('KEEP_PW');
});

test('缺值（首建）→ 產新的並寫入', async () => {
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status) VALUES ($1,'setting_up')",
    [PID]
  );
  const creds = await envAgent._ensureEnvCredentials(PID);
  expect(creds.ssoSecret).toMatch(/^[0-9a-f]{64}$/);          // 32-byte hex
  expect(creds.e2ePassword).toEqual(expect.any(String));
  expect(creds.e2ePassword.length).toBeGreaterThan(0);
  const { rows: [row] } = await dbModule.query('SELECT sso_secret, e2e_password FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(row.sso_secret).toBe(creds.ssoSecret);
  expect(row.e2e_password).toBe(creds.e2ePassword);
});

test('只缺其一 → 只補缺的、另一個沿用', async () => {
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, sso_secret) VALUES ($1,'setting_up','ONLY_SECRET')",
    [PID]
  );
  const creds = await envAgent._ensureEnvCredentials(PID);
  expect(creds.ssoSecret).toBe('ONLY_SECRET');                 // 沿用
  expect(creds.e2ePassword).toMatch(/.+/);                     // 補上
});
