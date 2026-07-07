// 意圖：專案分析前必須先 pull main 讀最新碼；pull 失敗（origin 不通／本地髒）
// 屬環境問題，停下等人工，不得拿舊碼繼續分析。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  pullBranch: jest.fn(),
  ensureMainBranch: jest.fn().mockResolvedValue('main')
}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

let dbModule, runTaskAnalysis, runTaskCoding, git;
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
    "INSERT INTO users (username, password_hash, display_name) VALUES ('ta', $1, 'T') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TAP', '17.0') RETURNING id"
  );
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/tap/main',true,'done')",
    [projectId]
  );

  git = require('../pipeline/git');
  ({ runTaskAnalysis, runTaskCoding } = require('../pipeline/task-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('分析前 pull main 失敗 → 任務 stopped，不繼續分析', async () => {
  git.pullBranch.mockRejectedValueOnce(new Error('could not resolve host github.com'));
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,'ta_pull','odoo','T','需求','analysis_running',$2) RETURNING id",
    [userId, projectId]
  );
  const handled = await runTaskAnalysis(t.id, userId);
  expect(handled).toBe(true);
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('main');
});

test('coding retry：retry_feedback（上一輪失敗訊息）確實帶進 claude prompt，且用完清空', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  let captured = '';
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write: (d) => { captured += d; },
      end: () => {
        setImmediate(() => {
          child.stdout.emit('data', JSON.stringify({ type: 'result', result: '---RESULT-JSON---\n{"status":"qa_running"}\n---END-RESULT---', usage: null, duration_ms: 10 }) + '\n');
          child.emit('close', 0);
        });
      }
    };
    return child;
  });

  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, analysis_yaml, git_branch, status, project_id, retry_feedback) VALUES ($1,'ta_code','odoo','T','module: idx_x','task/ta_code','coding_running',$2,$3) RETURNING id",
    [userId, projectId, '[部署測試區升級失敗]\nParseError: bad view line 5']
  );
  const handled = await runTaskCoding(t.id, userId);
  expect(handled).toBe(true);
  // 意圖：上一輪失敗訊息必須出現在餵給 claude 的 prompt，否則 AI 修不到
  expect(captured).toContain('ParseError: bad view line 5');
  // 用完即清 + 進入 QA
  const { rows: [after] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('qa_running');
  expect(after.retry_feedback).toBeNull();
});

// 健檢 agents 層 P2：feedback 在 spawn 前就清空，失敗/逾時後回饋永久遺失。
// 意圖：只有「成功執行」才算消費掉回饋；失敗要保留給下一次重試。
test('coding spawn 失敗 → retry_feedback 保留，下次重試不致盲改', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { write: () => {}, end: () => { setImmediate(() => child.emit('close', 1)); } };
    return child;
  });

  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, analysis_yaml, git_branch, status, project_id, retry_feedback) VALUES ($1,'ta_code_fail','odoo','T','module: idx_x','task/ta_code_fail','coding_running',$2,$3) RETURNING id",
    [userId, projectId, '[QA 未通過]\n欄位漏了 tracking']
  );
  await runTaskCoding(t.id, userId);

  const { rows: [after] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.retry_feedback).toContain('欄位漏了 tracking'); // 未成功執行＝未消費
});
