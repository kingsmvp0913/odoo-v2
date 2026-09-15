// 意圖：analysis 不走 withResume，自己手寫續接，用區域變數 resumed 記帳。
// 審核兩度駁回同一個疑點（修正 43、44）：「續接失敗、同輪降級 fresh 之後，resumed 會不會還是 true？」
// 若是，最貴的降級重讀會被記成「續接成功」，跟健檢要的訊號正好相反。這支把三條路的記帳值釘死。
const { newDb } = require('pg-mem');
const { EventEmitter } = require('events');
jest.mock('../lib/odoo-core-src', () => ({ coreSourceGuidance: () => '（測試：核心來源守則）', ensureOdooCoreSrc: () => '', majorOf: (v) => String(v || '').split('.')[0] }));
process.env.APP_SECRET = 'test-app-secret';
const { encrypt } = require('../lib/crypto');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/git', () => {
  let sha = 0;
  return {
    pullBranch: jest.fn(),
    ensureMainBranch: jest.fn().mockResolvedValue('main'),
    ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined),
    getMainBranch: jest.fn().mockResolvedValue('main'),
    AI_BRANCH: 'ai-dev',
    ensureAiBranch: jest.fn().mockResolvedValue('ai-dev'),
    syncMainIntoAi: jest.fn().mockResolvedValue({ hasConflicts: false, conflictFiles: [] }),
    commitResolved: jest.fn().mockResolvedValue(undefined),
    abortMerge: jest.fn().mockResolvedValue(undefined),
    revParse: jest.fn(() => Promise.resolve(`sha-${++sha}`))
  };
});
jest.mock('../pipeline/merge-agent', () => ({
  resolveConflicts: jest.fn().mockResolvedValue({ failed: [], details: {} }),
  SYNC_LABELS: { oursLabel: 'ai-dev（AI 現況）', theirsLabel: 'main（工程師新進）' }
}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

let dbModule, runTaskAnalysis, logTokenUsage, logFailedUsage, userId, projectId;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, github_pat_enc, github_login, git_name, git_email) VALUES ('tar', 'x', 'T', $1, 'tar', 'T', 'tar@users.noreply.github.com') RETURNING id",
    [encrypt('test-pat-token')]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('TAR', '17.0') RETURNING id");
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/tar/main',true,'done')",
    [projectId]
  );
  ({ logTokenUsage, logFailedUsage } = require('../pipeline/token-logger'));
  ({ runTaskAnalysis } = require('../pipeline/task-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

const analysisVer = () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  return `${promptVersion('analysis-project')}.${promptVersion('analysis-retry')}`;
};

// resumeFails=true：帶 --resume 的那次呼叫以 exit 1 結束（session 已被 CLI 回收），其餘成功產出規格
function spawnAnalysis({ resumeFails = false } = {}) {
  const { spawn } = require('child_process');
  spawn.mockReset();
  spawn.mockImplementation((cmd, args) => {
    const isResume = (args || []).includes('--resume');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write: () => {},
      end: () => setImmediate(() => {
        if (isResume && resumeFails) { child.stderr.emit('data', 'No conversation found'); child.emit('close', 1); return; }
        child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-X' }) + '\n');
        child.stdout.emit('data', JSON.stringify({
          type: 'result',
          result: '<result>\ncase_id: "x"\nmodule: "idx_x"\nexecution_mode: "MODE_A"\nsummary: "s"\nodoo_version: "17.0"\n</result>',
          usage: { input_tokens: 1 }, duration_ms: 10
        }) + '\n');
        child.emit('close', 0);
      })
    };
    return child;
  });
}

let seq = 0;
async function makeTask(sessionId) {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id,
      analysis_yaml, analysis_session_id, analysis_prompt_ver, analysis_resume_count)
     VALUES ($1, $2, 'odoo', 'T', '需求', 'analysis_running', $3, $4, $5, $6, 0) RETURNING id`,
    [userId, `tar_${++seq}`, projectId, sessionId ? 'module: "idx_x"' : null, sessionId, sessionId ? analysisVer() : null]
  );
  return t.id;
}

const analysisLogs = () => logTokenUsage.mock.calls.filter(c => c[2] === 'analysis');

beforeEach(() => { logTokenUsage.mockClear(); logFailedUsage.mockClear(); });

test('首輪（無 session）→ resumed=false', async () => {
  spawnAnalysis();
  await runTaskAnalysis(await makeTask(null), userId);
  expect(analysisLogs()).toHaveLength(1);
  expect(analysisLogs()[0][5]).toBe('completed');
  expect(analysisLogs()[0][6]).toBe(false);
});

test('續接成功 → resumed=true', async () => {
  spawnAnalysis();
  await runTaskAnalysis(await makeTask('sess-LIVE'), userId);
  const { spawn } = require('child_process');
  expect(spawn.mock.calls.some(c => (c[1] || []).includes('--resume'))).toBe(true);
  expect(analysisLogs()).toHaveLength(1);
  expect(analysisLogs()[0][6]).toBe(true);
});

test('續接失敗、同輪降級 fresh → 失敗列 true，降級後的成功列必須是 false（不是 true）', async () => {
  spawnAnalysis({ resumeFails: true });
  await runTaskAnalysis(await makeTask('sess-GONE'), userId);
  const failed = logFailedUsage.mock.calls.filter(c => c[2] === 'analysis');
  expect(failed).toHaveLength(1);
  expect(failed[0][4]).toBe(true);
  expect(analysisLogs()).toHaveLength(1);
  expect(analysisLogs()[0][6]).toBe(false);
});
