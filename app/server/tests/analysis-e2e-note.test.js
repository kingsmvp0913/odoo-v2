// 意圖（Rule 9）：E2E 關閉的專案，整條 pipeline 沒有任何一關會跑 Odoo 測試檔
// （deploy 是 -i/-u --stop-after-init，--test-enable 只在 E2E 那條路徑上）。分析關若照樣把
// 「新增 tests/test_*.py／tour」寫進規格，開發關就會產出沒人執行的死碼，錯了也只能靠 QA
// 逐行讀 diff 攔（已造成多筆 impl_miss 退回）。
// 這組測試釘住「送進分析關的 prompt 會依 projects.e2e_disabled 給出不同指示」——
// 把 e2e_note 拿掉或改成無條件同一段文字，這裡就紅。
const { newDb } = require('pg-mem');
const { EventEmitter } = require('events');
jest.mock('../lib/odoo-core-src', () => ({ coreSourceGuidance: () => '（測試：核心來源守則）', ensureOdooCoreSrc: () => '', majorOf: (v) => String(v || '').split('.')[0] }));
process.env.APP_SECRET = 'test-app-secret';
const { encrypt } = require('../lib/crypto');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  pullBranch: jest.fn(),
  ensureMainBranch: jest.fn().mockResolvedValue('main'),
  ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  AI_BRANCH: 'ai-dev',
  ensureAiBranch: jest.fn().mockResolvedValue('ai-dev'),
  syncMainIntoAi: jest.fn().mockResolvedValue({ hasConflicts: false, conflictFiles: [] }),
  commitResolved: jest.fn().mockResolvedValue(undefined),
  abortMerge: jest.fn().mockResolvedValue(undefined),
  revParse: jest.fn().mockResolvedValue('sha-1')
}));
jest.mock('../lib/worktree-guard', () => ({ resetTaskWorktreePointers: jest.fn().mockResolvedValue('/admin') }));
jest.mock('../pipeline/merge-agent', () => ({
  resolveConflicts: jest.fn().mockResolvedValue({ failed: [], details: {} }),
  SYNC_LABELS: { oursLabel: 'ai-dev（AI 現況）', theirsLabel: 'main（工程師新進）' }
}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));
// AI 一律在容器裡跑（2026-09-24 拿掉舊的非容器路徑）：runClaude 只剩「準備容器 → spawn docker」
// 一條路，真品會查 DB、驗映像檔、發通行證，單元測試跑不動。只換掉那兩支，waitForWorktreeIdle
// 留真品（這支測的等容器行為就是它）。容器路徑本身由 sandbox-run.test.js 對真品驗。
jest.mock('../pipeline/sandbox-run', () => ({
  ...jest.requireActual('../pipeline/sandbox-run'),
  ...require('./_sandbox-run-mock')(),
}));

let dbModule, runTaskAnalysis, loadAgent, invalidate;
let userId, projectId;

// 捕捉送進 claude 的 prompt（analysis 關是 fresh 輪，整包從 stdin 進去）
function captureAnalysisPrompt() {
  const { spawn } = require('child_process');
  const state = { prompt: '' };
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write: (d) => { state.prompt += d; },
      end: () => setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'result', result: '<result>\ncase_id: "x"\nmodule: "idx_x"\n</result>', usage: null, duration_ms: 10 }) + '\n');
        child.emit('close', 0);
      })
    };
    return child;
  });
  return state;
}

async function analysisPromptFor(taskKey, e2eDisabled) {
  await dbModule.query('UPDATE projects SET e2e_disabled=$2 WHERE id=$1', [projectId, e2eDisabled]);
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id) VALUES ($1,$2,'odoo','T','報價單加一個備註欄','analysis_running',$3) RETURNING id",
    [userId, taskKey, projectId]
  );
  const state = captureAnalysisPrompt();
  await runTaskAnalysis(t.id, userId).catch(() => {});
  return state.prompt;
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, github_pat_enc, github_login, git_name, git_email) VALUES ('e2enote', $1, 'E', $2, 'e2enote', 'E', 'e@users.noreply.github.com') RETURNING id",
    [hash, encrypt('test-pat-token')]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('E2ENote', '17.0') RETURNING id"
  );
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/e2enote/main',true,'done')",
    [projectId]
  );

  ({ runTaskAnalysis } = require('../pipeline/task-agent'));
  ({ loadAgent, invalidate } = require('../pipeline/agent-loader'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('e2e_disabled=true → 分析 prompt 明令不得把新增／修改測試檔寫進 requirements', async () => {
  const prompt = await analysisPromptFor('e2e_off', true);
  expect(prompt).toContain('本專案不執行任何自動化測試');
  expect(prompt).toContain('tests/test_*.py');            // 兩種測試檔都要點名，只講一種等於漏一半
  expect(prompt).toContain('static/tests/tours/*.js');
  expect(prompt).toContain('acceptance');                 // 改以人工驗收描述替代
});

test('e2e_disabled=false → 維持現狀，不加任何測試檔禁令', async () => {
  const prompt = await analysisPromptFor('e2e_on', false);
  expect(prompt).toContain('本專案會執行自動化測試');
  expect(prompt).not.toContain('本專案不執行任何自動化測試');
  expect(prompt).not.toContain('tests/test_*.py');
});

// 靜態守衛：placeholder 漏掉只會 console.warn、渲染成空字串，agent 照跑——JS 端算得再對也送不出去。
test('analysis-project.md 含 {{e2e_note}} placeholder', () => {
  invalidate();
  expect(loadAgent('analysis-project').body).toContain('{{e2e_note}}');
});
