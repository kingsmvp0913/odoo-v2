const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));

process.env.JWT_SECRET = 'test-admin';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  // First user via setup becomes admin
  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;

  // Insert a non-admin user
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, 'Regular', 'user')",
    [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'regular', password: 'pass1234'
  });
  userToken = userRes.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

let createdConfigId;
let createdMapId;

// --- users：建立帳號不得持有可還原密碼 ---
// 意圖：`password_enc` 是「主題 E」已退場的欄位——auth.js 的 setup／改密碼／登入三條路徑都不再寫，
// db.js 每次啟動還會把既有值清成 NULL（原本是給 E2E 借用使用者密碼登入，已改全域測試帳號）。
// 這支管理員建帳號的 INSERT 是唯一漏網的殘留：它寫進去的是「可用 APP_SECRET 解回明文的登入密碼」，
// 與同一份程式碼的決策直接牴觸，而且下次 server 重啟就被清掉＝寫了也沒人用，純粹是外洩面。
test('POST /api/admin/users → 不寫 password_enc（系統不持有可還原的登入密碼）', async () => {
  const res = await request(app).post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'e2euser', password: 'e2epass123', display_name: 'E2E', role: 'user' });
  expect(res.status).toBe(201);
  const { rows: [u] } = await dbModule.query("SELECT password_enc, password_hash FROM users WHERE username='e2euser'");
  expect(u.password_enc).toBeNull();
  // 帳號本身仍要能用（bcrypt hash 有寫），不是靠「整條 INSERT 壞掉」而通過
  expect(u.password_hash).toBeTruthy();
  const login = await request(app).post('/api/auth/login').send({ username: 'e2euser', password: 'e2epass123' });
  expect(login.status).toBe(200);
});

// 意圖：管理員核准 pending 帳號後即可登入（自助註冊審核閘門的收尾）。
test('PUT /api/admin/users/:id approved=true → pending 帳號可登入', async () => {
  await request(app).post('/api/auth/register').send({ username: 'wait1', password: 'password123', display_name: 'W1' });
  const before = await request(app).post('/api/auth/login').send({ username: 'wait1', password: 'password123' });
  expect(before.status).toBe(403);

  const { rows: [u] } = await dbModule.query("SELECT id FROM users WHERE username='wait1'");
  const upd = await request(app).put(`/api/admin/users/${u.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ approved: true });
  expect(upd.status).toBe(200);
  expect(upd.body.approved).toBe(true);

  const after = await request(app).post('/api/auth/login').send({ username: 'wait1', password: 'password123' });
  expect(after.status).toBe(200);
});

// 意圖：刪除帳號前必須先清該使用者所有參照（tasks 及其子表、sessions、loop_counter），
// 否則 tasks_user_id_fkey 等外鍵會擋下刪除。這是「沒辦法刪除會員」回報的核心。
test('DELETE /api/admin/users/:id → 連帶清任務與子表後成功刪除', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('todelete', $1, 'ToDelete', 'user') RETURNING id",
    [hash]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1, 'T-1', 'manual', 'new') RETURNING id",
    [u.id]
  );
  await dbModule.query("INSERT INTO task_events (task_id, content) VALUES ($1, 'e')", [t.id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', 'l')", [t.id]);
  await dbModule.query("INSERT INTO task_messages (task_id, content, occurred_at) VALUES ($1, 'm', NOW())", [t.id]);
  await dbModule.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'h', NOW())", [u.id]);
  await dbModule.query("INSERT INTO loop_counter (user_id) VALUES ($1)", [u.id]);

  const res = await request(app).delete(`/api/admin/users/${u.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const { rows: gone } = await dbModule.query('SELECT id FROM users WHERE id = $1', [u.id]);
  expect(gone.length).toBe(0);
  const { rows: tasksGone } = await dbModule.query('SELECT id FROM tasks WHERE user_id = $1', [u.id]);
  expect(tasksGone.length).toBe(0);
});

// --- version-configs ---

test('GET /api/admin/version-configs → 403 for non-admin', async () => {
  const res = await request(app).get('/api/admin/version-configs')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('GET /api/admin/version-configs → 401 without token', async () => {
  const res = await request(app).get('/api/admin/version-configs');
  expect(res.status).toBe(401);
});

test('GET /api/admin/version-configs → 200 empty list for admin', async () => {
  const res = await request(app).get('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('POST /api/admin/version-configs → 400 missing required fields', async () => {
  const res = await request(app).post('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_version: '16.0' });
  expect(res.status).toBe(400);
});

test('POST /api/admin/version-configs → creates config', async () => {
  const res = await request(app).post('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_version: '17.0', python_bin: '/usr/bin/python3', venv_base_path: '/opt/venvs', odoo_bin_path: '/opt/odoo/odoo-bin' });
  expect(res.status).toBe(201);
  expect(res.body.odoo_version).toBe('17.0');
  createdConfigId = res.body.id;
});

test('PUT /api/admin/version-configs/:id → updates notes', async () => {
  const res = await request(app).put(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ notes: 'Production version' });
  expect(res.status).toBe(200);
  expect(res.body.notes).toBe('Production version');
});

test('DELETE /api/admin/version-configs/:id → deletes config', async () => {
  const res = await request(app).delete(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('DELETE /api/admin/version-configs/:id → 404 after deletion', async () => {
  const res = await request(app).delete(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

// --- project-maps ---

test('POST /api/admin/project-maps → creates map', async () => {
  const res = await request(app).post('/api/admin/project-maps')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_name: 'MyOdoo', odoo_version: '17.0', project_dir: '/opt/myodoo' });
  expect(res.status).toBe(201);
  expect(res.body.project_name).toBe('MyOdoo');
  createdMapId = res.body.id;
});

test('GET /api/admin/project-maps → lists maps', async () => {
  const res = await request(app).get('/api/admin/project-maps')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
});

test('DELETE /api/admin/project-maps/:id → deletes map', async () => {
  const res = await request(app).delete(`/api/admin/project-maps/${createdMapId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

// --- token-breakdown：原始四欄拆解 ---
// 意圖：token-report 只吐加權合計，看不出 cache 是「命中」還是「重寫」——但兩者差 12.5 倍
// （read 0.1× / create 1.25×），是判斷「該不該把更多內容塞進 prompt」的唯一依據。
// 沒有這支端點就只能反推，而反推得對 output 佔比做假設，結論會隨假設漂移。
test('GET /api/admin/token-breakdown → 依 agent 吐原始四欄，可區分 cache 命中與重寫', async () => {
  await dbModule.query(
    `INSERT INTO token_usage (agent_type, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, recorded_at)
     VALUES ('chat','sonnet',100,50,9000,700,NOW()),
            ('chat','sonnet',80,40,5000,300,NOW()),
            ('coding','sonnet',200,60,3000,120,NOW())`
  );
  const res = await request(app).get('/api/admin/token-breakdown')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const chat = res.body.find(r => r.agent_type === 'chat');
  expect(Number(chat.calls)).toBe(2);
  expect(Number(chat.cache_read_tokens)).toBe(14000);   // 命中的部分
  expect(Number(chat.cache_create_tokens)).toBe(1000);  // 重寫的部分，成本是前者的 12.5 倍
  expect(Number(chat.input_tokens)).toBe(180);
  expect(Number(chat.output_tokens)).toBe(90);
  // 排序：cache_create 最多的排最前，因為那才是可下手的成本
  expect(res.body[0].agent_type).toBe('chat');
});

test('GET /api/admin/token-breakdown?agent_type=coding → 只回該 agent', async () => {
  const res = await request(app).get('/api/admin/token-breakdown?agent_type=coding')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].agent_type).toBe('coding');
});

// 用量資料是全平台成本，非 admin 不得看
test('GET /api/admin/token-breakdown → 非 admin 403', async () => {
  const res = await request(app).get('/api/admin/token-breakdown')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

// 語意檢索索引：重建端點是 fire-and-forget（重建要跑推論，掛著等 HTTP 沒有意義），
// 所以它的回應就是「當下狀態」而不是「重建結果」——回應形狀必須跟 status 端點一致，
// 前端才能拿同一份資料輪詢。索引是全平台資料，非 admin 不得碰。
test('GET /api/admin/embedding/status → 回模型與快取狀態', async () => {
  const res = await request(app).get('/api/admin/embedding/status')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.model).toBeTruthy();
  expect(typeof res.body.ready).toBe('boolean');
  expect(typeof res.body.cachedChunks).toBe('number');
});

test('POST /api/admin/embedding/rebuild → 立刻回狀態，不等重建完成', async () => {
  const res = await request(app).post('/api/admin/embedding/rebuild')
    .set('Authorization', `Bearer ${adminToken}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.model).toBeTruthy();
});

test('POST /api/admin/embedding/rebuild → 非 admin 403', async () => {
  const res = await request(app).post('/api/admin/embedding/rebuild')
    .set('Authorization', `Bearer ${userToken}`).send({});
  expect(res.status).toBe(403);
});

// --- CLI 推送身分（teams_settings.cli_push_user_id）---
// 意圖（Rule 9）：這個設定只服務「人在終端機跑 pushRepo/push.js 且沒帶 --user」。
// 原本 push.js 寫死預設 user=2，而本機與正式機的 users 表各自獨立——寫死的數字在另一邊
// 指到不存在的人，拿到的卻是 NoGitCredentialError（讀起來像「這個人沒設 PAT」），真因
// 指不出來。所以存的當下就要擋：id 不存在、或該人沒 PAT，都不准存進去。
describe('PUT /api/admin/cli-push-user', () => {
  test('id 不存在 → 400，不寫進設定', async () => {
    const res = await request(app).put('/api/admin/cli-push-user')
      .set('Authorization', `Bearer ${adminToken}`).send({ cli_push_user_id: 99999 });
    expect(res.status).toBe(400);
    const { rows } = await dbModule.query('SELECT cli_push_user_id FROM teams_settings WHERE id = 1');
    expect(rows[0] && rows[0].cli_push_user_id).toBeFalsy();
  });

  test('該使用者沒有 PAT → 400（否則失敗會延到 push 當下）', async () => {
    const { rows } = await dbModule.query("SELECT id FROM users WHERE username = 'regular'");
    const res = await request(app).put('/api/admin/cli-push-user')
      .set('Authorization', `Bearer ${adminToken}`).send({ cli_push_user_id: rows[0].id });
    expect(res.status).toBe(400);
  });

  test('有 PAT 的使用者 → 存得起來且從 teams-settings 讀得回', async () => {
    const { rows } = await dbModule.query("SELECT id FROM users WHERE username = 'regular'");
    const uid = rows[0].id;
    await dbModule.query("UPDATE users SET github_pat_enc = 'enc-blob' WHERE id = $1", [uid]);

    const put = await request(app).put('/api/admin/cli-push-user')
      .set('Authorization', `Bearer ${adminToken}`).send({ cli_push_user_id: uid });
    expect(put.status).toBe(200);

    // 讀得回才有意義——下拉是靠 GET teams-settings 回填當前選擇的
    const get = await request(app).get('/api/admin/teams-settings')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.body.cli_push_user_id).toBe(uid);
  });

  test('送 null → 清成未設定（push.js 會改為列出可用帳號）', async () => {
    const res = await request(app).put('/api/admin/cli-push-user')
      .set('Authorization', `Bearer ${adminToken}`).send({ cli_push_user_id: null });
    expect(res.status).toBe(200);
    const { rows } = await dbModule.query('SELECT cli_push_user_id FROM teams_settings WHERE id = 1');
    expect(rows[0].cli_push_user_id).toBeNull();
  });

  test('非 admin → 403', async () => {
    const res = await request(app).put('/api/admin/cli-push-user')
      .set('Authorization', `Bearer ${userToken}`).send({ cli_push_user_id: null });
    expect(res.status).toBe(403);
  });
});

// 意圖：下拉要標出「誰選了會失敗」，靠的是 users 列表的 has_pat。這欄只能是布林——
// 同一支端點若把 github_pat_enc 一起吐出去，PAT 密文就外洩到前端了。
test('GET /api/admin/users → 有 has_pat 布林，且不含 PAT 密文', async () => {
  const res = await request(app).get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
  for (const u of res.body) {
    expect(typeof u.has_pat).toBe('boolean');
    expect(u.github_pat_enc).toBeUndefined();
  }
});
