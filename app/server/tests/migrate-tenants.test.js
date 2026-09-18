/**
 * migrate-tenants.test.js — 一次性遷移（規格 §4.5）
 *
 * 守的是「遷移完，現有的人看到的東西不變」：
 *  - 9 個 admin 留 NULL（他們本來就看全部）
 *  - 6 個 user 掛內部公司，而內部公司綁了全部專案 ⇒ 還是看得到全部
 *  - 每個專案都要綁到，漏一個就有人突然看不到某個專案
 * 以及「可以重跑」——遷移腳本最怕的是跑一半失敗之後不敢再跑。
 */
const { newDb } = require('pg-mem');
const { planTenantMigration, applyTenantMigration } = require('../../../tools/migrate-tenants');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('a1', 'x', '管理一', 'admin'), ('a2', 'x', '管理二', 'admin'), ('u1', 'x', '一般一', 'user'), ('u2', 'x', '一般二', 'user')"
  );
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p1', '17'), ('p2', '17'), ('p3', '17')");
});

afterAll(() => dbModule._setPoolForTesting(null));

test('plan 列出要建的內部公司、要掛公司的帳號、要綁的專案（還沒寫任何東西）', async () => {
  const plan = await planTenantMigration(dbModule.query);
  expect(plan.internalCompany.exists).toBe(false);
  expect(plan.usersToAssign.map(u => u.username).sort()).toEqual(['u1', 'u2']);
  expect(plan.projectsToBind).toHaveLength(3);

  const { rows } = await dbModule.query('SELECT COUNT(*)::int n FROM companies');
  expect(rows[0].n).toBe(0);
});

test('apply 之後：內部公司存在且啟用、admin 仍是 NULL、user 掛上公司、專案全綁', async () => {
  const plan = await planTenantMigration(dbModule.query);
  const res = await applyTenantMigration(dbModule.query, plan);
  expect(res.companyCreated).toBe(true);
  expect(res.usersUpdated).toBe(2);
  expect(res.projectsBound).toBe(3);

  const { rows: [co] } = await dbModule.query("SELECT id, is_active, is_internal FROM companies WHERE name = '內部'");
  expect(co.is_active).toBe(true);
  expect(co.is_internal).toBe(true);

  const { rows: admins } = await dbModule.query("SELECT company_id FROM users WHERE role = 'admin'");
  expect(admins.every(r => r.company_id === null)).toBe(true);

  const { rows: users } = await dbModule.query("SELECT company_id FROM users WHERE role = 'user'");
  expect(users.every(r => r.company_id === co.id)).toBe(true);

  const { rows: [bind] } = await dbModule.query(
    'SELECT COUNT(*)::int n FROM project_companies WHERE company_id = $1', [co.id]
  );
  expect(bind.n).toBe(3);
});

test('綁定一律 can_release=false（內部公司不能按上正式，規格 §4.3）', async () => {
  const { rows } = await dbModule.query('SELECT can_release FROM project_companies');
  expect(rows.every(r => r.can_release === false)).toBe(true);
});

test('再跑一次不會重複建、不會報錯（跑一半失敗要敢重跑）', async () => {
  const plan = await planTenantMigration(dbModule.query);
  expect(plan.internalCompany.exists).toBe(true);
  expect(plan.usersToAssign).toHaveLength(0);
  expect(plan.projectsToBind).toHaveLength(0);

  const res = await applyTenantMigration(dbModule.query, plan);
  expect(res).toEqual({ companyCreated: false, usersUpdated: 0, projectsBound: 0 });

  const { rows } = await dbModule.query('SELECT COUNT(*)::int n FROM companies');
  expect(rows[0].n).toBe(1);
});

test('遷移後新增的專案會被下一次 plan 撿到（漏綁＝有人看不到那個專案）', async () => {
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p4', '17')");
  const plan = await planTenantMigration(dbModule.query);
  expect(plan.projectsToBind.map(p => p.name)).toEqual(['p4']);
});
