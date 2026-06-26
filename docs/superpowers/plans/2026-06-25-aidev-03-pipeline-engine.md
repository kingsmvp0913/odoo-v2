# AI Dev Web Platform — Sub-plan 3: Pipeline Engine + Git

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 實作 Analysis Agent（SDK → analysis.yaml）、Git branch 管理、Pipeline 狀態機（runner.js）、手動觸發 API，並將 runner 整合到 cron 排程。Coding/QA Agent 子流程由 Sub-plan 5（Terminal）補完；本計畫只將 coding_running 和 qa_running 視為「等待終端介入」的狀態，runner 不自動推進。

**Architecture:** `runner.js` 每次 tick 掃描所有可推進的任務（analysis_running、branch_pending、deploy_pending），依狀態呼叫對應模組。`analysis.js` 以 SDK 產出 analysis.yaml，`git.js` 以 `child_process.execFile` 執行 git 指令。`pipeline-routes.js` 提供手動觸發 + MODE_B 審核通過 endpoint。

**Tech Stack:** @anthropic-ai/sdk（已安裝）、js-yaml ^4.1.0（新增）、child_process.execFile（Node 內建）

## Global Constraints

- Port: **3939**（不變）
- DB: PostgreSQL via pg-mem in tests
- Analysis model: `claude-sonnet-4-6`（Triage 同款，輸出 YAML 非 JSON）
- `ANTHROPIC_API_KEY` 從環境變數讀取（同 triage.js 邏輯）
- Runner 不自動推進 `coding_running` / `qa_running`（Sub-plan 5 負責）
- Git 操作使用 `execFile`（安全，無 shell 展開），`runDeploy` 用 `exec`（用戶自定指令）
- `odoo_settings.git_repo_path` 指定 git repo 位置；未設定時 branch_pending → 跳過 git，直接設 `coding_running`
- `analysis_yaml` 欄位儲存原始 YAML 文字（不在 DB 解析）
- Loop counter：每 `runPipeline(userId)` 呼叫遞增；> 5 時停止並 emit `notify:toast`，syncUser 加入新任務時重設
- 所有 pipeline 操作不寫本機檔案

---

## File Map

| 路徑 | 職責 |
|---|---|
| `app/server/pipeline/analysis.js` | Analysis Agent（SDK → analysis.yaml） |
| `app/server/pipeline/git.js` | Git 操作（createBranch / mergeBranch / runDeploy） |
| `app/server/pipeline/runner.js` | Pipeline 狀態機（掃描 + 推進） |
| `app/server/pipeline-routes.js` | POST /api/pipeline/run、POST /api/tasks/:id/approve |
| `app/server/index.js` | 掛載 pipeline routes（修改） |
| `app/server/cron.js` | 在 triageNewTasks 之後呼叫 runPipeline（修改） |
| `app/package.json` | 新增 js-yaml（修改） |
| `app/server/tests/analysis.test.js` | Analysis Agent 測試 |
| `app/server/tests/git.test.js` | Git 操作測試 |
| `app/server/tests/runner.test.js` | 狀態機測試 |
| `app/server/tests/pipeline-routes.test.js` | Pipeline API 測試 |

---

## Task 1: Analysis Agent

**Files:**
- Create: `app/server/pipeline/analysis.js`
- Modify: `app/package.json`（新增 js-yaml）
- Create: `app/server/tests/analysis.test.js`

**Interfaces:**
- Consumes: `query` from `../db`; `@anthropic-ai/sdk`; `js-yaml`
- Produces:
  - `analyzeTask(taskId)` → `Promise<{ next_status, analysis_yaml }>`
  - `next_status` 一律是以下之一：`'branch_pending'`（MODE_A）、`'final_pending'`（MODE_B）、`'confirm_pending'`（有問題或 low_confidence）、`'stopped'`（API 錯誤或 YAML 解析失敗）

analysis.yaml 必填欄位（js-yaml 解析後驗證）：
```yaml
case_id: ""
module: ""
odoo_version: ""
project_name: null
execution_mode: "MODE_A"
summary: ""
requirements: []
low_confidence: false
clarification_channel:
  questions: []
  user_answer: ""
```

Analysis 系統 prompt（`ANALYSIS_SYSTEM_PROMPT` 常數）：
```
你是 Odoo 開發需求分析師。分析任務需求並輸出 analysis.yaml。

輸出必須是嚴格合法的 YAML，只有 YAML 本身，不含任何 markdown code block 或其他文字。

必要欄位：
case_id、module（英文底線格式）、odoo_version（e.g. "17.0"）、project_name（null 或字串）、
execution_mode（"MODE_A" 直接實作 / "MODE_B" 先確認再實作）、
summary（一段中文摘要）、requirements（需求列表）、
low_confidence（true/false）、
clarification_channel:
  questions: []
  user_answer: ""

判斷規則：
- MODE_A：需求明確、影響範圍小、修改集中在單一模組
- MODE_B：涉及複雜業務流程、多模組影響、高風險資料異動
- low_confidence=true：對需求有重大不確定性時
- questions 非空：有需要使用者確認的具體問題
若 low_confidence=true 或 questions 非空 → next_status 應為 confirm_pending
```

- [ ] **Step 1: 更新 package.json 加入 js-yaml**

修改 `app/package.json`，在 dependencies 加入：

```json
"js-yaml": "^4.1.0"
```

完整 dependencies：

```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.30.0",
  "bcryptjs": "^2.4.3",
  "express": "^4.19.2",
  "js-yaml": "^4.1.0",
  "jsonwebtoken": "^9.0.2",
  "node-cron": "^3.0.3",
  "pg": "^8.22.0",
  "socket.io": "^4.7.5"
}
```

```bash
cd app && npm install
```

- [ ] **Step 2: 撰寫失敗的 analysis test**

建立 `app/server/tests/analysis.test.js`：

```javascript
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));

let dbModule, analysisModule, Anthropic, mockCreate;
let userId, taskId;

const VALID_YAML_MODE_A = `case_id: "task_odoo_9001"
module: purchase
odoo_version: "17.0"
project_name: odoo17_hungjou
execution_mode: MODE_A
summary: 修正採購單問題
requirements:
  - 修正 XYZ
low_confidence: false
clarification_channel:
  questions: []
  user_answer: ""`;

const VALID_YAML_MODE_B = `case_id: "task_odoo_9002"
module: stock
odoo_version: "17.0"
project_name: null
execution_mode: MODE_B
summary: 庫存複雜調整
requirements:
  - 修正庫存
low_confidence: false
clarification_channel:
  questions: []
  user_answer: ""`;

const YAML_WITH_QUESTIONS = `case_id: "task_odoo_9003"
module: sale
odoo_version: "17.0"
project_name: null
execution_mode: MODE_A
summary: 需確認的任務
requirements: []
low_confidence: false
clarification_channel:
  questions:
    - 請確認欄位格式？
  user_answer: ""`;

const YAML_LOW_CONFIDENCE = `case_id: "task_odoo_9004"
module: account
odoo_version: "17.0"
project_name: null
execution_mode: MODE_A
summary: 不確定的任務
requirements: []
low_confidence: true
clarification_channel:
  questions: []
  user_answer: ""`;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: users } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('atest', $1, 'A', 'user') RETURNING id",
    [hash]
  );
  userId = users[0].id;

  Anthropic = require('@anthropic-ai/sdk');
  mockCreate = Anthropic.mock.results[0].value.messages.create;

  analysisModule = require('../pipeline/analysis');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status) VALUES ($1, $2, 'odoo', 'Test', '---id---\n9001\n---title---\nTest Task', 'analysis_running') RETURNING id",
    [userId, `task_odoo_${Date.now()}`]
  );
  taskId = rows[0].id;
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

afterEach(async () => {
  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('analyzeTask MODE_A → next_status branch_pending, analysis_yaml saved', async () => {
  mockCreate.mockResolvedValue({ content: [{ text: VALID_YAML_MODE_A }] });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('branch_pending');
  expect(result.analysis_yaml).toContain('execution_mode: MODE_A');

  const { rows } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('branch_pending');
  expect(rows[0].analysis_yaml).toContain('MODULE_A'); // any check
});

test('analyzeTask MODE_B → next_status final_pending', async () => {
  mockCreate.mockResolvedValue({ content: [{ text: VALID_YAML_MODE_B }] });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('final_pending');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('final_pending');
});

test('analyzeTask with questions → next_status confirm_pending', async () => {
  mockCreate.mockResolvedValue({ content: [{ text: YAML_WITH_QUESTIONS }] });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('confirm_pending');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('confirm_pending');
});

test('analyzeTask low_confidence → next_status confirm_pending', async () => {
  mockCreate.mockResolvedValue({ content: [{ text: YAML_LOW_CONFIDENCE }] });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('confirm_pending');
});

test('analyzeTask invalid YAML → stopped with blocker', async () => {
  mockCreate.mockResolvedValue({ content: [{ text: 'this is not yaml: [broken' }] });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('stopped');

  const { rows } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_type).toBe('agent');
});

test('analyzeTask API error → resets to analysis_running and rethrows', async () => {
  mockCreate.mockRejectedValue(new Error('Rate limit'));

  await expect(analysisModule.analyzeTask(taskId)).rejects.toThrow('Rate limit');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
});
```

- [ ] **Step 3: 執行確認失敗**

```bash
cd app && npx jest tests/analysis.test.js --no-coverage
```

預期：FAIL（Cannot find module pipeline/analysis）

- [ ] **Step 4: 建立 analysis.js**

建立 `app/server/pipeline/analysis.js`：

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const yaml = require('js-yaml');
const { query } = require('../db');

const ANALYSIS_SYSTEM_PROMPT = `你是 Odoo 開發需求分析師。分析任務需求並輸出 analysis.yaml。

輸出必須是嚴格合法的 YAML，只有 YAML 本身，不含任何 markdown code block 或其他文字。

必要欄位：
case_id（任務 ID）、module（英文底線格式，e.g. purchase）、odoo_version（e.g. "17.0"）、
project_name（null 或字串）、execution_mode（"MODE_A" 直接實作 / "MODE_B" 先確認再實作）、
summary（一段中文摘要）、requirements（列表）、
low_confidence（true/false）、
clarification_channel:
  questions: []
  user_answer: ""

判斷規則：
- MODE_A：需求明確、影響範圍小、修改集中在單一模組
- MODE_B：涉及複雜業務流程、多模組影響、高風險資料異動
- low_confidence=true：對需求有重大不確定性
- questions 非空：有需要使用者確認的具體問題`;

const REQUIRED_FIELDS = ['case_id', 'module', 'odoo_version', 'execution_mode', 'summary'];

function determineNextStatus(parsed) {
  const hasQuestions = Array.isArray(parsed?.clarification_channel?.questions) &&
    parsed.clarification_channel.questions.length > 0;
  if (parsed?.low_confidence === true || hasQuestions) return 'confirm_pending';
  if (parsed?.execution_mode === 'MODE_B') return 'final_pending';
  return 'branch_pending';
}

async function analyzeTask(taskId) {
  const { rows } = await query('SELECT original_text, task_id FROM tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: task.original_text || '（無內容）' }]
    });
  } catch (apiErr) {
    await query(
      "UPDATE tasks SET status = 'analysis_running', updated_at = NOW() WHERE id = $1",
      [taskId]
    );
    console.error(`[ANALYSIS] API error task ${taskId}:`, apiErr.message);
    throw apiErr;
  }

  const rawYaml = response.content[0]?.text || '';

  let parsed;
  try {
    parsed = yaml.load(rawYaml);
    const missing = REQUIRED_FIELDS.filter(f => !parsed?.[f]);
    if (missing.length > 0) throw new Error(`Missing required YAML fields: ${missing.join(', ')}`);
  } catch (parseErr) {
    await query(
      `UPDATE tasks SET status = 'stopped', blocker_type = 'agent',
       blocker_content = $2, updated_at = NOW() WHERE id = $1`,
      [taskId, `Analysis YAML error: ${parseErr.message}\n\n${rawYaml.slice(0, 500)}`]
    );
    return { next_status: 'stopped', analysis_yaml: rawYaml };
  }

  const next_status = determineNextStatus(parsed);

  await query(
    `UPDATE tasks SET status = $2, analysis_yaml = $3, updated_at = NOW() WHERE id = $1`,
    [taskId, next_status, rawYaml]
  );

  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `Analysis: ${parsed.summary || ''}\nMode: ${parsed.execution_mode}\nModule: ${parsed.module}`]
  );

  return { next_status, analysis_yaml: rawYaml };
}

module.exports = { analyzeTask };
```

- [ ] **Step 5: 執行確認通過**

```bash
cd app && npx jest tests/analysis.test.js --no-coverage
```

預期：PASS（6 tests）

- [ ] **Step 6: 全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（46 + 6 = 52 tests）

- [ ] **Step 7: Commit**

```bash
git add app/server/pipeline/analysis.js app/server/tests/analysis.test.js app/package.json app/package-lock.json
git commit -m "feat: Analysis Agent (Sonnet → analysis.yaml, MODE_A/B/confirm routing)"
```

---

## Task 2: Git Operations

**Files:**
- Create: `app/server/pipeline/git.js`
- Create: `app/server/tests/git.test.js`

**Interfaces:**
- Produces:
  - `createBranch(repoPath, branchName)` → `Promise<void>`
  - `checkoutDefault(repoPath)` → `Promise<string>` (returns default branch name: master or main)
  - `mergeBranch(repoPath, branchName, strategy)` → `Promise<void>` (strategy: 'merge' | 'squash')
  - `runDeploy(deployCmd)` → `Promise<{ stdout, stderr }>` (null/empty deployCmd → resolved immediately)

- [ ] **Step 1: 撰寫失敗的 git test**

建立 `app/server/tests/git.test.js`：

```javascript
jest.mock('child_process', () => ({
  execFile: jest.fn(),
  exec: jest.fn()
}));

const childProcess = require('child_process');
let gitModule;

beforeAll(() => {
  gitModule = require('../pipeline/git');
});

beforeEach(() => {
  childProcess.execFile.mockReset();
  childProcess.exec.mockReset();
});

function mockExecFileSuccess() {
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { opts(null, 'ok', ''); return; }
    cb(null, 'ok', '');
  });
}

function mockExecFileFail(msg) {
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { opts(new Error(msg)); return; }
    cb(new Error(msg));
  });
}

test('createBranch calls git checkout -b with correct args', async () => {
  mockExecFileSuccess();
  await gitModule.createBranch('/repo', 'task/task_odoo_1');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['checkout', '-b', 'task/task_odoo_1'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('createBranch rejects on git error', async () => {
  mockExecFileFail('branch already exists');
  await expect(gitModule.createBranch('/repo', 'task/existing')).rejects.toThrow('branch already exists');
});

test('mergeBranch strategy=merge calls git merge --no-ff', async () => {
  mockExecFileSuccess();
  await gitModule.mergeBranch('/repo', 'task/task_odoo_1', 'merge');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['merge', '--no-ff', 'task/task_odoo_1'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('mergeBranch strategy=squash calls git merge --squash', async () => {
  mockExecFileSuccess();
  await gitModule.mergeBranch('/repo', 'task/task_odoo_1', 'squash');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['merge', '--squash', 'task/task_odoo_1'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('runDeploy resolves immediately when deployCmd is empty', async () => {
  await expect(gitModule.runDeploy('')).resolves.toBeUndefined();
  await expect(gitModule.runDeploy(null)).resolves.toBeUndefined();
  expect(childProcess.exec).not.toHaveBeenCalled();
});

test('runDeploy executes shell command when deployCmd is set', async () => {
  childProcess.exec.mockImplementation((cmd, opts, cb) => {
    cb(null, 'deployed', '');
  });
  const result = await gitModule.runDeploy('make deploy');
  expect(childProcess.exec).toHaveBeenCalledWith('make deploy', { timeout: 120000 }, expect.any(Function));
  expect(result).toEqual({ stdout: 'deployed', stderr: '' });
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/git.test.js --no-coverage
```

預期：FAIL（Cannot find module pipeline/git）

- [ ] **Step 3: 建立 git.js**

建立 `app/server/pipeline/git.js`：

```javascript
const { execFile, exec } = require('child_process');

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function createBranch(repoPath, branchName) {
  await execFileAsync('git', ['checkout', '-b', branchName], { cwd: repoPath });
}

async function checkoutDefault(repoPath) {
  // Try master first, then main
  try {
    await execFileAsync('git', ['checkout', 'master'], { cwd: repoPath });
    return 'master';
  } catch {
    await execFileAsync('git', ['checkout', 'main'], { cwd: repoPath });
    return 'main';
  }
}

async function mergeBranch(repoPath, branchName, strategy = 'merge') {
  const mergeArgs = strategy === 'squash'
    ? ['merge', '--squash', branchName]
    : ['merge', '--no-ff', branchName];
  await execFileAsync('git', mergeArgs, { cwd: repoPath });
}

function runDeploy(deployCmd) {
  if (!deployCmd) return Promise.resolve();
  return new Promise((resolve, reject) => {
    exec(deployCmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

module.exports = { createBranch, checkoutDefault, mergeBranch, runDeploy };
```

- [ ] **Step 4: 執行確認通過**

```bash
cd app && npx jest tests/git.test.js --no-coverage
```

預期：PASS（6 tests）

- [ ] **Step 5: 全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（52 + 6 = 58 tests）

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/git.js app/server/tests/git.test.js
git commit -m "feat: git branch/merge/deploy operations (execFile-safe)"
```

---

## Task 3: Pipeline Runner (State Machine)

**Files:**
- Create: `app/server/pipeline/runner.js`
- Create: `app/server/tests/runner.test.js`

**Interfaces:**
- Consumes: `query` from `../db`; `analyzeTask` from `./analysis`; `createBranch`, `runDeploy` from `./git`; `notify` from `../notify`
- Produces:
  - `runPipeline(userId)` → `Promise<{ processed: number }>`
  - `resetLoopCounter(userId)` → `Promise<void>`

狀態推進規則（runner 只處理這些狀態）：

| 現狀 | 動作 | 下一狀態 |
|---|---|---|
| `analysis_running` | 呼叫 `analyzeTask` | `branch_pending` / `final_pending` / `confirm_pending` / `stopped` |
| `branch_pending` | `createBranch`（若無 git_repo_path 則跳過 git）| `coding_running` |
| `deploy_pending` | `runDeploy`（若無 deploy_cmd 則跳過）| `done` |
| `final_pending` | 等待用戶審核（不自動推進）| — |
| `coding_running` | 等待 Terminal（不自動推進）| — |
| `qa_running` | 等待 Terminal（不自動推進）| — |

Loop counter 規則：
- `loop_counter` 表：`upsert` on `user_id UNIQUE`，`loop_count` 每次 `runPipeline` 遞增
- Loop count > 5 → 跳過此 user，emit `notify:toast { level: 'warn', message: '... 已達上限' }`
- `resetLoopCounter(userId)` 設 `loop_count = 0`（syncUser 加入新任務時呼叫）

簡易 Semaphore（自實作，無需 p-limit）：
- 最多 3 個 analysis 任務同時進行（per runPipeline 呼叫）

- [ ] **Step 1: 撰寫失敗的 runner test**

建立 `app/server/tests/runner.test.js`：

```javascript
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/analysis', () => ({
  analyzeTask: jest.fn()
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn().mockResolvedValue(undefined),
  runDeploy: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../notify', () => ({
  emitToUser: jest.fn(),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));

let dbModule, runnerModule;
let userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, odoo_settings) VALUES ('runner', $1, 'R', 'user', $2) RETURNING id",
    [hash, JSON.stringify({ git_repo_path: '/repo', deploy_cmd: '' })]
  );
  userId = rows[0].id;

  runnerModule = require('../pipeline/runner');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  require('../pipeline/analysis').analyzeTask.mockReset();
  require('../pipeline/git').createBranch.mockReset();
  require('../pipeline/git').runDeploy.mockReset();
  require('../notify').emitToUser.mockReset();
  // Reset loop counter
  await runnerModule.resetLoopCounter(userId);
  // Clean tasks
  await dbModule.query('DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id = $1', [userId]);
});

async function insertTask(status, taskIdSuffix = Date.now()) {
  const { rows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1, $2, 'odoo', 'Test', 'content', $3) RETURNING id`,
    [userId, `task_odoo_${taskIdSuffix}`, status]
  );
  return rows[0].id;
}

test('runPipeline advances analysis_running task via analyzeTask', async () => {
  const { analyzeTask } = require('../pipeline/analysis');
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: 'yaml content' });

  const taskId = await insertTask('analysis_running');
  const result = await runnerModule.runPipeline(userId);
  expect(result.processed).toBe(1);
  expect(analyzeTask).toHaveBeenCalledWith(taskId);
});

test('runPipeline creates branch for branch_pending task', async () => {
  const { createBranch } = require('../pipeline/git');
  createBranch.mockResolvedValue(undefined);

  const taskId = await insertTask('branch_pending');
  await runnerModule.runPipeline(userId);

  expect(createBranch).toHaveBeenCalledWith('/repo', expect.stringContaining('task/task_odoo'));

  const { rows } = await dbModule.query('SELECT status, git_branch FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('coding_running');
  expect(rows[0].git_branch).toContain('task/');
});

test('runPipeline skips branch creation when git_repo_path not set', async () => {
  // Update user to have no git_repo_path
  await dbModule.query(
    "UPDATE users SET odoo_settings = $2 WHERE id = $1",
    [userId, JSON.stringify({ git_repo_path: '', deploy_cmd: '' })]
  );

  const { createBranch } = require('../pipeline/git');
  const taskId = await insertTask('branch_pending');
  await runnerModule.runPipeline(userId);

  expect(createBranch).not.toHaveBeenCalled();

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('coding_running');

  // Restore
  await dbModule.query(
    "UPDATE users SET odoo_settings = $2 WHERE id = $1",
    [userId, JSON.stringify({ git_repo_path: '/repo', deploy_cmd: '' })]
  );
});

test('runPipeline advances deploy_pending to done', async () => {
  const { runDeploy } = require('../pipeline/git');
  runDeploy.mockResolvedValue(undefined);

  const taskId = await insertTask('deploy_pending');
  await runnerModule.runPipeline(userId);

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('done');
});

test('runPipeline stops when loop counter > 5', async () => {
  const { analyzeTask } = require('../pipeline/analysis');
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: '' });

  // Run 6 times to hit limit
  for (let i = 0; i < 6; i++) {
    await insertTask('analysis_running', Date.now() + i);
    await runnerModule.runPipeline(userId);
  }

  const { emitToUser } = require('../notify');
  const toastCalls = emitToUser.mock.calls.filter(c => c[1] === 'notify:toast');
  expect(toastCalls.length).toBeGreaterThan(0);
  expect(toastCalls[toastCalls.length - 1][2].level).toBe('warn');
});

test('resetLoopCounter resets count to 0', async () => {
  const { analyzeTask } = require('../pipeline/analysis');
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: '' });

  // Hit loop limit
  for (let i = 0; i < 6; i++) {
    await insertTask('analysis_running', Date.now() + i * 1000);
    await runnerModule.runPipeline(userId);
  }

  await runnerModule.resetLoopCounter(userId);

  // Insert a fresh task and verify it gets processed
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: '' });
  await insertTask('analysis_running', Date.now() + 9999);
  const result = await runnerModule.runPipeline(userId);
  expect(result.processed).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/runner.test.js --no-coverage
```

預期：FAIL（Cannot find module pipeline/runner）

- [ ] **Step 3: 建立 runner.js**

建立 `app/server/pipeline/runner.js`：

```javascript
const { query } = require('../db');
const { analyzeTask } = require('./analysis');
const { createBranch, runDeploy } = require('./git');
const notify = require('../notify');

const LOOP_LIMIT = 5;
const RUNNABLE_STATUSES = ['analysis_running', 'branch_pending', 'deploy_pending'];

async function getLoopCount(userId) {
  const { rows } = await query(
    'SELECT loop_count FROM loop_counter WHERE user_id = $1',
    [userId]
  );
  return rows.length ? rows[0].loop_count : 0;
}

async function incrementLoopCounter(userId) {
  await query(
    `INSERT INTO loop_counter (user_id, loop_count, run_started_at)
     VALUES ($1, 1, NOW())
     ON CONFLICT (user_id) DO UPDATE SET loop_count = loop_counter.loop_count + 1, run_started_at = NOW()`,
    [userId]
  );
}

async function resetLoopCounter(userId) {
  await query(
    `INSERT INTO loop_counter (user_id, loop_count, run_started_at)
     VALUES ($1, 0, NOW())
     ON CONFLICT (user_id) DO UPDATE SET loop_count = 0`,
    [userId]
  );
}

async function getUserSettings(userId) {
  const { rows } = await query('SELECT odoo_settings, deploy_cmd FROM users WHERE id = $1', [userId]);
  if (!rows.length) return {};
  const settings = rows[0].odoo_settings || {};
  return {
    git_repo_path: settings.git_repo_path || '',
    deploy_cmd: rows[0].deploy_cmd || settings.deploy_cmd || ''
  };
}

async function processTask(task, settings) {
  const { id: taskId, task_id, status } = task;

  if (status === 'analysis_running') {
    await analyzeTask(taskId);
    return;
  }

  if (status === 'branch_pending') {
    const branchName = `task/${task_id}`;
    if (settings.git_repo_path) {
      await createBranch(settings.git_repo_path, branchName);
    }
    await query(
      "UPDATE tasks SET status = 'coding_running', git_branch = $2, updated_at = NOW() WHERE id = $1",
      [taskId, branchName]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'coding_running' });
    return;
  }

  if (status === 'deploy_pending') {
    try {
      await runDeploy(settings.deploy_cmd);
    } catch (deployErr) {
      console.error(`[RUNNER] deploy error task ${taskId}:`, deployErr.message);
      await query(
        `UPDATE tasks SET status = 'stopped', blocker_type = 'tech',
         blocker_content = $2, updated_at = NOW() WHERE id = $1`,
        [taskId, `Deploy failed: ${deployErr.message}`]
      );
      return;
    }
    await query(
      "UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1",
      [taskId]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'done' });
  }
}

async function runPipeline(userId) {
  const loopCount = await getLoopCount(userId);
  if (loopCount >= LOOP_LIMIT) {
    notify.emitToUser(userId, 'notify:toast', {
      level: 'warn',
      message: `Pipeline 已達 ${LOOP_LIMIT} 次上限，等待新任務或手動重設`
    });
    return { processed: 0 };
  }

  await incrementLoopCounter(userId);

  const { rows: tasks } = await query(
    `SELECT id, task_id, status, user_id FROM tasks
     WHERE user_id = $1 AND status = ANY($2::text[])
     ORDER BY updated_at ASC`,
    [userId, RUNNABLE_STATUSES]
  );

  if (tasks.length === 0) return { processed: 0 };

  const settings = await getUserSettings(userId);
  let processed = 0;

  for (const task of tasks) {
    try {
      await processTask(task, settings);
      processed++;
    } catch (err) {
      console.error(`[RUNNER] task ${task.id} error:`, err.message);
    }
  }

  return { processed };
}

module.exports = { runPipeline, resetLoopCounter };
```

- [ ] **Step 4: 執行確認通過**

```bash
cd app && npx jest tests/runner.test.js --no-coverage
```

預期：PASS（6 tests）

- [ ] **Step 5: 全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（58 + 6 = 64 tests）

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/runner.js app/server/tests/runner.test.js
git commit -m "feat: pipeline state machine (analysis→branch→coding_running, deploy→done)"
```

---

## Task 4: Pipeline Routes + Cron Wire + Index

**Files:**
- Create: `app/server/pipeline-routes.js`
- Modify: `app/server/cron.js`（加入 runPipeline 呼叫 + resetLoopCounter on new tasks）
- Modify: `app/server/index.js`（掛載 pipeline routes）
- Create: `app/server/tests/pipeline-routes.test.js`

**Interfaces:**
- `POST /api/pipeline/run` → 立即執行目前 user 的 pipeline（需 verifyToken）
  - Response: `{ processed: N }`
- `POST /api/tasks/:id/approve` → MODE_B 審核通過，final_pending → branch_pending
  - 需 verifyToken；只接受 final_pending 任務
  - Response: `{ ok: true }`

更新 `cron.js` 的 `runForUser`：
- 若 `syncUser` 有新任務（`total > 0`）→ 呼叫 `resetLoopCounter(userId)`
- 在 `triageNewTasks` 之後呼叫 `runPipeline(userId)`

- [ ] **Step 1: 撰寫失敗的 pipeline-routes test**

建立 `app/server/tests/pipeline-routes.test.js`：

```javascript
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 2 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(),
  runDeploy: jest.fn()
}));

process.env.JWT_SECRET = 'test-pipeline-secret';

let app, dbModule, adminToken, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  adminToken = res.body.token;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  userId = me.body.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('POST /api/pipeline/run → 401 without token', async () => {
  const res = await request(app).post('/api/pipeline/run');
  expect(res.status).toBe(401);
});

test('POST /api/pipeline/run → calls runPipeline and returns processed count', async () => {
  const res = await request(app).post('/api/pipeline/run')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.processed).toBe(2);
  const { runPipeline } = require('../pipeline/runner');
  expect(runPipeline).toHaveBeenCalledWith(userId);
});

test('POST /api/tasks/:id/approve → 400 for non-final_pending task', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_odoo_approve_test', 'odoo', 'Test', 'analysis_running') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(400);

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/approve → advances final_pending to branch_pending', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_odoo_approve_ok', 'odoo', 'Test', 'final_pending') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);

  const { rows: updated } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(updated[0].status).toBe('branch_pending');

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/pipeline-routes.test.js --no-coverage
```

預期：FAIL（route not found）

- [ ] **Step 3: 建立 pipeline-routes.js**

建立 `app/server/pipeline-routes.js`：

```javascript
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { runPipeline } = require('./pipeline/runner');

function registerRoutes(app) {
  app.post('/api/pipeline/run', verifyToken, async (req, res) => {
    try {
      const result = await runPipeline(req.userId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/approve', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'final_pending') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' cannot be approved; expected final_pending` });
      }
      await query(
        "UPDATE tasks SET status = 'branch_pending', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '審核通過，開始實作')",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
```

- [ ] **Step 4: 更新 index.js 掛載 pipeline routes**

修改 `app/server/index.js`（取代整個 createApp 區塊）：

```javascript
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { registerRoutes: registerAuthRoutes } = require('./auth');
const { registerRoutes: registerSettingsRoutes } = require('./settings');
const { registerRoutes: registerTasksRoutes } = require('./tasks-routes');
const { registerRoutes: registerPipelineRoutes } = require('./pipeline-routes');

const PORT = process.env.PORT || 3939;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  registerTasksRoutes(app);
  registerPipelineRoutes(app);
  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  return app;
}

if (require.main === module) {
  const { migrate } = require('./db');
  const { setIo } = require('./notify');
  const { startCron } = require('./cron');

  const app = createApp();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log('connected:', socket.id);
  });

  migrate().then(() => {
    setIo(io);
    startCron();
    httpServer.listen(PORT, () => console.log(`AI Dev http://localhost:${PORT}`));
  }).catch(err => {
    console.error('DB migration failed:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
```

- [ ] **Step 5: 更新 cron.js 加入 runPipeline + resetLoopCounter**

取代 `app/server/cron.js` 全文：

```javascript
const cron = require('node-cron');
const { query } = require('./db');
const { syncUser } = require('./pipeline/sync');
const { triageNewTasks } = require('./pipeline/triage');
const { runPipeline, resetLoopCounter } = require('./pipeline/runner');
const notify = require('./notify');

const lastSync = new Map();
let _job = null;

async function runForUser(userId) {
  try {
    const result = await syncUser(userId);
    const total = result.odoo.added + result.service.added;
    if (total > 0) {
      notify.emitToUser(userId, 'task:synced', { count: total });
      await resetLoopCounter(userId);
    }
    await triageNewTasks(userId);
    await runPipeline(userId);
  } catch (err) {
    console.error(`[CRON] user ${userId}:`, err.message);
  }
}

function startCron() {
  _job = cron.schedule('* * * * *', async () => {
    try {
      const { rows: users } = await query(
        'SELECT id, sync_interval FROM users WHERE sync_interval > 0'
      );
      const now = Date.now();
      for (const user of users) {
        const last = lastSync.get(user.id) || 0;
        const interval = (user.sync_interval || 15) * 60 * 1000;
        if (now - last >= interval) {
          lastSync.set(user.id, now);
          runForUser(user.id);
        }
      }
    } catch (err) {
      console.error('[CRON] tick error:', err.message);
    }
  });
  return _job;
}

function stopCron() {
  if (_job) { _job.stop(); _job = null; }
}

module.exports = { startCron, stopCron };
```

- [ ] **Step 6: 執行確認通過**

```bash
cd app && npx jest tests/pipeline-routes.test.js --no-coverage
```

預期：PASS（4 tests）

- [ ] **Step 7: 全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（64 + 4 = 68 tests）

- [ ] **Step 8: Commit**

```bash
git add app/server/pipeline-routes.js app/server/pipeline-routes.test.js app/server/cron.js app/server/index.js app/server/tests/pipeline-routes.test.js
git commit -m "feat: pipeline routes (run/approve), cron wires runPipeline + resetLoopCounter"
```

---

## Self-Review

**Spec coverage check：**

| 設計規格需求 | 計畫中的 Task |
|---|---|
| Analysis Agent（產生 analysis.yaml）| Task 1 analysis.js |
| analysis.yaml 最小必填欄位驗證 | Task 1 REQUIRED_FIELDS check |
| MODE_A / MODE_B 執行模式 | Task 1 determineNextStatus |
| clarification_channel 結構 / low_confidence | Task 1 |
| Git branch 建立（`task/{task_id}`）| Task 2 git.js createBranch |
| Git merge（squash / merge commit）| Task 2 git.js mergeBranch |
| Deploy 指令執行 | Task 2 runDeploy |
| Pipeline 狀態機（runner.js）| Task 3 |
| Loop counter（> 5 停止）| Task 3 runner.js LOOP_LIMIT |
| 沒有 git_repo_path 時跳過 git | Task 3 |
| POST /api/pipeline/run | Task 4 |
| POST /api/tasks/:id/approve（MODE_B 通過）| Task 4 |
| Cron 整合 runPipeline | Task 4 cron.js 更新 |
| sync 有新任務時 resetLoopCounter | Task 4 cron.js 更新 |

**Placeholder scan：** 無 TBD / TODO。

**Type consistency：**
- `analyzeTask(taskId)` → Task 1 定義，Task 3 runner.js 呼叫相同簽名
- `createBranch(repoPath, branchName)` → Task 2 定義，Task 3 runner.js 呼叫相同簽名
- `runPipeline(userId)` → Task 3 定義，Task 4 pipeline-routes.js 和 cron.js 呼叫相同簽名
- `resetLoopCounter(userId)` → Task 3 定義，Task 4 cron.js 呼叫相同簽名

---

## 下一步：Sub-plan 4

完成本計畫後，繼續 `2026-06-25-aidev-04-web-ui.md`（Vue 3 CDN 任務 Dashboard、7 stage statusbar、對話歷史、篩選器）。
