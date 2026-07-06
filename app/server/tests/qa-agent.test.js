// 意圖：QA 對照 SD 判定 diff。pass 往下 merge、fail 退 coding 並依關卡計數，
// 連續失敗達上限改為 stopped（人工介入），無有效結果視為失敗停止。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn() }));
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, spawnClaude: jest.fn(), getProjectInfo: jest.fn() };
});

let dbModule, runQaAgent, taskAgent;
let userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('qa', $1, 'Q') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('QP', '17.0') RETURNING id"
  );
  projectId = p.id;

  taskAgent = require('../pipeline/task-agent');
  ({ runQaAgent } = require('../pipeline/qa-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  taskAgent.spawnClaude.mockReset();
  taskAgent.getProjectInfo.mockReset();
  taskAgent.getProjectInfo.mockResolvedValue({
    name: 'QP', odoo_version: '17.0', root: '/repos/qp',
    repos: [{ subdir: 'main', local_path: '/repos/qp/main' }]
  });
});

let seq = 0;
async function makeTask(qaCount = 0) {
  seq++;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, analysis_yaml, qa_retry_count)
     VALUES ($1,$2,'odoo','T','qa_running',$3,'task/x','module: sale',$4) RETURNING id`,
    [userId, `qa_${seq}`, projectId, qaCount]
  );
  return t.id;
}

function claudeReturns(json) {
  taskAgent.spawnClaude.mockResolvedValue({
    text: `前置輸出\n---RESULT-JSON---\n${JSON.stringify(json)}\n---END-RESULT---`, usage: null, durationMs: null
  });
}

test('verdict pass → merge_running', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
});

test('verdict fail 未達上限 → coding_running、計數+1、issues 進 log', async () => {
  claudeReturns({ verdict: 'fail', issues: ['第1條未實作'], summary: '修這個' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('第1條未實作'))).toBe(true);
});

test('verdict fail 第 3 次 → stopped', async () => {
  claudeReturns({ verdict: 'fail', issues: ['又錯'] });
  const id = await makeTask(2); // 已 2 次，本次是第 3 次
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.qa_retry_count).toBe(3);
});

test('無 RESULT-JSON → stopped', async () => {
  taskAgent.spawnClaude.mockResolvedValue({ text: '亂七八糟沒有標記', usage: null, durationMs: null });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});
