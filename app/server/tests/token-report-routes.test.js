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

process.env.JWT_SECRET = 'test-token-report';

let app, dbModule, adminToken, userToken, adminUserId, regularUserId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  // Create admin via setup endpoint
  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin_tr', password: 'admin1234', display_name: 'Admin TR'
  });
  adminToken = adminRes.body.token;
  const { rows: [admin] } = await dbModule.query("SELECT id FROM users WHERE username='admin_tr'");
  adminUserId = admin.id;

  // Create regular user
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  const { rows: [regular] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular_tr', $1, 'Regular TR', 'user') RETURNING id",
    [hash]
  );
  regularUserId = regular.id;
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'regular_tr', password: 'pass1234'
  });
  userToken = userRes.body.token;

  // Insert token_usage records
  // Record for admin
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ('task_odoo_1', $1, 'coding', 100, 50, 10, 5, 'server')`,
    [adminUserId]
  );
  // Record for regular user
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ('task_odoo_2', $1, 'qa', 200, 80, 20, 0, 'server')`,
    [regularUserId]
  );
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/token-report → 401 without token', async () => {
  const res = await request(app).get('/api/token-report');
  expect(res.status).toBe(401);
});

// 意圖：側欄 Claude 用量小工具的資料源也僅管理員可見（一般使用者 403）。
test('GET /api/claude-usage → 一般使用者 403、admin 非 403', async () => {
  const u = await request(app).get('/api/claude-usage').set('Authorization', `Bearer ${userToken}`);
  expect(u.status).toBe(403);
  const a = await request(app).get('/api/claude-usage').set('Authorization', `Bearer ${adminToken}`);
  expect(a.status).not.toBe(403); // admin 放行（實際 200／503 視環境，但不得是權限 403）
});

// 意圖：用量報表僅管理員可見——一般使用者一律 403（不再回傳自己的用量）。
test('GET /api/token-report → 一般使用者 403（含帶 ?all=true）', async () => {
  const res = await request(app)
    .get('/api/token-report')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
  const res2 = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res2.status).toBe(403);
});

test('GET /api/token-report → 200 for admin (own data only without ?all=true)', async () => {
  const res = await request(app)
    .get('/api/token-report')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  // Admin without ?all=true sees only own data: task_odoo_1 has 100+50+10+5=165 tokens
  expect(res.body.summary.total_tokens).toBe(165);
  // Cache 總數 = cache_read + cache_create = 10 + 5 = 15
  expect(res.body.summary.cache_tokens).toBe(15);
  // 實際花費：無 model → 以 sonnet($3/1M) 計；加權=100+50*5+10*0.1+5*1.25=357.25
  // cost = 3 * 357.25 / 1e6 = 0.00107175 USD
  expect(res.body.summary.cost_usd).toBeCloseTo(0.00107175, 8);
  // 實際 Token 數＝與成本同一套加權等效顆數
  expect(res.body.summary.actual_tokens).toBeCloseTo(357.25, 8);
});

test('GET /api/token-report?all=true → 200 for admin (all users data)', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  // Both records: 165 + 300 = 465 tokens
  expect(res.body.summary.total_tokens).toBe(465);
  expect(res.body.tasks.length).toBe(2);
});

test('GET /api/token-report → summary shape is correct', async () => {
  const res = await request(app)
    .get('/api/token-report')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const { summary, by_agent, by_project, daily, tasks } = res.body;
  expect(typeof summary.total_tokens).toBe('number');
  expect(typeof summary.cache_tokens).toBe('number');
  expect(typeof summary.cost_usd).toBe('number');
  expect(typeof summary.total_tasks).toBe('number');
  expect(typeof summary.actual_tokens).toBe('number');
  expect(typeof summary.avg_tokens_per_task).toBe('number');
  expect(typeof summary.avg_cost_per_task).toBe('number');
  expect(Array.isArray(by_agent)).toBe(true);
  expect(Array.isArray(by_project)).toBe(true);
  expect(Array.isArray(daily)).toBe(true);
  expect(Array.isArray(tasks)).toBe(true);
});

test('GET /api/token-report?task_id=task_odoo_1 → filters by task_id', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true&task_id=task_odoo_1')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.summary.total_tokens).toBe(165);
  expect(res.body.tasks.length).toBe(1);
  expect(res.body.tasks[0].task_id).toBe('task_odoo_1');
});

test('GET /api/token-report → by_agent has correct shape', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.by_agent.length).toBeGreaterThan(0);
  for (const entry of res.body.by_agent) {
    expect(typeof entry.agent_type).toBe('string');
    expect(typeof entry.tokens).toBe('number');
  }
});

// 意圖：使用者分布圓餅圖需要 by_user 彙總；admin 全站檢視要看得出每位使用者的實際 Token 占比。
test('GET /api/token-report?all=true → by_user 依使用者彙總（含 admin 與一般使用者）', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.by_user)).toBe(true);
  for (const entry of res.body.by_user) {
    expect(typeof entry.user_id).toBe('number');
    expect(typeof entry.username).toBe('string');
    expect(typeof entry.tokens).toBe('number');
  }
  const names = res.body.by_user.map(r => r.username);
  expect(names).toContain('Admin TR');
  expect(names).toContain('Regular TR');
});

test('依 model 單價計 USD：opus 記錄用 $5/1M、model 一併回傳', async () => {
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ('task_opus_1', $1, 'coding', 'claude-opus-4-8', 1000, 0, 0, 0, 'server')`,
    [adminUserId]
  );
  const res = await request(app)
    .get('/api/token-report?all=true&task_id=task_opus_1')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  // 加權=1000；opus $5/1M → cost = 5*1000/1e6 = 0.005 USD（若當 sonnet 會是 0.003，區別得出）
  expect(res.body.summary.cost_usd).toBeCloseTo(0.005, 8);
  expect(res.body.tasks[0].total_cost).toBeCloseTo(0.005, 8);
  expect(res.body.tasks[0].agents[0].model).toBe('claude-opus-4-8');
});

test('chat token_usage groups per chat_id with chat title; orphan task/chat marked deleted', async () => {
  // 建一個專案與對話，chat token 記錄帶 chat_id → 應以對話標題呈現、可連結
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TR 專案', '17.0') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '報價單問題') RETURNING id",
    [proj.id]
  );
  await dbModule.query(
    `INSERT INTO token_usage (project_id, chat_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ($1, $2, $3, 'chat', 10, 10, 0, 0, 'server')`,
    [proj.id, chat.id, adminUserId]
  );
  // 孤兒任務：task_id 有值但 tasks 無此列（模擬任務被刪除後殘留的 token 記錄）
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ('manual_deleted_1', $1, 'coding', 5, 5, 0, 0, 'server')`,
    [adminUserId]
  );
  // 孤兒對話：chat_id 指向不存在的 project_chats（模擬對話被刪除）
  await dbModule.query(
    `INSERT INTO token_usage (project_id, chat_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
     VALUES ($1, 999999, $2, 'chat', 7, 7, 0, 0, 'server')`,
    [proj.id, adminUserId]
  );

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);

  const chatRow = res.body.tasks.find(t => t.kind === 'chat' && t.chat_id === chat.id);
  expect(chatRow).toBeTruthy();
  expect(chatRow.title).toBe('報價單問題');
  expect(chatRow.deleted).toBe(false);
  expect(chatRow.linkable).toBe(true);

  // 對話被刪除 → 標示 deleted、不可連結
  const deletedChat = res.body.tasks.find(t => t.kind === 'chat' && t.chat_id === 999999);
  expect(deletedChat).toBeTruthy();
  expect(deletedChat.deleted).toBe(true);
  expect(deletedChat.linkable).toBe(false);

  const orphan = res.body.tasks.find(t => t.task_id === 'manual_deleted_1');
  expect(orphan).toBeTruthy();
  expect(orphan.kind).toBe('task');
  expect(orphan.deleted).toBe(true);
  expect(orphan.linkable).toBe(false);
});

test('GET /api/token-report → tasks have agents array', async () => {
  // 用量報表僅 admin；以 admin + all + 指定 task_odoo_2（原一般使用者的 qa 記錄）驗明細
  const res = await request(app)
    .get('/api/token-report?all=true&task_id=task_odoo_2')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.tasks.length).toBe(1);
  const task = res.body.tasks[0];
  expect(Array.isArray(task.agents)).toBe(true);
  expect(task.agents[0].agent_type).toBe('qa');
  // 明細列改用實際 Token（加權）：200+80*5+20*0.1+0*1.25=602
  expect(task.agents[0].tokens).toBe(602);
  expect(task.total_tokens).toBe(602);
  // 無 model→sonnet$3；cost=3*602/1e6=0.001806 USD
  expect(task.agents[0].cost).toBeCloseTo(0.001806, 8);
});

test('end=今天（date-only）→ 含當天記錄（邊界補到當日結束）', async () => {
  // 插入一筆 recorded_at=現在的記錄，模擬「今天」剛產生的用量
  const { rows: [row] } = await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source, recorded_at)
     VALUES ('task_today_1', $1, 'coding', 1000, 0, 0, 0, 'server', NOW()) RETURNING id`,
    [regularUserId]
  );
  expect(row.id).toBeTruthy();

  const today = new Date().toISOString().slice(0, 10);
  const res = await request(app)
    .get(`/api/token-report?all=true&start=${today}&end=${today}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  // 若 end 被當成當日 00:00，今天白天產生的這筆會被 recorded_at <= end 濾掉
  const hit = res.body.tasks.find(t => t.task_id === 'task_today_1');
  expect(hit).toBeTruthy();
  // 加權=1000；無 model→sonnet$3；cost=3*1000/1e6=0.003 USD
  expect(hit.total_cost).toBeCloseTo(0.003, 8);
});

// 意圖：失敗率高的關卡＝重跑成本集中處，是省 token 的第一優先目標；
// by_agent 必須帶 per-stage 的成本與失敗率，讓「哪一關最燒」可視化。
test('by_agent 帶成本與失敗率：失敗記錄（status≠completed）計入 fail_rate', async () => {
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, status, source)
     VALUES ('task_odoo_2', $1, 'qa', 0, 0, 0, 0, 'timeout', 'server')`,
    [regularUserId]
  );
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const qa = res.body.by_agent.find(r => r.agent_type === 'qa');
  expect(qa).toBeTruthy();
  expect(qa.calls).toBe(2);          // 1 成功 + 1 timeout
  expect(qa.failed_calls).toBe(1);
  expect(qa.fail_rate).toBeCloseTo(0.5);
  expect(typeof qa.cost_usd).toBe('number');
});

// 意圖：分析關改採「寧可多問一輪」後，需要一個成本計來看該政策有沒有問過頭——
// 使用者統計以「本期間完成的任務」為母體，介入＝人類真的動手輸入的次數
// （task_logs role='user'：澄清回答／規格裁決／修正指示／退回理由；task_messages source='manual'：途中留言）。
// 平均值是關鍵欄位：任務多的人分母大，只看總數會誤判成他最耗人力。
test('user_stats：以完成任務為母體，介入次數＝user log ＋ manual 留言，平均值以任務數為分母', async () => {
  const { rows: [t1] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, done_at)
     VALUES ($1,'task_iv_1','odoo','完成A','done', NOW()) RETURNING id`,
    [regularUserId]
  );
  const { rows: [t2] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, done_at)
     VALUES ($1,'task_iv_2','odoo','完成B','done', NOW()) RETURNING id`,
    [regularUserId]
  );
  // t1：2 次澄清回答 + 1 則途中留言 = 3 次介入
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','答一')", [t1.id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','[修正指示] 答二')", [t1.id]);
  await dbModule.query("INSERT INTO task_messages (task_id, source, content, occurred_at) VALUES ($1,'manual','途中留言', NOW())", [t1.id]);
  // agent 自己寫的 ai/system 記錄不算介入
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','客服回覆')", [t1.id]);
  // 從 Odoo 同步進來的訊息不是人在平台上介入，不算
  await dbModule.query("INSERT INTO task_messages (task_id, source, content, occurred_at) VALUES ($1,'odoo','同步訊息', NOW())", [t2.id]);
  // t2：1 次介入

  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','答三')", [t2.id]);

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const row = res.body.user_stats.find(r => r.user_id === regularUserId);
  expect(row).toBeTruthy();
  expect(row.done_tasks).toBe(2);
  expect(row.interventions).toBe(4);              // 3 + 1，ai/system 與 odoo 來源都不計
  expect(row.avg_interventions).toBeCloseTo(2);   // 4 / 2
});

// 意圖：未完成的任務不該進母體——否則跑到一半的任務會把平均值稀釋成假的好看。
test('user_stats：未完成（status≠done）的任務與其介入都不計入', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status)
     VALUES ($1,'task_iv_open','odoo','進行中','coding_running') RETURNING id`,
    [regularUserId]
  );
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','進行中的回答')", [t.id]);

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  const row = res.body.user_stats.find(r => r.user_id === regularUserId);
  expect(row.done_tasks).toBe(2);        // 仍是前一測的兩張
  expect(row.interventions).toBe(4);     // 進行中任務的回答沒被算進去
});
