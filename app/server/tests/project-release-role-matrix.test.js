/**
 * project-release-role-matrix.test.js — 上正式的「角色 × 關卡」完整矩陣
 * （階段 4 規格 `2026-09-11-customer-self-serve-flow-design.md` §152、§162）
 *
 * 規格把這張矩陣列成待完成項，而既有測試只覆蓋到其中兩格（`tenant-routes-scope.test.js`
 * 的「一般使用者 403」與「公司管理員＋勾了 → 放行」）。這支把六格一次釘齊，特別是
 * 以下四格**在此之前沒有任何 HTTP 層測試**：
 *
 *   - 公司管理員但公司**沒綁**這個專案 → 必須是 **404**，不是 403。
 *     這格不是形式主義：403 與 404 的差別就是「這個 id 存不存在」的洩漏管道，
 *     別家公司的管理員可以拿它當 oracle 一個個掃出專案 id。
 *   - 公司管理員、有綁但**沒勾** `can_release` → 403。
 *   - **內部公司**的公司管理員對客戶專案 → 403（規格 §162：內部公司的綁定不勾
 *     `can_release`，所以廠商自己的人也按不了客戶的上正式）。
 *   - **平台管理員** → 過得了權限關（POST 的正向路徑此前只在函式層測過）。
 *
 * 「過得了權限關」怎麼證明：不要求整條 release 真的跑完（那要真的 clone、PAT、repo
 * 齊全）。只要求它走到**下一道**關卡——缺 GIT 憑證的 400。而且平台管理員與公司管理員
 * 的 400 訊息不同（個人 PAT vs 公司 GIT），順便釘住「提示有沒有指向對的人」。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-release-matrix-jwt';
process.env.APP_SECRET = 'test-release-matrix-secret';

let app, dbModule;
let tokens = {};
let pCustomer, pNoFlag;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  tokens.platformAdmin = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  const mkCo = async (name, isInternal) => (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, $2) RETURNING id',
    [name, isInternal]
  )).id;
  const coCustomer = await mkCo('客戶甲', false);
  const coOther = await mkCo('客戶乙', false);
  const coInternal = await mkCo('內部', true);

  const mkUser = async (username, role, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, role, companyId]
    );
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  tokens.normalUser = await mkUser('cust-user', 'user', coCustomer);
  tokens.customerAdmin = await mkUser('cust-admin', 'company_admin', coCustomer);
  tokens.otherCompanyAdmin = await mkUser('other-admin', 'company_admin', coOther);
  tokens.internalAdmin = await mkUser('internal-admin', 'company_admin', coInternal);

  const mkProject = async (name) => (await one(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", [name])).id;
  const bind = (projectId, companyId, canRelease) => dbModule.query(
    'INSERT INTO project_companies (project_id, company_id, can_release) VALUES ($1,$2,$3)',
    [projectId, companyId, canRelease]);

  pCustomer = await mkProject('客戶甲的專案');
  await bind(pCustomer, coCustomer, true);
  // 內部公司也綁了同一個客戶專案（遷移就是把全部專案綁給內部的），但**不勾**
  // can_release。這正是規格 §162 描述的狀態，也是「內部公司管理員按不了」那一格
  // 唯一有意義的形狀——沒綁的話會被可見性先擋成 404，測不到權限本身。
  await bind(pCustomer, coInternal, false);

  pNoFlag = await mkProject('客戶甲的另一個專案（沒勾可上正式）');
  await bind(pNoFlag, coCustomer, false);
});

afterAll(() => dbModule._setPoolForTesting(null));

// 用物件列而不是陣列列：陣列列的 %s／%d 是按位置代入的，中間夾一個取專案 id 的函式
// 就會錯位、測試名印成 NaN——而這支的價值一半在「名字讀起來就是那張矩陣」。
const MATRIX = [
  { label: '一般使用者（公司綁定有勾，但勾的是公司管理員的權限）', who: 'normalUser', project: 'pCustomer', expected: 403 },
  { label: '公司管理員，但公司沒綁這個專案（看不到 ⇒ 當它不存在）', who: 'otherCompanyAdmin', project: 'pCustomer', expected: 404 },
  { label: '公司管理員，有綁但沒勾 can_release', who: 'customerAdmin', project: 'pNoFlag', expected: 403 },
  { label: '內部公司的公司管理員，對客戶專案（綁定不勾）', who: 'internalAdmin', project: 'pCustomer', expected: 403 },
  { label: '公司管理員，有綁且勾了 → 過權限關，擋在下一道（缺公司 GIT）', who: 'customerAdmin', project: 'pCustomer', expected: 400 },
  { label: '平台管理員 → 過權限關，擋在下一道（缺個人 PAT）', who: 'platformAdmin', project: 'pCustomer', expected: 400 },
];

// 專案 id 要到 beforeAll 才有值，所以矩陣裡存名字、跑的時候才解析
const projectId = (name) => ({ pCustomer, pNoFlag })[name];

describe('POST /api/projects/:id/release 的角色矩陣', () => {
  test.each(MATRIX)('$label → $expected', async ({ who, project, expected }) => {
    const res = await request(app).post(`/api/projects/${projectId(project)}/release`)
      .set(as(tokens[who])).send({});
    expect(res.status).toBe(expected);
  });

  // 兩種 400 長得一樣但意思不同：一個要人去公司設定、一個要人去自己的設定頁。
  // 訊息指向錯的人，使用者會一直找不到那個欄位在哪。
  test('兩種「缺憑證」的 400 訊息指向不同的人', async () => {
    const byCompanyAdmin = await request(app).post(`/api/projects/${pCustomer}/release`)
      .set(as(tokens.customerAdmin)).send({});
    const byPlatformAdmin = await request(app).post(`/api/projects/${pCustomer}/release`)
      .set(as(tokens.platformAdmin)).send({});
    expect(byCompanyAdmin.body.error).toBe('公司尚未設定 GIT，請聯絡平台');
    expect(byPlatformAdmin.body.error).toBe('請先到設定填個人 GitHub PAT');
  });

  // 403 的訊息不得寫出專案名稱或其他內容——被擋下的人不該從錯誤訊息裡多知道任何事。
  test('403 的訊息只說權限，不洩漏專案內容', async () => {
    const res = await request(app).post(`/api/projects/${pNoFlag}/release`)
      .set(as(tokens.customerAdmin)).send({});
    expect(res.body.error).toBe('只有平台管理員或公司管理員能上正式');
    expect(JSON.stringify(res.body)).not.toContain('沒勾可上正式');
  });
});

// 讀的那一半（規格 §8 P5）：看得到專案的人都能唯讀待上正式清單，
// 但 prodDeploy.canRelease 必須誠實反映「這個人按下去會不會有用」。
// 前端的警告文案是照這個旗標寫的，算錯的話警告會出現在不該出現的人面前（或反之）。
describe('GET /api/projects/:id/pending-release 的 canRelease 旗標', () => {
  const READ_MATRIX = [
    { label: '一般使用者', who: 'normalUser', project: 'pCustomer', canRelease: false },
    { label: '公司管理員（有綁且勾了）', who: 'customerAdmin', project: 'pCustomer', canRelease: true },
    { label: '公司管理員（有綁沒勾）', who: 'customerAdmin', project: 'pNoFlag', canRelease: false },
    { label: '內部公司的公司管理員（綁定不勾）', who: 'internalAdmin', project: 'pCustomer', canRelease: false },
    { label: '平台管理員', who: 'platformAdmin', project: 'pCustomer', canRelease: true },
  ];

  test.each(READ_MATRIX)('$label → 看得到清單，canRelease=$canRelease', async ({ who, project, canRelease }) => {
    const res = await request(app).get(`/api/projects/${projectId(project)}/pending-release`).set(as(tokens[who]));
    expect(res.status).toBe(200);
    expect(res.body.prodDeploy.canRelease).toBe(canRelease);
  });

  test('沒綁這個專案的公司管理員 → 404（連清單都不該看到）', async () => {
    const res = await request(app).get(`/api/projects/${pCustomer}/pending-release`)
      .set(as(tokens.otherCompanyAdmin));
    expect(res.status).toBe(404);
  });
});
