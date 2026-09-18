/**
 * tenant-schema.test.js — 租戶隔離的資料模型（規格 §4）
 *
 * 這支守的是「遷移跑完，公司這一層的欄位真的存在且帶著該有的約束」。
 * 約束測的是意圖而不是欄位有沒有出現：
 *  - is_internal 只能有一筆 true（誤標第二筆＝客戶公司拿平台的訂閱跑 AI，違反 Anthropic 條款）
 *  - project_companies 的 project_id 必須 ON DELETE CASCADE（不帶會擋死刪專案，記憶 spec-trio-executed）
 *  - can_release 預設 false（規格 §4.3：預設不勾）
 *
 * pg-mem 限制：information_schema.columns.is_nullable 對這張表一律回報 'NO'
 *（連沒有約束的既有欄位也一樣），與遷移本身無關，見 users.company_id 那支的內文說明。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => dbModule._setPoolForTesting(null));

const cols = async (table) => {
  const { rows } = await dbModule.query(
    'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1',
    [table]
  );
  return Object.fromEntries(rows.map(r => [r.column_name, r]));
};

test('companies 表存在且欄位齊全', async () => {
  const c = await cols('companies');
  for (const name of ['id', 'name', 'is_active', 'is_internal', 'active_from', 'active_until',
                      'git_pat_enc', 'git_login', 'git_name', 'git_email', 'created_at', 'updated_at']) {
    expect(c[name]).toBeDefined();
  }
});

test('companies.is_active 與 is_internal 預設 false（安全值，只有明確路徑寫 true）', async () => {
  await dbModule.query("INSERT INTO companies (name) VALUES ('預設值測試')");
  const { rows } = await dbModule.query("SELECT is_active, is_internal FROM companies WHERE name = '預設值測試'");
  expect(rows[0].is_active).toBe(false);
  expect(rows[0].is_internal).toBe(false);
});

test('內部公司只能有一筆：第二筆 is_internal=true 會被索引擋下', async () => {
  await dbModule.query("INSERT INTO companies (name, is_internal) VALUES ('內部', true)");
  await expect(
    dbModule.query("INSERT INTO companies (name, is_internal) VALUES ('假的內部', true)")
  ).rejects.toThrow();
});

test('users.company_id 存在且可為 NULL（平台管理員沒有公司）', async () => {
  const c = await cols('users');
  expect(c.company_id).toBeDefined();
  // 不用 information_schema.is_nullable 判斷：實測 pg-mem 對這張表所有欄位一律回報 'NO'
  // （連沒有任何約束的既有欄位，例如 sync_interval，也一樣），是 pg-mem 本身模擬
  // information_schema 的限制，與這次遷移有沒有下 NOT NULL 無關、也測不出真正的保證。
  // 改成直接驗證「真的能寫入 NULL」這個要保護的行為本身。
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('nullco_admin', 'x', '無公司管理員')"
  );
  const { rows } = await dbModule.query(
    "SELECT company_id FROM users WHERE username = 'nullco_admin'"
  );
  expect(rows[0].company_id).toBeNull();
});

test('project_companies 的 can_release 預設 false', async () => {
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('綁定測試專案', '17')");
  const { rows: [p] } = await dbModule.query("SELECT id FROM projects WHERE name = '綁定測試專案'");
  const { rows: [co] } = await dbModule.query("SELECT id FROM companies WHERE name = '內部'");
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)', [p.id, co.id]);
  const { rows } = await dbModule.query(
    'SELECT can_release FROM project_companies WHERE project_id = $1 AND company_id = $2', [p.id, co.id]
  );
  expect(rows[0].can_release).toBe(false);
});

test('刪專案會連帶刪掉它的公司綁定（沒有 CASCADE 會擋死刪除）', async () => {
  const { rows: [p] } = await dbModule.query("SELECT id FROM projects WHERE name = '綁定測試專案'");
  await dbModule.query('DELETE FROM projects WHERE id = $1', [p.id]);
  const { rows } = await dbModule.query('SELECT * FROM project_companies WHERE project_id = $1', [p.id]);
  expect(rows).toHaveLength(0);
});
