// 意圖：健檢兩表隨 migrate 建立（工作流程健檢子專案 2）。
const { newDb } = require('pg-mem');
let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterAll(() => dbModule._setPoolForTesting(null));

test('migrate 建立 health_check_runs / health_check_findings 兩表', async () => {
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days) VALUES ('running', 30)"
  );
  const { rows } = await dbModule.query('SELECT status, window_days FROM health_check_runs');
  expect(rows[0].status).toBe('running');
  const { rows: [run] } = await dbModule.query('SELECT id FROM health_check_runs LIMIT 1');
  await dbModule.query(
    "INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity) VALUES ($1,'coding-project','ok','ok')",
    [run.id]
  );
  const { rows: f } = await dbModule.query('SELECT severity FROM health_check_findings');
  expect(f[0].severity).toBe('ok');
});

const { buildAgentSummary } = require('../pipeline/health-data');

test('buildAgentSummary 聚合 token / tasks / rejections（僅視窗內）', async () => {
  // 準備：coding 階段兩筆 token_usage（1 成功 1 失敗）＋窗外 1 筆不計
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hd','h','HD') RETURNING id");
  await dbModule.query(
    "INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, duration_ms, status, recorded_at) VALUES ('T1',$1,'coding',100,50,20,1000,'completed',NOW())",
    [u.id]);
  await dbModule.query(
    "INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, duration_ms, status, recorded_at) VALUES ('T1',$1,'coding',0,0,500,'error',NOW())",
    [u.id]);
  await dbModule.query(
    "INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, status, recorded_at) VALUES ('T9',$1,'coding',999,999,'completed',NOW() - INTERVAL '60 days')",
    [u.id]);
  // 對應任務（含 blocker 與 reentry）＋一筆退回分類
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status, reentry_count, blocker_content) VALUES ($1,'T1','manual','stopped',2,'缺套件')",
    [u.id]);
  const { rows: [r] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, user_id, reason, status) VALUES ('T1',$1,'x','classified') RETURNING id",[u.id]);
  await dbModule.query(
    "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,'欄位型別錯','實作錯誤')",[r.id]);

  const s = await buildAgentSummary({ name: 'coding-project', stage: 'coding', label: '開發' }, { windowDays: 30 });
  expect(s.token.calls).toBe(2);              // 窗外那筆不計
  expect(s.token.failed_calls).toBe(1);
  expect(s.token.input_tokens).toBe(100);
  expect(s.tasks.total).toBe(1);
  expect(s.tasks.stopped_rate).toBe(1);
  expect(s.tasks.reentry.max).toBe(2);
  expect(s.tasks.blocker_samples).toContain('缺套件');
  expect(s.rejections.by_category['實作錯誤']).toBe(1);
});

test('非 coding/analysis 的 agent → rejections 為 null', async () => {
  const s = await buildAgentSummary({ name: 'qa', stage: 'qa', label: 'QA' }, { windowDays: 30 });
  expect(s.rejections).toBeNull();
  expect(s.token.calls).toBe(0);
  expect(s.token.failed_calls).toBe(0);
});

test('buildAgentSummary：coding 只看 QA impl_miss + env_flaky_count；human by_category 不含 qa', async () => {
  // 造一筆 QA 退回（source=qa）：impl_miss x2, spec_unclear x1, env_flaky x1
  const { rows: [qr] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, reason, status, source) VALUES ('tq','s','classified','qa') RETURNING id");
  for (const c of ['impl_miss', 'impl_miss', 'spec_unclear', 'env_flaky']) {
    await dbModule.query(
      'INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,$2,$3)', [qr.id, 'd', c]);
  }
  // 一筆人工退回：category '實作錯誤'
  const { rows: [hr] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, reason, status, source) VALUES ('th','s','classified','human') RETURNING id");
  await dbModule.query(
    "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,'d','實作錯誤')", [hr.id]);

  const { buildAgentSummary } = require('../pipeline/health-data');
  const coding = await buildAgentSummary({ name: 'coding-project', stage: 'coding' });
  expect(coding.qa_rejections).toEqual({ relevant_category: 'impl_miss', count: 2, env_flaky_count: 1 });
  expect(coding.rejections.by_category).toEqual({ '實作錯誤': 2 }); // 不含 qa 的分類（累加前一個既有案例的 1 筆 human）

  const analysis = await buildAgentSummary({ name: 'analysis-project', stage: 'analysis' });
  expect(analysis.qa_rejections).toEqual({ relevant_category: 'spec_unclear', count: 1, env_flaky_count: 1 });
});
