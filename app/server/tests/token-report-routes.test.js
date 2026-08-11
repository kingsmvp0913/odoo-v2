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

// 意圖：前端「今天」選項送的是帶時間的完整 ISO（本機當日 00:00 到此刻），不是 date-only。
// 差別在本機當日 00:00 到 UTC 當日 00:00 之間那段——台北就是凌晨 0~8 點——那段用量必須算進
// 今天，用 date-only 查則會落到前一天。這條守的是後端「帶 T 就照單全收、不補 23:59:59.999Z」。
// 註：機器若跑在 UTC，兩種切法等價，本測試仍綠但失去鑑別力（本平台容器 TZ=Asia/Taipei）。
test('start/end 帶完整 ISO（前端「今天」）→ 含本機當日凌晨的記錄', async () => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const justAfterMidnight = new Date(startOfDay.getTime() + 1);
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source, recorded_at)
     VALUES ('task_local_midnight', $1, 'coding', 500, 0, 0, 0, 'server', $2)`,
    [regularUserId, justAfterMidnight.toISOString()]
  );

  const res = await request(app)
    .get(`/api/token-report?all=true&start=${startOfDay.toISOString()}&end=${new Date().toISOString()}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.tasks.find(t => t.task_id === 'task_local_midnight')).toBeTruthy();
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

// 意圖：兩種「非執行失敗」都不得計入呼叫數／失敗率，否則會把該關失敗率灌爆（cs 曾因此顯示 60%）：
//   aborted     ＝使用者手動暫停（abortTask），刻意中斷
//   interrupted ＝claude 被外部信號終止（伺服器重開／OOM kill），非本次執行的錯
// 真正的執行失敗（error/timeout）仍要計入。用獨有的 agent_type 'cs'（全檔只有本測試寫入）隔離。
test('by_agent：手動暫停(aborted)與外部中斷(interrupted)不計入呼叫數與失敗數', async () => {
  const seedCs = (taskId, status) => dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, status, source)
     VALUES ($1, $2, 'cs', 0, 0, 0, 0, $3, 'server')`,
    [taskId, regularUserId, status]
  );
  await seedCs('task_cs_a', 'completed');
  await seedCs('task_cs_b', 'completed');
  await seedCs('task_cs_c', 'error');        // 真正失敗（exit N）→ 計入
  await seedCs('task_cs_c', 'aborted');      // 手動暫停 → 排除
  await seedCs('task_cs_d', 'aborted');
  await seedCs('task_cs_e', 'interrupted');  // 重開／外部中斷 → 排除
  await seedCs('task_cs_f', 'interrupted');

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const cs = res.body.by_agent.find(r => r.agent_type === 'cs');
  expect(cs).toBeTruthy();
  expect(cs.calls).toBe(3);              // 2 completed + 1 error；2 aborted + 2 interrupted 全排除
  expect(cs.failed_calls).toBe(1);       // 只有 error 算失敗
  expect(cs.fail_rate).toBeCloseTo(1 / 3);
});

// 註：這幾個測試刻意不帶 ?project_id—— summary query 的專案篩選用了 EXISTS 相關子查詢，
// pg-mem 無法解析當中的 tu.task_id（真 Postgres 正常）。project_stats 本來就依專案分組，
// 直接在回傳裡找該專案那列即可，不需要篩選。

// 意圖：一次過關率是「分析升 opus」這類改動的驗收指標，必須用不可重置的來源算。
// tasks 的 *_retry_count／reentry_count 會在分診 goto 與 resolve-blocker 續跑時被歸零
// （reject-triage.js:136、tasks-routes.js 的 RESUME_COUNTER），拿來算會低估彈跳；
// token_usage 每次呼叫一列且不可重置，才是可靠的重跑紀錄。
let qualityProjectId;
test('project_stats：一次過關率由 token_usage 列數推算，某關跑第二次即不算一次過關', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('品質統計專案', '17.0') RETURNING id"
  );
  qualityProjectId = p.id;
  const seed = async (taskId, title, stages) => {
    await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, created_at, done_at)
       VALUES ($1,$2,'odoo',$3,'done',$4, NOW(), NOW())`,
      [regularUserId, taskId, title, p.id]
    );
    for (const ag of stages) {
      await dbModule.query(
        `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, source)
         VALUES ($1, $2, $3, 10, 1, 0, 0, 'server')`,
        [taskId, regularUserId, ag]
      );
    }
  };
  // 關卡清單隨「E2E 變成純程式關」調整：playwright 不再花 token（該關已無 agent），
  // 真正在花錢的是出考題的 spec_tour。fixture 跟著換，否則測的是一個沒有執行者的關卡。
  await seed('task_fp_clean',  '一次過',   ['analysis', 'coding', 'qa', 'spec_tour']);
  await seed('task_fp_bounce', '有彈跳',   ['analysis', 'coding', 'coding', 'qa', 'spec_tour', 'spec_tour']);
  // 沒有 tour 的任務：該關 0 次呼叫，不該被當成失敗
  await seed('task_fp_notour', '無 tour', ['analysis', 'coding', 'qa']);

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const row = res.body.project_stats.find(r => r.project_id === p.id);
  expect(row).toBeTruthy();
  expect(row.done_tasks).toBe(3);
  expect(row.first_pass_rate).toBeCloseTo(2 / 3);            // 只有 bounce 那張不算
  expect(row.avg_stage_calls.coding).toBeCloseTo(4 / 3);     // (1+2+1)/3
  expect(row.avg_stage_calls.spec_tour).toBeCloseTo(1);      // (1+2+0)/3，沒跑的計 0
});

// 意圖：人工退回是「規格沒對齊」的最終訊號，退回原因分類 cron 早就在算，報表要看得到；
// 退回率的分母是完成任務數，才能跨專案比較。
test('project_stats：人工退回率與主要退回原因（rejection_items 分類）', async () => {
  const { rows: [rej] } = await dbModule.query(
    `INSERT INTO task_rejections (task_id, project_id, user_id, reason)
     VALUES ('task_fp_bounce', $1, $2, '欄位放錯位置') RETURNING id`,
    [qualityProjectId, regularUserId]
  );
  await dbModule.query(
    "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1, '欄位放錯位置', 'spec_mismatch')",
    [rej.id]
  );

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  const row = res.body.project_stats.find(r => r.project_id === qualityProjectId);
  expect(row.done_tasks).toBe(3);
  expect(row.reject_rate).toBeCloseTo(1 / 3);      // 三張裡一張被退過
  expect(row.top_reject_category).toBe('spec_mismatch');
  expect(row.top_reject_count).toBe(1);
});

// 意圖：這張報表講的是「人工退回」——使用者對交付結果不滿意的訊號。QA 自動退回是 pipeline 內部
// 的來回，落在同一張 task_rejections（source='qa'）且用的是另一套分類詞彙（impl_miss/spec_unclear/
// env_flaky）。混算會同時汙染兩件事：退回率被灌水（人工其實沒退），主要退回原因被 QA 的詞彙洗掉。
test('project_stats：QA 自動退回（source=qa）不計入人工退回率與主要退回原因', async () => {
  const { rows: [qrej] } = await dbModule.query(
    `INSERT INTO task_rejections (task_id, project_id, user_id, reason, status, source)
     VALUES ('task_fp_clean', $1, $2, 'QA 自動退回', 'classified', 'qa') RETURNING id`,
    [qualityProjectId, regularUserId]
  );
  for (const d of ['漏欄位', '型別錯']) {
    await dbModule.query(
      "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1, $2, 'impl_miss')",
      [qrej.id, d]
    );
  }

  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  const row = res.body.project_stats.find(r => r.project_id === qualityProjectId);
  expect(row.reject_rate).toBeCloseTo(1 / 3);        // 仍只有人工退過的那一張，不是 2/3
  expect(row.top_reject_category).toBe('spec_mismatch'); // 不得被 QA 的 impl_miss（2 筆）蓋掉
  expect(row.top_reject_count).toBe(1);
});

// 意圖：每張交付成本的分母必須是「完成任務數」。用 total_tasks（token_usage 的 ref 數，
// 含跑一半／被砍掉／未完成的任務）當分母會把單位成本除得比實際低，看起來比真實便宜。
test('summary.avg_cost_per_task 分母是完成任務數，不是 token_usage 的 ref 數', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const { summary } = res.body;
  expect(summary.done_tasks).toBeGreaterThan(0);
  expect(summary.done_tasks).not.toBe(summary.total_tasks);   // 兩者確實不同，才驗得出用了哪個
  expect(summary.avg_cost_per_task).toBeCloseTo(summary.cost_usd / summary.done_tasks, 10);
});

// 意圖：各關的重跑要看得到——fail_rate 只算 timeout/error，漏掉「跑完但被打回重來」，
// 而後者才是重跑成本的主要來源。avg_calls_per_task = 1.0 代表該關從不重跑。
// 用 spec_tour 斷言：全檔只有上面的 fixture 寫過這個 agent_type，不受其他測試的資料干擾。
test('by_agent.avg_calls_per_task：同任務同關卡跑兩次 → 平均呼叫數 > 1', async () => {
  const res = await request(app)
    .get('/api/token-report?all=true')
    .set('Authorization', `Bearer ${adminToken}`);
  const pw = res.body.by_agent.find(r => r.agent_type === 'spec_tour');
  expect(pw).toBeTruthy();
  expect(pw.calls).toBe(3);                          // clean 1 次 + bounce 2 次
  expect(pw.avg_calls_per_task).toBeCloseTo(1.5);    // 3 次呼叫 / 2 個任務
});
