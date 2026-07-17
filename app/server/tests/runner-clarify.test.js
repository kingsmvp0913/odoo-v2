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
