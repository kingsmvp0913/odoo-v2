/**
 * tenant-routes-scope.test.js — 跨公司矩陣（規格 §9）
 *
 * 這支守的是整個產品化最核心的一句承諾：一家客戶看不到另一家客戶的任何東西。
 * 刻意用「硬帶對方的 id 打 API」的方式測，而不是只測列表——列表漏一筆只是少看到，
 * 帶 id 打得進去才是真的外洩。
 * 看不到一律期待 404 而不是 403：403 等於承認「這個 id 存在」，那本身就是外洩。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

// 「建立任務」那組會真的打 POST /api/tasks，route 結尾有 runPipeline(req.userId).catch(...)
// 這行刻意 fire-and-forget（不 await）。測試結束、pg-mem pool 被拆掉後這個背景派工才輪到執行，
// 沒接真的 DATABASE_URL 會炸「no PostgreSQL user name specified」，雖被 .catch 吞掉不影響斷言，
// 但未完成的 async 工作會讓 jest 行程 exit code 卡在 1（全綠仍非 0）。
// 比照 tasks-routes.test.js 既有寫法：只 mock runPipeline，其餘 runner 匯出照實，讓派工不再真的起跑。
jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-scope-jwt';
process.env.APP_SECRET = 'test-scope-secret';

let app, dbModule;
let adminToken, aToken, bToken;
let coA, coB, coInternal, pA, pB;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  adminToken = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  const mkCo = async (name, isInternal = false) => (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, $2) RETURNING id', [name, isInternal]
  )).id;
  coInternal = await mkCo('內部', true);
  coA = await mkCo('甲公司');
  coB = await mkCo('乙公司');

  const mkUser = async (username, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, 'user', companyId]
    );
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  aToken = await mkUser('userA', coA);
  bToken = await mkUser('userB', coB);

  const mkProject = async (name, companyId) => {
    const id = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", [name])).id;
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [id, companyId]);
    return id;
  };
  pA = await mkProject('甲的專案', coA);
  pB = await mkProject('乙的專案', coB);
});

afterAll(() => dbModule._setPoolForTesting(null));

const as = (t) => ({ Authorization: `Bearer ${t}` });

describe('專案', () => {
  test('列表只看得到自己公司綁的', async () => {
    const res = await request(app).get('/api/projects').set(as(aToken));
    expect(res.status).toBe(200);
    expect(res.body.map(p => p.id)).toEqual([pA]);
  });

  test('平台管理員看得到全部', async () => {
    const res = await request(app).get('/api/projects').set(as(adminToken));
    expect(res.body.map(p => p.id).sort()).toEqual([pA, pB].sort());
  });

  test('硬帶別家的專案 id → 404（不是 403，403 等於承認它存在）', async () => {
    expect((await request(app).get(`/api/projects/${pB}`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/repos`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/pending-release`).set(as(aToken))).status).toBe(404);
  });

  test('自己公司的專案照常打得開', async () => {
    expect((await request(app).get(`/api/projects/${pA}`).set(as(aToken))).status).toBe(200);
  });

  test('建立專案改成平台管理員限定', async () => {
    const res = await request(app).post('/api/projects')
      .set(as(aToken)).send({ name: '偷建的', odoo_version: '17' });
    expect(res.status).toBe(403);
  });

  test('改專案、刪專案、加 repo 都是平台管理員限定', async () => {
    expect((await request(app).patch(`/api/projects/${pA}`).set(as(aToken)).send({ description: 'x' })).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${pA}`).set(as(aToken))).status).toBe(403);
    expect((await request(app).post(`/api/projects/${pA}/repos`).set(as(aToken)).send({ label: 'x', repo_url: 'y' })).status).toBe(403);
  });
});

describe('上正式（規格 §4.3 can_release）', () => {
  test('一般使用者不能按，即使綁定勾了', async () => {
    await dbModule.query('UPDATE project_companies SET can_release = true WHERE project_id=$1 AND company_id=$2', [pA, coA]);
    const res = await request(app).post(`/api/projects/${pA}/release`).set(as(aToken)).send({});
    expect(res.status).toBe(403);
  });

  test('別家公司的人連專案都看不到，更不可能按 → 404（不是 403，403 會洩漏 id 存在）', async () => {
    const res = await request(app).post(`/api/projects/${pB}/release`).set(as(aToken)).send({});
    expect(res.status).toBe(404);
  });

  // 跟上一支分開驗證：「看不到」與「看得到但不能按」是兩種不同的拒絕，前者 404、後者 403，
  // 不能因為補了 404 就把後者也一併吃掉。用 bToken/pB 這組全新配對（bToken 屬於 coB，
  // pB 綁 coB，彼此看得到），角色不是公司管理員一樣被擋，但擋的理由必須是 403。
  test('自己公司的專案看得到但角色不夠 → 403，不是 404', async () => {
    const res = await request(app).post(`/api/projects/${pB}/release`).set(as(bToken)).send({});
    expect(res.status).toBe(403);
  });

  // 正面對照：上面兩支只釘住兩種拒絕（404／403），沒有任何一支證明「條件對了真的放得過」。
  // 第 3 部對這一行（project-routes.js:1007）有硬性的接續依賴，值得單獨釘住。不求整條 release
  // 真的跑完（要真的 clone／PAT／repo 齊全，超出本測試範圍）——只要求過了 403 這一關，
  // 往下走到下一個步驟（沒填個人 PAT）的 400，代表 canReleaseProject 真的放行了。
  test('公司管理員＋該公司綁定勾了 can_release → 過 403 這關（規格 §4.3 正向路徑）', async () => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('userA_admin',$1,'userA_admin','company_admin',$2)",
      [hash, coA]
    );
    const adminAToken = (await request(app).post('/api/auth/login')
      .send({ username: 'userA_admin', password: 'password123' })).body.token;
    const res = await request(app).post(`/api/projects/${pA}/release`).set(as(adminAToken)).send({});
    // 測試環境沒有個人 PAT，下一步 buildGitEnv 會擋在 400——這正是本測試要的證據：
    // 403（canReleaseProject）與 404（loadProjectForActor）都沒攔下它，代表真的放行過關了。
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('公司尚未設定 GIT，請聯絡平台');
  });
});

// 規格 §8 P5 後來裁決：可見專案的成員能唯讀清單；真正按上正式仍走 canReleaseProject。
describe('待上正式清單（GET pending-release，規格 §8 P5）', () => {
  test('自己公司的一般使用者可唯讀清單，但沒有上正式的權限', async () => {
    const res = await request(app).get(`/api/projects/${pA}/pending-release`).set(as(aToken));
    expect(res.status).toBe(200);
    expect(res.body.prodDeploy.canRelease).toBe(false);
  });

  test('平台管理員 → 200', async () => {
    const res = await request(app).get(`/api/projects/${pA}/pending-release`).set(as(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
  });

  test('公司管理員且該公司綁定勾了 can_release → 200（沿用上一個 describe 建的 userA_admin，pA/coA 的綁定已勾 can_release）', async () => {
    const adminAToken = (await request(app).post('/api/auth/login')
      .send({ username: 'userA_admin', password: 'password123' })).body.token;
    const res = await request(app).get(`/api/projects/${pA}/pending-release`).set(as(adminAToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
  });
});

describe('任務改掛專案（PUT /api/tasks/:taskDbId/project，規格 §5.2）', () => {
  let taskDbId;

  beforeAll(async () => {
    const { rows: [u] } = await dbModule.query("SELECT id FROM users WHERE username = 'userA'");
    // project_id 不帶＝NULL，比照「還沒掛專案」的任務去測改掛
    const { rows: [t] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'reassign-t1','manual','標題','new') RETURNING id",
      [u.id]
    );
    taskDbId = t.id;
  });

  test('改掛到別家公司的專案（body 帶 project_id）→ 404，DB 裡的 project_id 不變', async () => {
    const res = await request(app).put(`/api/tasks/${taskDbId}/project`).set(as(aToken)).send({ project_id: pB });
    expect(res.status).toBe(404);
    const { rows: [row] } = await dbModule.query('SELECT project_id FROM tasks WHERE id = $1', [taskDbId]);
    expect(row.project_id).toBeNull();
  });

  test('改掛到自己看得到的專案 → 照常成功', async () => {
    const res = await request(app).put(`/api/tasks/${taskDbId}/project`).set(as(aToken)).send({ project_id: pA });
    expect(res.status).toBe(200);
    const { rows: [row] } = await dbModule.query('SELECT project_id FROM tasks WHERE id = $1', [taskDbId]);
    expect(row.project_id).toBe(pA);
  });
});

describe('對話', () => {
  test('在別家的專案底下開對話 → 404', async () => {
    const res = await request(app).post(`/api/projects/${pB}/chats`).set(as(aToken)).send({ title: '偷開的' });
    expect(res.status).toBe(404);
  });

  test('列別家專案的對話 → 404', async () => {
    expect((await request(app).get(`/api/projects/${pB}/chats`).set(as(aToken))).status).toBe(404);
  });

  test('自己公司的專案照常開得了對話', async () => {
    // 建立成功的實際狀態碼是 201（既有行為，chat-routes.js:124），不是 200——
    // 這裡改用 201 而不動 brief 原文的 200，是修正 brief 本身的筆誤，與這支任務要驗的
    // 「範圍檢查」本身無關（詳見 task-3-report.md 的 concerns）。
    const res = await request(app).post(`/api/projects/${pA}/chats`).set(as(aToken)).send({ title: '正常的' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeGreaterThan(0);
  });
});

describe('wiki', () => {
  test('讀別家專案的 wiki → 404', async () => {
    expect((await request(app).get(`/api/projects/${pB}/wiki/overview`).set(as(aToken))).status).toBe(404);
  });

  test('改別家專案的 wiki → 404', async () => {
    const res = await request(app).put(`/api/projects/${pB}/wiki/overview`).set(as(aToken)).send({ content: '偷改' });
    expect(res.status).toBe(404);
  });

  test('重建別家專案的 wiki → 404（這支會叫 AI，擋不住等於幫別家燒錢）', async () => {
    expect((await request(app).post(`/api/projects/${pB}/wiki/overview/refresh`).set(as(aToken)).send({})).status).toBe(404);
  });
});

describe('測試環境', () => {
  test('用別家的專案 id 進測試區 SSO → 404（測試區帳號是 admin，這支漏掉等於沒做隔離）', async () => {
    expect((await request(app).get(`/api/projects/${pB}/env/sso`).set(as(aToken))).status).toBe(404);
  });

  test('看別家的測試區狀態、log → 404', async () => {
    expect((await request(app).get(`/api/projects/${pB}/env`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/env/log`).set(as(aToken))).status).toBe(404);
  });

  test('建立／停止／刪除測試區改成平台管理員限定（自己公司的也不行）', async () => {
    expect((await request(app).post(`/api/projects/${pA}/env/setup`).set(as(aToken)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/projects/${pA}/env/stop`).set(as(aToken)).send({})).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${pA}/env`).set(as(aToken))).status).toBe(403);
  });

  test('測試區總覽只列自己公司的專案', async () => {
    const res = await request(app).get('/api/projects/env-summaries').set(as(aToken));
    expect(res.status).toBe(200);
    const ids = (Array.isArray(res.body) ? res.body : res.body.items || []).map(r => r.project_id ?? r.projectId);
    expect(ids).not.toContain(pB);
  });
});

describe('資料庫查詢頁（規格 §2：對客戶完全關閉）', () => {
  test('一般使用者一律 403，連自己公司的專案也是', async () => {
    expect((await request(app).get(`/api/projects/${pA}/db-connections`).set(as(aToken))).status).toBe(403);
    expect((await request(app).get(`/api/projects/${pA}/vpn`).set(as(aToken))).status).toBe(403);
    expect((await request(app).post(`/api/projects/${pA}/db-connections/test`).set(as(aToken)).send({})).status).toBe(403);
  });

  test('平台管理員照常可用', async () => {
    expect((await request(app).get(`/api/projects/${pA}/db-connections`).set(as(adminToken))).status).toBe(200);
  });
});

describe('搜尋', () => {
  test('專案搜尋只回自己公司綁的（打一個字就列出所有客戶的專案名是最廉價的外洩）', async () => {
    const res = await request(app).get('/api/search?q=專案').set(as(aToken));
    expect(res.status).toBe(200);
    const names = (res.body.projects || []).map(p => p.name);
    expect(names).toContain('甲的專案');
    expect(names).not.toContain('乙的專案');
  });

  test('平台管理員搜得到全部', async () => {
    const res = await request(app).get('/api/search?q=專案').set(as(adminToken));
    const names = (res.body.projects || []).map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['甲的專案', '乙的專案']));
  });
});

describe('建立任務', () => {
  test('把任務建在別家的專案底下 → 404（否則會產生一張誰都打不開、AI 卻照跑的殭屍任務）', async () => {
    const res = await request(app).post('/api/tasks').set(as(aToken))
      .send({ title: '偷建的', original_text: 'x', project_id: pB });
    expect(res.status).toBe(404);
  });

  test('建在自己公司的專案底下照常成功，而且本人打得開', async () => {
    // 建立成功的實際狀態碼是 201（既有行為，tasks-routes.js 該 handler 最後一行 res.status(201)），
    // 不是 brief 原文的 200——修正 brief 本身的筆誤，與這支任務要驗的「範圍檢查」本身無關
    // （同一份 brief 系列在「對話」describe 已有前例：task-3-report.md 的 concerns）。
    const created = await request(app).post('/api/tasks').set(as(aToken))
      .send({ title: '正常的', original_text: 'x', project_id: pA });
    expect(created.status).toBe(201);
    const opened = await request(app).get(`/api/tasks/${created.body.id}`).set(as(aToken));
    expect(opened.status).toBe(200);
  });

  test('不帶 project_id 的任務照常可以建（非專案任務是合法的）', async () => {
    const res = await request(app).post('/api/tasks').set(as(aToken)).send({ title: '沒有專案', original_text: 'x' });
    expect(res.status).toBe(201);
  });
});

// 全跑修法波第 2 項：公司管理員看得到自家公司的任務（規格 §8 P1 第二句）。
// 歸屬看「任務是誰建的」，不是看專案——同一個共用專案下，另一家公司同事的任務仍要維持不可見，
// 否則「公司管理員能按上正式，卻打不開任何一張要上正式的任務」這個自相矛盾的洞還在。
describe('公司管理員看自家公司的任務（規格 §8 P1 第二句）', () => {
  let caToken, colleagueTaskId, otherCoTaskId, sharedProjectId;

  beforeAll(async () => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('caScope',$1,'甲管理員','company_admin',$2)",
      [hash, coA]
    );
    caToken = (await request(app).post('/api/auth/login')
      .send({ username: 'caScope', password: 'password123' })).body.token;

    const { rows: [colleague] } = await dbModule.query(
      "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('colleagueScope',$1,'甲同事','user',$2) RETURNING id",
      [hash, coA]
    );

    // 共用專案：同時綁甲、乙兩家公司——用來證明「歸屬看建立者」而非「歸屬看專案」。
    const { rows: [sp] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version) VALUES ('共享專案','17') RETURNING id"
    );
    sharedProjectId = sp.id;
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2), ($1,$3)', [sharedProjectId, coA, coB]);

    const { rows: [userBRow] } = await dbModule.query("SELECT id FROM users WHERE username = 'userB'");

    const { rows: [t1] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'scope-colleague','manual','同事的任務','new',$2) RETURNING id",
      [colleague.id, sharedProjectId]
    );
    colleagueTaskId = t1.id;

    const { rows: [t2] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'scope-other-co','manual','乙公司的任務','new',$2) RETURNING id",
      [userBRow.id, sharedProjectId]
    );
    otherCoTaskId = t2.id;
  });

  test('公司管理員打開同公司同事的任務 → 200', async () => {
    const res = await request(app).get(`/api/tasks/${colleagueTaskId}`).set(as(caToken));
    expect(res.status).toBe(200);
  });

  test('公司管理員打開共用專案下、另一家公司同事的任務 → 404（不是 403，403 等於承認它存在）', async () => {
    const res = await request(app).get(`/api/tasks/${otherCoTaskId}`).set(as(caToken));
    expect(res.status).toBe(404);
  });

  test('一般使用者打開同公司同事的任務仍是 404（第一句規則不變，回歸守衛）', async () => {
    const res = await request(app).get(`/api/tasks/${colleagueTaskId}`).set(as(aToken));
    expect(res.status).toBe(404);
  });

  test('GET /api/tasks?all=true 公司管理員 → 列出本公司任務（含同事的），不含別家公司', async () => {
    const res = await request(app).get('/api/tasks?all=true').set(as(caToken));
    expect(res.status).toBe(200);
    const ids = res.body.map(t => t.id);
    expect(ids).toContain(colleagueTaskId);
    expect(ids).not.toContain(otherCoTaskId);
  });

  test('GET /api/tasks?all=true 一般使用者 → 參數被忽略，看不到公司同事的任務', async () => {
    const res = await request(app).get('/api/tasks?all=true').set(as(aToken));
    expect(res.status).toBe(200);
    expect(res.body.map(t => t.id)).not.toContain(colleagueTaskId);
  });
});
