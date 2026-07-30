jest.mock('../pipeline/usage-gate', () => ({
  getGateState: jest.fn().mockResolvedValue({ enabled: true, blocked: false }),
  _resetForTesting: jest.fn()
}));
const { newDb } = require('pg-mem');
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
// clarify_answered → coding_running 屬實際狀態推進，會被 auto-continue 串連派工到 coding_running
// （見 runner.js continuePipelineIfAdvanced）；比照 runner.test.js 同一原因 mock task-agent，
// 避免打到真的 runTaskCoding（此測試任務未設 project_repos，真跑會被判「未設定 Repo」轉 stopped，
// 蓋掉本測試要驗證的 handleClarifyAnswered 寫入結果）。
jest.mock('../pipeline/task-agent', () => ({
  runTaskCoding: jest.fn().mockResolvedValue(true)
}));
let dbModule, runPipeline, userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  ({ rows: [{ id: userId }] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('rc',$1,'R') RETURNING id", [hash]));
  ({ rows: [{ id: projectId }] } = await dbModule.query(
    "INSERT INTO projects (name,odoo_version) VALUES ('RP','17.0') RETURNING id"));
  ({ runPipeline } = require('../pipeline/runner'));
});
afterAll(() => dbModule._setPoolForTesting(null));

test('clarify_answered → 回 resume_status(coding_running)，帶裁決＋原 code 問題進 retry_feedback', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id,task_id,source,title,status,project_id,resume_status,retry_feedback,git_branch)
     VALUES ($1,'rc_1','odoo','T','clarify_answered',$2,'coding_running','[QA 未通過]\n欄位漏加','task/x') RETURNING id`,
    [userId, projectId]);
  await dbModule.query("INSERT INTO task_logs (task_id,role,content) VALUES ($1,'user','用小計、含稅')", [t.id]);
  await runPipeline(userId);
  await require('../pipeline/runner').whenIdle();
  const { rows: [after] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('coding_running');
  expect(after.retry_feedback).toContain('已裁決規格');
  expect(after.retry_feedback).toContain('用小計、含稅');
  expect(after.retry_feedback).toContain('欄位漏加'); // 原 code 問題一併帶回，一次補完
});

// 意圖：裁決只進 retry_feedback 等於只給「這一輪的 coding」看。下一輪 QA 讀的是 analysis_yaml，
// 看不到裁決就會拿原本那份有歧義的規格再問同一題——規格歧義的無限來回就是這樣長出來的。
// 裁決必須落回規格本體，才會對之後每一輪都生效。
test('clarify_answered → 裁決寫回 analysis_yaml（下一輪 QA 讀得到，不會原題再問）', async () => {
  const yaml = require('js-yaml');
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id,task_id,source,title,status,project_id,resume_status,analysis_yaml,git_branch)
     VALUES ($1,'rc_2','odoo','T','clarify_answered',$2,'coding_running','summary: 原規格\n','task/x') RETURNING id`,
    [userId, projectId]);
  await dbModule.query("INSERT INTO task_logs (task_id,role,content) VALUES ($1,'user','用小計、含稅')", [t.id]);
  await runPipeline(userId);
  await require('../pipeline/runner').whenIdle();
  const { rows: [after] } = await dbModule.query('SELECT analysis_yaml FROM tasks WHERE id=$1', [t.id]);
  const spec = yaml.load(after.analysis_yaml, { schema: yaml.CORE_SCHEMA });
  expect(spec.summary).toBe('原規格');                       // 既有規格不得被覆寫
  expect(spec.spec_decisions).toHaveLength(1);
  expect(spec.spec_decisions[0]).toContain('用小計、含稅');
});

// 規格是既有資產：解析不了時寧可不寫，也不能把它覆寫成殘缺內容（Rule：AI／流程都不得覆蓋既有 spec）。
test('analysis_yaml 解析不出物件 → 不寫回、不覆寫，任務照常推進', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id,task_id,source,title,status,project_id,resume_status,analysis_yaml,git_branch)
     VALUES ($1,'rc_3','odoo','T','clarify_answered',$2,'coding_running','- 不是物件的 YAML','task/x') RETURNING id`,
    [userId, projectId]);
  await dbModule.query("INSERT INTO task_logs (task_id,role,content) VALUES ($1,'user','照舊')", [t.id]);
  await runPipeline(userId);
  await require('../pipeline/runner').whenIdle();
  const { rows: [after] } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [t.id]);
  expect(after.analysis_yaml).toBe('- 不是物件的 YAML');
  expect(after.status).toBe('coding_running');
});
