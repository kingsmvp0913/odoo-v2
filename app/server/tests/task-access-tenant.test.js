/**
 * task-access-tenant.test.js — 任務權限單點加上租戶邊界（規格 §5.2）
 *
 * loadTaskForActor 是 pipeline-routes 與 tasks-routes 全部關卡端點的共同入口，
 * 所以這一支的正確性等於整條 pipeline 的租戶邊界。
 * 特別守住兩件事：
 *  1. project_id 是 NULL 的非專案任務不能被新檢查誤殺
 *  2. admin 照舊看得到全部（他本來就是這樣，改壞了整個平台管理功能都會斷）
 */
const { newDb } = require('pg-mem');
const { loadTaskForActor } = require('../lib/task-access');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, aId, bId, pA, taskInA, taskNoProject, userA, userB;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

  aId = (await one('INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', ['甲公司'])).id;
  bId = (await one('INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', ['乙公司'])).id;
  pA = (await one("INSERT INTO projects (name, odoo_version) VALUES ('甲專案', '17') RETURNING id")).id;
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)', [pA, aId]);

  userA = (await one(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('ua','x','甲員','user',$1) RETURNING id", [aId]
  )).id;
  userB = (await one(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('ub','x','乙員','user',$1) RETURNING id", [bId]
  )).id;

  taskInA = (await one(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'t1','manual','甲的任務','new',$2) RETURNING id",
    [userA, pA]
  )).id;
  taskNoProject = (await one(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'t2','manual','沒有專案的任務','new') RETURNING id",
    [userA]
  )).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

const req = (userId, companyId, over = {}) => ({
  userId, isAdmin: false,
  actor: { userId, role: 'user', companyId, isPlatformAdmin: false, isCompanyAdmin: false, isInternal: false, companyUsable: true, ...over },
});

test('本人 + 專案看得到 → 拿得到任務', async () => {
  expect(await loadTaskForActor(taskInA, req(userA, aId), 'id, user_id, project_id')).not.toBeNull();
});

test('別家公司的人即使硬帶任務 id 也拿不到', async () => {
  expect(await loadTaskForActor(taskInA, req(userB, bId), 'id, user_id, project_id')).toBeNull();
});

test('本人但公司沒綁那個專案 → 拿不到（公司綁定被解除後立刻生效）', async () => {
  await dbModule.query('DELETE FROM project_companies WHERE project_id = $1 AND company_id = $2', [pA, aId]);
  expect(await loadTaskForActor(taskInA, req(userA, aId), 'id, user_id, project_id')).toBeNull();
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)', [pA, aId]);
});

test('project_id 是 NULL 的非專案任務不能被誤殺', async () => {
  expect(await loadTaskForActor(taskNoProject, req(userA, aId), 'id, user_id, project_id')).not.toBeNull();
});

test('平台管理員照舊看得到全部（含別人的、含沒綁公司的專案）', async () => {
  const adminReq = {
    userId: 999, isAdmin: true,
    actor: { userId: 999, role: 'admin', companyId: null, isPlatformAdmin: true, isCompanyAdmin: false, isInternal: false, companyUsable: true },
  };
  expect(await loadTaskForActor(taskInA, adminReq, 'id, user_id, project_id')).not.toBeNull();
});
