# Token 用量報表 + 專案綁定 + 任務列表強化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 token 用量追蹤、報表頁面、任務自動綁定專案、任務列表強化，並移除廢棄的 coding_cmd/qa_cmd 功能。

**Architecture:** 伺服器端 agent 透過修改 `callClaude()` 回傳 usage 資料，呼叫 `logTokenUsage()` 寫入 `token_usage` 表；PS1 pipeline 透過 JSONL + cron ingest 寫入同一張表；前端報表頁透過 `/api/token-report` 查詢彙整後資料。

**Tech Stack:** Node.js / Express、PostgreSQL (pg)、Vue.js 3（無 build step，global components）、原生 SVG（不加圖表套件）、pg-mem（測試）、Jest

## Global Constraints

- 所有伺服器端程式碼放 `app/server/`，前端放 `app/public/js/views/`
- Vue component 以 `window.XxxView = Vue.defineComponent(...)` 導出，無 build step
- 測試使用 pg-mem + Jest；測試檔放 `app/server/tests/`；執行指令 `npm test` in `app/`
- 不引入新的前端套件；圖表使用原生 SVG
- DB migration 寫進 `app/server/db.js` 的 `migrate()` 函式（colMigrations 陣列或 statements 陣列）
- `callClaude()` 修改後必須向後相容：呼叫端若只取 `text` 欄位仍可正常運作（析構時用 `const { text } = await callClaude(...)` 或 `const result = await callClaude(...); result.text`）
- 刪除 `coding-agent.js` / `qa-agent.js` 前先確認無其他 `require` 路徑

---

## Task 1: DB Schema — token_usage 表 + projects 新欄位

**Files:**
- Modify: `app/server/db.js`
- Test: `app/server/tests/db-migration.test.js`

**Interfaces:**
- Produces: `token_usage` 表（10 欄）、`projects.odoo_project_name`、`projects.service_respondent_name`

- [ ] **Step 1: 新增 token_usage 表到 migrate()**

在 `app/server/db.js` 的 `statements` 陣列最後加入：

```js
`CREATE TABLE IF NOT EXISTS token_usage (
  id                   SERIAL PRIMARY KEY,
  task_id              TEXT,
  project_id           INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  agent_type           TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens  INTEGER NOT NULL DEFAULT 0,
  duration_ms          INTEGER,
  source               TEXT NOT NULL DEFAULT 'server' CHECK (source IN ('server','ps1')),
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
```

注意：不用 `GENERATED ALWAYS AS`（pg-mem 不支援），改在 API 查詢時用 `input_tokens + output_tokens + cache_read_tokens + cache_create_tokens AS total_tokens`。

- [ ] **Step 2: 新增 indexes 到 colMigrations 之後**

在 `migrate()` 的最後（現有的 `CREATE UNIQUE INDEX` 之後）加：

```js
await query('CREATE INDEX IF NOT EXISTS idx_tu_recorded_at ON token_usage (recorded_at DESC)').catch(() => {});
await query('CREATE INDEX IF NOT EXISTS idx_tu_task_id     ON token_usage (task_id)').catch(() => {});
await query('CREATE INDEX IF NOT EXISTS idx_tu_user_id     ON token_usage (user_id)').catch(() => {});
await query('CREATE INDEX IF NOT EXISTS idx_tu_project_id  ON token_usage (project_id)').catch(() => {});
```

- [ ] **Step 3: 新增 projects 欄位到 colMigrations**

在 `colMigrations` 陣列末尾加：

```js
{ table: 'projects', col: 'odoo_project_name',      sql: 'ALTER TABLE projects ADD COLUMN odoo_project_name TEXT' },
{ table: 'projects', col: 'service_respondent_name', sql: 'ALTER TABLE projects ADD COLUMN service_respondent_name TEXT' },
```

- [ ] **Step 4: 撰寫測試**

開啟 `app/server/tests/db-migration.test.js`，在現有測試後新增：

```js
test('token_usage table exists after migrate', async () => {
  const { rows } = await dbModule.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='token_usage'"
  );
  expect(rows.length).toBe(1);
});

test('projects has odoo_project_name column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects' AND column_name='odoo_project_name'"
  );
  expect(rows.length).toBe(1);
});

test('projects has service_respondent_name column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects' AND column_name='service_respondent_name'"
  );
  expect(rows.length).toBe(1);
});
```

- [ ] **Step 5: 執行測試**

```bash
cd app && npm test -- --testPathPattern=db-migration
```

Expected: 現有測試通過 + 3 個新測試 PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/db.js app/server/tests/db-migration.test.js
git commit -m "feat(db): add token_usage table and project mapping columns"
```

---

## Task 2: token-logger.js + claude-runner.js

**Files:**
- Create: `app/server/pipeline/token-logger.js`
- Modify: `app/server/pipeline/claude-runner.js`
- Test: `app/server/tests/claude-runner.test.js`（新增）

**Interfaces:**
- Produces: `logTokenUsage(ref, userId, agentType, usage, durationMs) → Promise<void>`
- Produces: `callClaude(prompt, signal, opts) → Promise<{ text, usage, durationMs }>`

- [ ] **Step 1: 建立 token-logger.js**

新建 `app/server/pipeline/token-logger.js`：

```js
const { query } = require('../db');

async function logTokenUsage(ref, userId, agentType, usage, durationMs) {
  if (!usage) return;
  try {
    await query(
      `INSERT INTO token_usage
         (task_id, project_id, user_id, agent_type,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          duration_ms, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'server')`,
      [
        ref.taskId    || null,
        ref.projectId || null,
        userId        || null,
        agentType,
        usage.input_tokens                || 0,
        usage.output_tokens               || 0,
        usage.cache_read_input_tokens     || 0,
        usage.cache_creation_input_tokens || 0,
        durationMs || null
      ]
    );
  } catch (err) {
    console.error('[TOKEN-LOGGER]', err.message);
  }
}

module.exports = { logTokenUsage };
```

- [ ] **Step 2: 修改 claude-runner.js — 捕捉 usage**

在 `claude-runner.js` 裡找到：

```js
let resultText = '';
let lineBuffer = '';
let stderr = '';
```

改成：

```js
let resultText = '';
let usage = null;
let durationMs = null;
let lineBuffer = '';
let stderr = '';
```

找到：

```js
if (ev.type === 'result') resultText = ev.result || resultText;
```

改成：

```js
if (ev.type === 'result') {
  resultText  = ev.result       || resultText;
  usage       = ev.usage        || null;
  durationMs  = ev.duration_ms  || null;
}
```

找到：

```js
finish(() => {
  if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
  else resolve(resultText.trim());
});
```

改成：

```js
finish(() => {
  if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
  else resolve({ text: resultText.trim(), usage, durationMs });
});
```

- [ ] **Step 3: 向後相容檢查**

`callClaude()` 現在回傳 `{ text, usage, durationMs }`。所有現有呼叫端直接用 `callClaude(...)` 然後把整個結果當字串用的都會壞掉。

搜尋所有使用 `callClaude` 的地方：
```bash
grep -n "callClaude\|await callClaude" app/server/pipeline/*.js
```

確認所有呼叫端在後續 Task 3 & 4 都會被更新（analysis.js, cs-agent.js, triage.js, merge-agent.js, deploy-fixer.js, library-agent.js, chat-agent.js）。

- [ ] **Step 4: 撰寫 token-logger 測試**

新建 `app/server/tests/claude-runner.test.js`：

```js
const { newDb } = require('pg-mem');

let dbModule, logTokenUsage;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ logTokenUsage } = require('../pipeline/token-logger'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('logTokenUsage inserts a server record', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('tlu1', $1, 'TL') RETURNING id`, [hash]
  );
  await logTokenUsage(
    { taskId: 'task_odoo_1' }, u.id, 'cs',
    { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    1234
  );
  const { rows } = await dbModule.query("SELECT * FROM token_usage WHERE task_id='task_odoo_1'");
  expect(rows.length).toBe(1);
  expect(rows[0].agent_type).toBe('cs');
  expect(rows[0].input_tokens).toBe(100);
  expect(rows[0].output_tokens).toBe(50);
  expect(rows[0].duration_ms).toBe(1234);
  expect(rows[0].source).toBe('server');
});

test('logTokenUsage silently skips when usage is null', async () => {
  await expect(logTokenUsage({ taskId: 'x' }, null, 'cs', null, null)).resolves.toBeUndefined();
});
```

- [ ] **Step 5: 執行測試**

```bash
cd app && npm test -- --testPathPattern=claude-runner
```

Expected: 2 tests PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/token-logger.js app/server/pipeline/claude-runner.js app/server/tests/claude-runner.test.js
git commit -m "feat(pipeline): add token-logger and expose usage from callClaude"
```

---

## Task 3: task-agent.js → stream-json + logTokenUsage

**Files:**
- Modify: `app/server/pipeline/task-agent.js`

**Interfaces:**
- Consumes: `logTokenUsage` from `./token-logger`
- Produces: `runTaskAnalysis(taskId, userId, signal)`, `runTaskCoding(taskId, userId, signal)` — 行為不變，現在額外記錄 token

- [ ] **Step 1: 修改 spawnClaude() 改用 stream-json**

找到 `spawnClaude` 函式裡的 spawn 呼叫：

```js
const child = spawn('claude', ['--print'], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
```

改成：

```js
const child = spawn('claude', ['--print', '--output-format', 'stream-json', '--verbose'], {
  stdio: ['pipe', 'pipe', 'pipe'], cwd
});
```

- [ ] **Step 2: 修改 spawnClaude() 解析 stream-json 並捕捉 usage**

找到現有的 stdout 處理（`child.stdout.on('data', ...)`），整個替換：

```js
let resultText = '';
let usage = null;
let durationMs = null;
let lineBuffer = '';

child.stdout.on('data', d => {
  lineBuffer += d.toString();
  let nl;
  while ((nl = lineBuffer.indexOf('\n')) !== -1) {
    const line = lineBuffer.slice(0, nl).trim();
    lineBuffer = lineBuffer.slice(nl + 1);
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'assistant' && ev.message?.content) {
        let out = '';
        for (const blk of ev.message.content) {
          if (blk.type === 'text') out += blk.text;
        }
        if (out && taskId && userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: out });
      }
      if (ev.type === 'result') {
        resultText = ev.result || resultText;
        usage      = ev.usage       || null;
        durationMs = ev.duration_ms || null;
      }
    } catch {
      if (taskId && userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: line + '\n' });
    }
  }
});
```

找到 `resolve(stdout)` 改成 `resolve({ text: resultText.trim(), usage, durationMs })`。

- [ ] **Step 3: 更新 runTaskAnalysis 解構並記錄 token**

在 `task-agent.js` 頂部引入 token-logger：

```js
const { logTokenUsage } = require('./token-logger');
```

找到 `runTaskAnalysis` 裡：

```js
raw = await spawnClaude(buildAnalysisPrompt(task, info), { cwd: info.local_path, taskId, userId, signal });
```

改成：

```js
const analysisResult = await spawnClaude(buildAnalysisPrompt(task, info), { cwd: info.local_path, taskId, userId, signal });
const raw = analysisResult.text;
await logTokenUsage({ taskId: task.task_id }, userId, 'analysis', analysisResult.usage, analysisResult.durationMs);
```

- [ ] **Step 4: 更新 runTaskCoding 解構並記錄 token**

找到 `runTaskCoding` 裡同樣模式的 `await spawnClaude(buildCodingPrompt(...))` 呼叫，作相同處理（`agent_type` 改用 `'coding'`）：

```js
const codingResult = await spawnClaude(buildCodingPrompt(task, info), { cwd: info.local_path, taskId, userId, signal });
const raw = codingResult.text;
await logTokenUsage({ taskId: task.task_id }, userId, 'coding', codingResult.usage, codingResult.durationMs);
```

如果 `runTaskQa` 也存在，同樣處理（`agent_type: 'qa'`）。

- [ ] **Step 5: 執行現有 task-agent 相關測試**

```bash
cd app && npm test -- --testPathPattern=runner
```

Expected: 所有 runner 測試繼續通過（task-agent 的呼叫在 runner 裡是 async，mock 掉即可）

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/task-agent.js
git commit -m "feat(task-agent): switch to stream-json output and log token usage"
```

---

## Task 4: 所有 callClaude() agent 加入 logTokenUsage

**Files:**
- Modify: `app/server/pipeline/cs-agent.js`
- Modify: `app/server/pipeline/analysis.js`
- Modify: `app/server/pipeline/triage.js`
- Modify: `app/server/pipeline/merge-agent.js`
- Modify: `app/server/pipeline/deploy-fixer.js`
- Modify: `app/server/pipeline/library-agent.js`
- Modify: `app/server/pipeline/chat-agent.js`

**Interfaces:**
- Consumes: `logTokenUsage` from `./token-logger`
- Consumes: `callClaude()` 現在回傳 `{ text, usage, durationMs }`

每個 agent 的修改模式相同：
1. 頂部加 `const { logTokenUsage } = require('./token-logger');`
2. 把 `const text = await callClaude(...)` 改成 `const { text, usage, durationMs } = await callClaude(...)`
3. 在 callClaude 成功後加 `await logTokenUsage(ref, userId, agentType, usage, durationMs)`

- [ ] **Step 1: cs-agent.js**

加引入：
```js
const { logTokenUsage } = require('./token-logger');
```

找到：
```js
const text = await callClaude(prompt, signal, { taskId, userId, notify });
```
改成：
```js
const { text, usage, durationMs } = await callClaude(prompt, signal, { taskId, userId, notify });
await logTokenUsage({ taskId: task.task_id }, task.user_id, 'cs', usage, durationMs);
```

注意：task 是從 DB 查詢出來的（`task.task_id` 是 TEXT 格式如 `task_service_3732`，不是 DB row id）。

- [ ] **Step 2: analysis.js**

加引入：
```js
const { logTokenUsage } = require('./token-logger');
```

找到 `analyzeTask()` 中：
```js
rawYaml = await callClaude(`${ANALYSIS_SYSTEM_PROMPT}\n\n${task.original_text || '（無內容）'}`, signal, { taskId, userId: task.user_id, notify });
```
改成：
```js
const callResult = await callClaude(`${ANALYSIS_SYSTEM_PROMPT}\n\n${task.original_text || '（無內容）'}`, signal, { taskId, userId: task.user_id, notify });
rawYaml = callResult.text;
await logTokenUsage({ taskId: task.task_id }, task.user_id, 'analysis', callResult.usage, callResult.durationMs);
```

- [ ] **Step 3: triage.js**

加引入：
```js
const { logTokenUsage } = require('./token-logger');
```

找到 `triageTask()` 中：
```js
text = await callClaude(`${TRIAGE_SYSTEM_PROMPT}\n\n${task.original_text || '（無內容）'}`);
```

需先查 task 的 task_id、user_id。在 `const { rows } = await query('SELECT original_text FROM tasks WHERE id = $1', [taskId]);` 那行改成：

```js
const { rows } = await query('SELECT original_text, task_id, user_id FROM tasks WHERE id = $1', [taskId]);
```

然後：
```js
const callResult = await callClaude(`${TRIAGE_SYSTEM_PROMPT}\n\n${task.original_text || '（無內容）'}`);
text = callResult.text;
await logTokenUsage({ taskId: task.task_id }, task.user_id, 'triage', callResult.usage, callResult.durationMs);
```

- [ ] **Step 4: merge-agent.js**

在 `resolveConflict()` 裡，`callClaude()` 被呼叫多次（每個衝突檔案一次）。加引入後：

找到 `resolveConflict` 中：
```js
const resolved = await callClaude(
  `以下是有 Git 合併衝突的檔案：...`,
  signal, opts
);
```
改成：
```js
const resolveResult = await callClaude(
  `以下是有 Git 合併衝突的檔案：...`,
  signal, opts
);
const resolved = resolveResult.text;
```

在 `runMergeAgent()` 的主體找到呼叫 `resolveConflict` 的地方，整個 merge 過程完成後（所有衝突解完後），加一次彙總記錄。因為 `resolveConflict` 可能呼叫多次，建議在 `runMergeAgent` 函式頂部累計：

```js
// 在 runMergeAgent 開頭加
const { logTokenUsage } = require('./token-logger');
let mergeUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
```

修改 `resolveConflict` 的簽名接受 accumulator，或改為在 `runMergeAgent` 最後查 `token_usage` 不做 — 為保持改動最小，最簡單做法是在 `resolveConflict` 完成後把 usage 回傳給 `runMergeAgent`，由 `runMergeAgent` 累計後最後 insert 一筆。

**簡化方案**：直接在每次 `callClaude` 成功後各插一筆 token_usage（agent_type='merge'）：

在 `resolveConflict` 接收 callClaude 的地方：
```js
const resolveResult = await callClaude(..., signal, opts);
const resolved = resolveResult.text;
if (resolveResult.usage && opts.taskId) {
  const { logTokenUsage } = require('./token-logger');
  const { rows: [t] } = await require('../db').query('SELECT task_id, user_id FROM tasks WHERE id=$1', [opts.taskId]);
  if (t) await logTokenUsage({ taskId: t.task_id }, t.user_id, 'merge', resolveResult.usage, resolveResult.durationMs);
}
```

- [ ] **Step 5: deploy-fixer.js**

加引入 + 解構：

在 callClaude 呼叫處找到並改為：
```js
const { text: fixResult, usage, durationMs } = await callClaude(prompt, signal, { taskId, userId, notify });
await logTokenUsage({ taskId: dbTask.task_id }, userId, 'deploy_fix', usage, durationMs);
```

（查 `deploy-fixer.js` 確認 task_id 的變數名稱，可能需要先查 DB）

- [ ] **Step 6: library-agent.js**

找到 callClaude 呼叫：
```js
const { text: wikiUpdate, usage, durationMs } = await callClaude(prompt, signal, { taskId, userId, notify });
await logTokenUsage({ taskId: task.task_id }, userId, 'wiki', usage, durationMs);
```

- [ ] **Step 7: chat-agent.js**

chat 沒有 taskId，用 projectId：

加引入：
```js
const { logTokenUsage } = require('./token-logger');
```

`chatReply(projectId, chatId, userMessage)` — 簽名加 `userId`：

```js
async function chatReply(projectId, chatId, userMessage, userId)
```

找到 callClaude：
```js
const reply = (await callClaude(prompt)) || '（無回覆）';
```
改成：
```js
const chatResult = await callClaude(prompt);
const reply = chatResult.text || '（無回覆）';
await logTokenUsage({ projectId }, userId, 'chat', chatResult.usage, chatResult.durationMs);
```

在 `chat-routes.js` 裡更新呼叫：
```js
const reply = await chatReply(req.params.projectId, req.params.id, content, req.userId);
```

- [ ] **Step 8: 執行現有測試，確認沒有壞掉**

```bash
cd app && npm test -- --testPathPattern="cs-agent|analysis|triage|library-agent"
```

Expected: 所有測試 PASS（這些測試 mock 了 callClaude，會需要更新 mock 回傳格式為 `{ text, usage: null, durationMs: null }`）

**更新測試 mock**：每個受影響的 `.test.js` 中，找到：
```js
mockCallClaude.mockResolvedValueOnce('some text');
```
改成：
```js
mockCallClaude.mockResolvedValueOnce({ text: 'some text', usage: null, durationMs: null });
```

- [ ] **Step 9: Commit**

```bash
git add app/server/pipeline/cs-agent.js app/server/pipeline/analysis.js app/server/pipeline/triage.js \
        app/server/pipeline/merge-agent.js app/server/pipeline/deploy-fixer.js \
        app/server/pipeline/library-agent.js app/server/pipeline/chat-agent.js \
        app/server/chat-routes.js app/server/tests/
git commit -m "feat(pipeline): add token usage logging to all server-side agents"
```

---

## Task 5: 移除 coding_cmd / qa_cmd + runner.js 清理

**Files:**
- Delete: `app/server/pipeline/coding-agent.js`
- Delete: `app/server/pipeline/qa-agent.js`
- Modify: `app/server/pipeline/runner.js`
- Modify: `app/public/js/views/Settings.js`
- Delete: `app/server/tests/coding-agent.test.js`
- Delete: `app/server/tests/qa-agent.test.js`

- [ ] **Step 1: 刪除 coding-agent.js 和 qa-agent.js**

```bash
rm app/server/pipeline/coding-agent.js
rm app/server/pipeline/qa-agent.js
rm app/server/tests/coding-agent.test.js
rm app/server/tests/qa-agent.test.js
```

- [ ] **Step 2: 修改 runner.js — coding_running**

找到 `coding_running` 的處理區塊：

```js
if (status === 'coding_running') {
  if (_inFlight.has(taskId)) return;
  const ctrl = new AbortController();
  _inFlight.set(taskId, ctrl);
  try {
    if (task.project_id) {
      const { runTaskCoding } = require('./task-agent');
      const handled = await runTaskCoding(taskId, task.user_id, ctrl.signal);
      if (!handled) {
        const { runCodingAgent } = require('./coding-agent');
        await runCodingAgent(taskId, task.user_id, ctrl.signal);
      }
    } else {
      const { runCodingAgent } = require('./coding-agent');
      await runCodingAgent(taskId, task.user_id, ctrl.signal);
    }
  } finally {
    _inFlight.delete(taskId);
  }
  return;
}
```

整個換成：

```js
if (status === 'coding_running') {
  if (_inFlight.has(taskId)) return;
  const ctrl = new AbortController();
  _inFlight.set(taskId, ctrl);
  try {
    const { runTaskCoding } = require('./task-agent');
    const handled = await runTaskCoding(taskId, task.user_id, ctrl.signal);
    if (!handled) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_content='任務未綁定專案，無法執行開發', updated_at=NOW() WHERE id=$1",
        [taskId]
      );
      notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
    }
  } finally {
    _inFlight.delete(taskId);
  }
  return;
}
```

- [ ] **Step 3: 修改 runner.js — qa_running**

找到 `qa_running` 的處理區塊，整個換成：

```js
if (status === 'qa_running') {
  if (_inFlight.has(taskId)) return;
  const ctrl = new AbortController();
  _inFlight.set(taskId, ctrl);
  try {
    const { runTaskQa } = require('./task-agent');
    if (runTaskQa) {
      const handled = await runTaskQa(taskId, task.user_id, ctrl.signal);
      if (!handled) {
        await query(
          "UPDATE tasks SET status='stopped', blocker_content='任務未綁定專案，無法執行 QA', updated_at=NOW() WHERE id=$1",
          [taskId]
        );
        notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
      }
    }
  } finally {
    _inFlight.delete(taskId);
  }
  return;
}
```

- [ ] **Step 4: 移除 Settings.js 的 coding_cmd / qa_cmd 欄位**

在 `app/public/js/views/Settings.js`：

找到 `pipeline: { deploy_cmd: '', coding_cmd: '', qa_cmd: '' }` 改成：
```js
pipeline: { deploy_cmd: '' }
```

找到讀取設定的地方：
```js
this.pipeline.deploy_cmd  = settings.deploy_cmd  || '';
this.pipeline.coding_cmd  = settings.coding_cmd  || '';
this.pipeline.qa_cmd      = settings.qa_cmd      || '';
```
改成：
```js
this.pipeline.deploy_cmd = settings.deploy_cmd || '';
```

找到儲存設定的地方，移除 `coding_cmd` 和 `qa_cmd` 的欄位（保留 `deploy_cmd`）。

找到 template 裡 `coding_cmd` 和 `qa_cmd` 的 `<input>` 欄位整個移除（包含 label 和 input）。

- [ ] **Step 5: 執行 runner 測試**

```bash
cd app && npm test -- --testPathPattern=runner
```

Expected: PASS（runner.test.js 中若有 mock coding-agent 的部分需移除）

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/runner.js app/public/js/views/Settings.js
git commit -m "feat: remove deprecated coding_cmd/qa_cmd; route coding/qa through task-agent only"
```

---

## Task 6: cron.js JSONL ingest（PS1 路徑 B）+ CLAUDE.md 規則

**Files:**
- Modify: `app/server/cron.js`
- Modify: `.claude/CLAUDE.md`

**Interfaces:**
- Consumes: `kingsmvpsplan/log/token_usage.jsonl` — 每行 `{"task_id","agent_type","tokens","duration_ms","ts"}`
- Produces: `token_usage` 表新增記錄（source='ps1'）

- [ ] **Step 1: 確認 PLAN_DIR 路徑**

在 `cron.js` 裡確認有沒有定義 `PLAN_DIR` 或類似常數。若無，在頂部加：

```js
const fs   = require('fs');
const path = require('path');
const PLAN_DIR = path.join(process.cwd(), '..', 'kingsmvpsplan');
```

（`process.cwd()` 在 `app/` 目錄時是 `C:\odoo-v2\app`，所以 `../kingsmvpsplan` = `C:\odoo-v2\kingsmvpsplan`）

- [ ] **Step 2: 新增 ingestTokenUsageJSONL 函式**

在 `cron.js` 的 `runForUser` 函式之前加：

```js
async function ingestTokenUsageJSONL() {
  const jsonlPath = path.join(PLAN_DIR, 'log', 'token_usage.jsonl');
  if (!fs.existsSync(jsonlPath)) return;
  const raw = fs.readFileSync(jsonlPath, 'utf8').trim();
  if (!raw) return;
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const { task_id, agent_type, tokens, duration_ms, ts } = JSON.parse(line);
      const { rows: [task] } = await query(
        'SELECT user_id FROM tasks WHERE task_id = $1 LIMIT 1', [task_id]
      );
      await query(
        `INSERT INTO token_usage
           (task_id, user_id, agent_type, input_tokens, duration_ms, source, recorded_at)
         VALUES ($1,$2,$3,$4,$5,'ps1',$6)`,
        [task_id, task?.user_id || null, agent_type || 'unknown',
         tokens || 0, duration_ms || null,
         ts ? new Date(ts) : new Date()]
      );
    } catch { /* skip malformed lines */ }
  }
  fs.writeFileSync(jsonlPath, '');
}
```

- [ ] **Step 3: 在 cron tick 呼叫 ingestTokenUsageJSONL**

在 `startCron()` 的 cron tick 函式最開始（try 區塊之前或開頭）加：

```js
await ingestTokenUsageJSONL().catch(err => console.error('[CRON] token ingest:', err.message));
```

- [ ] **Step 4: 新增 CLAUDE.md 規則**

開啟 `C:\odoo-v2\.claude\CLAUDE.md`，在 `## 7. Pipeline` 段落後新增：

```markdown
## 7a. Token 記錄規則

每次 `[CLAUDE-ACTION-REQUIRED]` 所有 agent 完成後，從每個 agent result 的 `<usage>` 區塊提取資料，append 一行到 `kingsmvpsplan/log/token_usage.jsonl`：

```json
{"task_id":"task_odoo_4060","agent_type":"coding","tokens":18474,"duration_ms":2898,"ts":"2026-06-26T12:00:00.000Z"}
```

- `agent_type`：對應 stage（`analysis` / `final` / `coding` / `qa`）
- `tokens`：對應 `subagent_tokens` 數值
- `ts`：ISO 8601 UTC 時間戳（`new Date().toISOString()`）
- 若 agent result 無 `<usage>` 區塊則略過，不寫入
- `log/` 目錄若不存在需先建立
```

- [ ] **Step 5: 建立 log 目錄**

```bash
mkdir -p kingsmvpsplan/log
```

- [ ] **Step 6: Commit**

```bash
git add app/server/cron.js .claude/CLAUDE.md kingsmvpsplan/log/.gitkeep
git commit -m "feat(cron): add JSONL ingest for PS1 pipeline token usage"
```

---

## Task 7: 專案自動綁定 + 刪除串聯 + 新欄位 UI

**Files:**
- Modify: `app/server/pipeline/sync.js`
- Modify: `app/server/project-routes.js`
- Modify: `app/public/js/views/ProjectDetail.js`
- Test: `app/server/tests/sync.test.js`

**Interfaces:**
- Produces: sync 時若 `projects.odoo_project_name` 或 `projects.service_respondent_name` 命中，`tasks.project_id` 自動填入
- Produces: `DELETE /api/projects/:id` 在 transaction 內刪除對應任務
- Produces: `PATCH /api/projects/:id` 接受 `odoo_project_name`、`service_respondent_name`

- [ ] **Step 1: 修改 sync.js — Odoo 任務自動綁定**

在 `syncOdooUser()` 裡找到 insert 任務的那段：

```js
await query(
  `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
   VALUES ($1, $2, 'odoo', $3, $4, 'new')
   ON CONFLICT (user_id, task_id) DO NOTHING`,
  [userId, taskKey, task.name, original_text]
);
added++;
```

改成：

```js
await query(
  `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
   VALUES ($1, $2, 'odoo', $3, $4, 'new')
   ON CONFLICT (user_id, task_id) DO NOTHING`,
  [userId, taskKey, task.name, original_text]
);
added++;

// 自動綁定專案
const odooProjectName = task.project_id ? task.project_id[1] : null;
if (odooProjectName) {
  const { rows: [proj] } = await query(
    'SELECT id FROM projects WHERE odoo_project_name = $1 LIMIT 1',
    [odooProjectName]
  );
  if (proj) {
    await query(
      'UPDATE tasks SET project_id = $1 WHERE user_id = $2 AND task_id = $3 AND project_id IS NULL',
      [proj.id, userId, taskKey]
    );
  }
}
```

- [ ] **Step 2: 修改 sync.js — Service 任務自動綁定**

在 `syncServiceUser()` 的 insert 後同樣加：

```js
const respondentName = task.respondent ? task.respondent[1] : null;
if (respondentName) {
  const { rows: [proj] } = await query(
    'SELECT id FROM projects WHERE service_respondent_name = $1 LIMIT 1',
    [respondentName]
  );
  if (proj) {
    await query(
      'UPDATE tasks SET project_id = $1 WHERE user_id = $2 AND task_id = $3 AND project_id IS NULL',
      [proj.id, userId, taskKey]
    );
  }
}
```

- [ ] **Step 3: 修改 project-routes.js — DELETE 串聯刪除**

找到 `app.delete('/api/projects/:id', ...)` 的處理函式：

```js
app.delete('/api/projects/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    // ... 現有程式碼
  } catch (err) { ... }
});
```

在刪除 project 之前加 transaction：

```js
app.delete('/api/projects/:id', verifyToken, requireAdmin, async (req, res) => {
  const client = await require('./db').getPool().connect();
  try {
    await client.query('BEGIN');
    // 取得專案底下的所有 task DB id
    const { rows: taskRows } = await client.query(
      'SELECT id FROM tasks WHERE project_id = $1', [req.params.id]
    );
    if (taskRows.length) {
      const taskIds = taskRows.map(r => r.id);
      await client.query(
        `DELETE FROM task_logs WHERE task_id = ANY($1::int[])`, [taskIds]
      );
      await client.query(
        `DELETE FROM token_usage WHERE task_id IN (SELECT task_id FROM tasks WHERE project_id = $1)`,
        [req.params.id]
      );
      await client.query('DELETE FROM tasks WHERE project_id = $1', [req.params.id]);
    }
    // 原有刪除 project 邏輯（wiki_pages, project_repos, project_chats, odoo_envs 已有 ON DELETE CASCADE）
    const { rows } = await client.query(
      'DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
```

- [ ] **Step 4: 修改 project-routes.js — PATCH 接受新欄位**

找到 `app.patch('/api/projects/:id', ...)` 或 `app.put('/api/projects/:id', ...)`，在解構 body 時加上新欄位：

```js
const { name, odoo_version, description, folder_name, odoo_project_name, service_respondent_name } = req.body;
```

並在 UPDATE SQL 加入：

```sql
odoo_project_name       = COALESCE($N, odoo_project_name),
service_respondent_name = COALESCE($M, service_respondent_name),
```

- [ ] **Step 5: 修改 ProjectDetail.js — 新增兩個欄位**

在 ProjectDetail 的 `data()` 裡加：

```js
editOdooProjectName:      '',
editServiceRespondentName: '',
```

在 `loadProject()` 後設值：

```js
this.editOdooProjectName       = this.project.odoo_project_name      || '';
this.editServiceRespondentName = this.project.service_respondent_name || '';
```

新增儲存方法：

```js
async saveProjectMapping() {
  try {
    await Api.patch(`projects/${this.project.id}`, {
      odoo_project_name:       this.editOdooProjectName      || null,
      service_respondent_name: this.editServiceRespondentName || null
    });
    showToast('專案對應已儲存', 'success');
    await this.loadProject();
  } catch (err) { showToast(err.message, 'error'); }
},
```

在 template 的設定區塊加入：

```html
<div style="margin-top:16px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:6px">
  <h3 style="font-size:14px;font-weight:600;margin-bottom:8px">同步來源對應</h3>
  <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
    <label>Odoo 專案名稱（同步時自動綁定）
      <input v-model="editOdooProjectName" class="form-control" placeholder="與 Odoo ERP 的專案名稱完全一致" style="margin-top:4px" />
    </label>
    <label>客服來源名稱（Service 同步時自動綁定）
      <input v-model="editServiceRespondentName" class="form-control" placeholder="與 eService 的 respondent 名稱完全一致" style="margin-top:4px" />
    </label>
    <button class="btn btn-primary btn-sm" @click="saveProjectMapping" style="align-self:flex-start">儲存對應</button>
  </div>
</div>
```

- [ ] **Step 6: 執行 sync 測試**

```bash
cd app && npm test -- --testPathPattern=sync
```

Expected: PASS

- [ ] **Step 7: 執行 project-routes 測試**

```bash
cd app && npm test -- --testPathPattern=project-routes
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add app/server/pipeline/sync.js app/server/project-routes.js app/public/js/views/ProjectDetail.js
git commit -m "feat: auto-bind project_id on sync and cascade delete tasks with project"
```

---

## Task 8: tasks-routes.js + TaskList.js UI 強化

**Files:**
- Modify: `app/server/tasks-routes.js`
- Modify: `app/public/js/views/TaskList.js`
- Test: `app/server/tests/tasks-routes.test.js`

**Interfaces:**
- Produces: `GET /api/tasks` 回傳每筆 task 含 `project_name`（可 null）、`project_id`
- Produces: TaskList.js — source badge 化 + 專案 tag（點擊導向 `/projects/:id`）+ 搜尋含 project_name

- [ ] **Step 1: 修改 tasks-routes.js — LEFT JOIN projects**

找到 `GET /api/tasks` 的 SQL：

```js
const sql = `SELECT t.id, t.task_id, t.source, t.title, t.status, t.is_paused, t.project_id, t.git_branch, t.reentry_count, t.created_at, t.updated_at,
                    e.url AS env_url
             FROM tasks t
             LEFT JOIN odoo_envs e ON e.project_id = t.project_id AND e.status = 'running'
             WHERE t.${conditions.join(' AND t.')} ORDER BY t.updated_at DESC`;
```

改成：

```js
const sql = `SELECT t.id, t.task_id, t.source, t.title, t.status, t.is_paused, t.project_id, t.git_branch, t.reentry_count, t.created_at, t.updated_at,
                    e.url AS env_url,
                    p.name AS project_name
             FROM tasks t
             LEFT JOIN odoo_envs e ON e.project_id = t.project_id AND e.status = 'running'
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.${conditions.join(' AND t.')} ORDER BY t.updated_at DESC`;
```

- [ ] **Step 2: 修改 TaskList.js — 來源 badge 化**

找到 template 裡的 `task-source` div：

```html
<div class="task-source" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
  <a v-if="sourceUrl(t)" :href="sourceUrl(t)" target="_blank" @click.stop
     style="color:var(--primary);text-decoration:none;font-weight:500">{{ sourceLabel(t.source) }}</a>
  <span v-else>{{ sourceLabel(t.source) }}</span>
  <a v-if="t.env_url" ...>🖥 測試機</a>
</div>
```

改成：

```html
<div class="task-source" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
  <a v-if="sourceUrl(t)" :href="sourceUrl(t)" target="_blank" @click.stop
     :style="sourceBadgeStyle(t.source)">{{ sourceLabel(t.source) }}</a>
  <span v-else :style="sourceBadgeStyle(t.source)">{{ sourceLabel(t.source) }}</span>
  <span v-if="t.project_id && t.project_name"
        @click.stop="$router.push('/projects/' + t.project_id)"
        style="font-size:11px;padding:2px 8px;border-radius:10px;background:#e0f2fe;color:#0369a1;cursor:pointer;border:1px solid #bae6fd;font-weight:500">
    {{ t.project_name }}
  </span>
  <a v-if="t.env_url" :href="t.env_url" target="_blank" @click.stop
     style="font-size:11px;padding:1px 8px;border:1px solid var(--border-strong);border-radius:4px;color:var(--text-secondary);text-decoration:none;background:#fff">
    🖥 測試機
  </a>
</div>
```

在 `methods` 加入：

```js
sourceBadgeStyle(source) {
  const base = 'font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;text-decoration:none;';
  if (source === 'odoo')    return base + 'background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe;';
  if (source === 'service') return base + 'background:#f3e8ff;color:#7c3aed;border:1px solid #e9d5ff;';
  return base + 'background:var(--surface);color:var(--text-secondary);border:1px solid var(--border);';
},
```

- [ ] **Step 3: 修改 TaskList.js — 搜尋加入 project_name**

找到 `filteredTasks` computed 裡：

```js
return list.filter(t =>
  (t.title || '').toLowerCase().includes(q) ||
  (t.task_id || '').toLowerCase().includes(q) ||
  (t.source || '').toLowerCase().includes(q) ||
  (t.module || '').toLowerCase().includes(q)
);
```

改成：

```js
return list.filter(t =>
  (t.title || '').toLowerCase().includes(q) ||
  (t.task_id || '').toLowerCase().includes(q) ||
  (t.source || '').toLowerCase().includes(q) ||
  (t.module || '').toLowerCase().includes(q) ||
  (t.project_name || '').toLowerCase().includes(q)
);
```

- [ ] **Step 4: 執行 tasks-routes 測試**

```bash
cd app && npm test -- --testPathPattern=tasks-routes
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/tasks-routes.js app/public/js/views/TaskList.js
git commit -m "feat(tasks): add project_name to task list and source badge UI"
```

---

## Task 9: Token 報表 API

**Files:**
- Create: `app/server/token-report-routes.js`
- Modify: `app/server/index.js`
- Test: `app/server/tests/token-report-routes.test.js`（新增）

**Interfaces:**
- Produces: `GET /api/token-report?start&end&project_id&task_id&all` → JSON（見 spec）

- [ ] **Step 1: 建立 token-report-routes.js**

新建 `app/server/token-report-routes.js`：

```js
const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  app.get('/api/token-report', verifyToken, async (req, res) => {
    try {
      const isAdmin = req.userRole === 'admin';
      const showAll = isAdmin && req.query.all === 'true';

      const now = new Date();
      const defaultStart = new Date(now);
      defaultStart.setDate(defaultStart.getDate() - 30);

      const start     = req.query.start    ? new Date(req.query.start) : defaultStart;
      const end       = req.query.end      ? new Date(req.query.end)   : now;
      const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
      const taskId    = req.query.task_id   || null;

      // Base filter
      const baseConditions = ['tu.recorded_at >= $1', 'tu.recorded_at <= $2'];
      const baseParams = [start, end];

      if (!showAll) {
        baseConditions.push(`tu.user_id = $${baseParams.length + 1}`);
        baseParams.push(req.userId);
      }
      if (projectId) {
        // match either direct project_id or via task's project_id
        baseConditions.push(
          `(tu.project_id = $${baseParams.length + 1} OR EXISTS(SELECT 1 FROM tasks t2 WHERE t2.task_id = tu.task_id AND t2.project_id = $${baseParams.length + 1}))`
        );
        baseParams.push(projectId);
      }
      if (taskId) {
        baseConditions.push(`tu.task_id = $${baseParams.length + 1}`);
        baseParams.push(taskId);
      }

      const where = 'WHERE ' + baseConditions.join(' AND ');

      // Summary
      const { rows: [summary] } = await query(
        `SELECT
           COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens), 0) AS total_tokens,
           COUNT(DISTINCT COALESCE(tu.task_id, tu.project_id::TEXT)) AS total_refs,
           COUNT(*) AS total_records
         FROM token_usage tu
         ${where}`,
        baseParams
      );

      // By agent
      const { rows: byAgent } = await query(
        `SELECT agent_type,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens
         FROM token_usage tu
         ${where}
         GROUP BY agent_type ORDER BY tokens DESC`,
        baseParams
      );

      // By project (join tasks to get project)
      const { rows: byProject } = await query(
        `SELECT p.id AS project_id, p.name AS project_name,
           SUM(tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens) AS tokens
         FROM token_usage tu
         LEFT JOIN tasks t ON t.task_id = tu.task_id
         LEFT JOIN projects p ON p.id = COALESCE(tu.project_id, t.project_id)
         ${where}
         GROUP BY p.id, p.name ORDER BY tokens DESC`,
        baseParams
      );

      // Daily trend
      const { rows: daily } = await query(
        `SELECT DATE(recorded_at AT TIME ZONE 'Asia/Taipei') AS date,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens
         FROM token_usage tu
         ${where}
         GROUP BY date ORDER BY date ASC`,
        baseParams
      );

      // Task detail
      const { rows: taskDetail } = await query(
        `SELECT
           tu.task_id,
           t.title,
           p.name AS project_name,
           p.id   AS project_id,
           COALESCE(u.display_name, u.username) AS username,
           tu.user_id,
           tu.agent_type,
           tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens AS tokens,
           tu.duration_ms,
           tu.recorded_at
         FROM token_usage tu
         LEFT JOIN tasks t ON t.task_id = tu.task_id
         LEFT JOIN projects p ON p.id = COALESCE(tu.project_id, t.project_id)
         LEFT JOIN users u ON u.id = tu.user_id
         ${where}
         ORDER BY tu.recorded_at DESC
         LIMIT 500`,
        baseParams
      );

      // Group task detail by task_id
      const taskMap = {};
      for (const row of taskDetail) {
        const key = row.task_id || `_chat_${row.project_id}`;
        if (!taskMap[key]) {
          taskMap[key] = {
            task_id:        row.task_id,
            title:          row.title,
            project_id:     row.project_id,
            project_name:   row.project_name,
            user_id:        row.user_id,
            username:       row.username,
            total_tokens:   0,
            agents:         [],
            last_recorded_at: row.recorded_at
          };
        }
        taskMap[key].total_tokens += Number(row.tokens) || 0;
        taskMap[key].agents.push({
          agent_type:  row.agent_type,
          tokens:      Number(row.tokens) || 0,
          duration_ms: row.duration_ms
        });
        if (new Date(row.recorded_at) > new Date(taskMap[key].last_recorded_at)) {
          taskMap[key].last_recorded_at = row.recorded_at;
        }
      }

      const totalTokens = Number(summary.total_tokens) || 0;
      const totalTasks  = Object.keys(taskMap).length;

      res.json({
        summary: {
          total_tokens:        totalTokens,
          total_tasks:         totalTasks,
          avg_tokens_per_task: totalTasks ? Math.round(totalTokens / totalTasks) : 0
        },
        by_agent:   byAgent.map(r => ({ agent_type: r.agent_type, tokens: Number(r.tokens) })),
        by_project: byProject.filter(r => r.project_name).map(r => ({
          project_id:   r.project_id,
          project_name: r.project_name,
          tokens:       Number(r.tokens)
        })),
        daily: daily.map(r => ({ date: r.date, tokens: Number(r.tokens) })),
        tasks: Object.values(taskMap)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
```

**注意**：`req.userRole` 需確認 `verifyToken` middleware 有設定此欄位。若無，查 `auth.js` 確認欄位名（可能是 `req.role`）並調整。

- [ ] **Step 2: 修改 index.js 註冊路由**

在 `app/server/index.js` 頂部 require 區加：

```js
const { registerRoutes: registerTokenReportRoutes } = require('./token-report-routes');
```

在現有 `registerXxxRoutes(app)` 呼叫的最後加：

```js
registerTokenReportRoutes(app);
```

- [ ] **Step 3: 確認 req.userRole 可用**

```bash
grep -n "req.userId\|req.role\|req.userRole" app/server/auth.js | head -20
```

若 middleware 只設 `req.userId`，需在 token-report-routes.js 改用：

```js
const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
const isAdmin = me?.role === 'admin';
```

- [ ] **Step 4: 撰寫 API 測試**

新建 `app/server/tests/token-report-routes.test.js`：

```js
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');

let dbModule, app;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  // Insert test data
  const bcrypt = require('bcryptjs');
  const h = await bcrypt.hash('pw', 4);
  const { rows: [u] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('tr1', $1, 'TR') RETURNING id`, [h]
  );
  await dbModule.query(
    `INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, source)
     VALUES ('task_odoo_1', $1, 'cs', 100, 50, 'server')`, [u.id]
  );

  app = express();
  app.use(express.json());
  // Mock verifyToken
  app.use((req, _res, next) => { req.userId = u.id; next(); });
  const { registerRoutes } = require('../token-report-routes');
  registerRoutes(app);
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/token-report returns summary with tokens', async () => {
  const res = await request(app).get('/api/token-report');
  expect(res.status).toBe(200);
  expect(res.body.summary.total_tokens).toBeGreaterThan(0);
  expect(Array.isArray(res.body.by_agent)).toBe(true);
  expect(Array.isArray(res.body.tasks)).toBe(true);
});
```

- [ ] **Step 5: 執行測試**

```bash
cd app && npm test -- --testPathPattern=token-report
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/token-report-routes.js app/server/index.js app/server/tests/token-report-routes.test.js
git commit -m "feat(api): add GET /api/token-report endpoint"
```

---

## Task 10: TokenReport.js 前端 + 路由

**Files:**
- Create: `app/public/js/views/TokenReport.js`
- Modify: `app/public/index.html`
- Modify: `app/public/js/app.js`

**Interfaces:**
- Consumes: `GET /api/token-report` → `{ summary, by_agent, by_project, daily, tasks }`
- Consumes: `GET /api/projects` → `[{ id, name }]`（專案下拉用）

- [ ] **Step 1: 確認 index.html 載入順序**

```bash
grep -n "views/\|TokenReport\|app.js" app/public/index.html
```

找到現有 views script tags，確認加入 TokenReport.js 的位置（在最後一個 view 後、app.js 前）。

- [ ] **Step 2: 新建 TokenReport.js**

新建 `app/public/js/views/TokenReport.js`（完整內容）：

```js
window.TokenReportView = Vue.defineComponent({
  name: 'TokenReportView',
  data() {
    return {
      loading: false,
      report: null,
      projects: [],
      filters: {
        range: '30',     // '7' | '30' | 'custom'
        start: '',
        end: '',
        project_id: '',
        task_id: ''
      },
      expandedTasks: {}
    };
  },
  computed: {
    dateRange() {
      const now = new Date();
      const end = now.toISOString().slice(0, 10);
      if (this.filters.range === '7') {
        const s = new Date(now); s.setDate(s.getDate() - 7);
        return { start: s.toISOString().slice(0, 10), end };
      }
      if (this.filters.range === '30') {
        const s = new Date(now); s.setDate(s.getDate() - 30);
        return { start: s.toISOString().slice(0, 10), end };
      }
      return { start: this.filters.start, end: this.filters.end };
    }
  },
  async created() {
    this.projects = await Api.get('projects').catch(() => []);
    await this.load();
  },
  methods: {
    async load() {
      this.loading = true;
      try {
        const p = new URLSearchParams();
        const { start, end } = this.dateRange;
        if (start) p.set('start', start);
        if (end)   p.set('end', end);
        if (this.filters.project_id) p.set('project_id', this.filters.project_id);
        if (this.filters.task_id)    p.set('task_id', this.filters.task_id);
        this.report = await Api.get(`token-report?${p.toString()}`);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    fmtNum(n) { return Number(n || 0).toLocaleString(); },
    toggleTask(key) {
      this.expandedTasks[key] = !this.expandedTasks[key];
    },
    agentColor(type) {
      const map = { cs: '#7c3aed', triage: '#6b7280', analysis: '#2563eb', coding: '#059669',
                    qa: '#d97706', merge: '#db2777', deploy_fix: '#dc2626', wiki: '#0891b2', chat: '#f59e0b' };
      return map[type] || '#6b7280';
    },
    // SVG pie chart
    piePath(slices) {
      const total = slices.reduce((s, r) => s + r.value, 0);
      if (!total) return [];
      let angle = -Math.PI / 2;
      return slices.map(s => {
        const frac = s.value / total;
        const a0 = angle;
        angle += frac * 2 * Math.PI;
        const a1 = angle;
        const r = 70;
        const cx = 90, cy = 90;
        const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
        const large = frac > 0.5 ? 1 : 0;
        return { ...s, frac, d: `M${cx},${cy} L${x0},${y0} A${r},${r},0,${large},1,${x1},${y1}Z` };
      });
    },
    // SVG line chart
    linePoints(daily) {
      if (!daily?.length) return '';
      const maxV = Math.max(...daily.map(d => d.tokens), 1);
      const w = 400, h = 120, pad = 20;
      return daily.map((d, i) => {
        const x = pad + (i / Math.max(daily.length - 1, 1)) * (w - 2 * pad);
        const y = h - pad - (d.tokens / maxV) * (h - 2 * pad);
        return `${x},${y}`;
      }).join(' ');
    }
  },
  template: `
    <div class="topbar"><h1>用量報表</h1></div>
    <div class="content">

      <!-- 篩選列 -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
        <select v-model="filters.range" class="form-control" style="width:100px;font-size:13px;height:32px;padding:4px 8px">
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="custom">自訂</option>
        </select>
        <template v-if="filters.range==='custom'">
          <input v-model="filters.start" type="date" class="form-control" style="width:140px;font-size:13px;height:32px;padding:4px 8px" />
          <span style="font-size:13px;color:var(--text-muted)">至</span>
          <input v-model="filters.end" type="date" class="form-control" style="width:140px;font-size:13px;height:32px;padding:4px 8px" />
        </template>
        <select v-model="filters.project_id" class="form-control" style="width:160px;font-size:13px;height:32px;padding:4px 8px">
          <option value="">全部專案</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <input v-model="filters.task_id" placeholder="任務 ID" class="form-control"
          style="width:160px;font-size:13px;height:32px;padding:4px 8px" />
        <button class="btn btn-primary btn-sm" @click="load" :disabled="loading">
          {{ loading ? '查詢中...' : '查詢' }}
        </button>
      </div>

      <div v-if="loading" class="loading">載入中...</div>
      <template v-else-if="report">

        <!-- 摘要卡片 -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--primary)">{{ fmtNum(report.summary.total_tokens) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">總 Token 數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--success)">{{ fmtNum(report.summary.total_tasks) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">任務數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--warning)">{{ fmtNum(report.summary.avg_tokens_per_task) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">平均每任務</div>
          </div>
        </div>

        <!-- 圖表區 -->
        <div style="display:grid;grid-template-columns:180px 180px 1fr;gap:16px;margin-bottom:20px">

          <!-- Agent 圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">Agent 類型</div>
            <svg width="180" height="180" v-if="report.by_agent.length">
              <path v-for="s in piePath(report.by_agent.map(r=>({value:r.tokens,color:agentColor(r.agent_type),label:r.agent_type})))"
                :key="s.label" :d="s.d" :fill="s.color" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}</title>
              </path>
            </svg>
            <div v-for="r in report.by_agent" :key="r.agent_type"
              style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:agentColor(r.agent_type),display:'inline-block'}"></span>
              {{ r.agent_type }}: {{ fmtNum(r.tokens) }}
            </div>
          </div>

          <!-- 專案圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">專案分布</div>
            <svg width="180" height="180" v-if="report.by_project.length">
              <path v-for="(s,i) in piePath(report.by_project.map(r=>({value:r.tokens,color:'hsl('+(i*60)+',60%,50%)',label:r.project_name})))"
                :key="s.label" :d="s.d" :fill="s.color" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}</title>
              </path>
            </svg>
            <div v-for="(r,i) in report.by_project" :key="r.project_id"
              style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:'hsl('+(i*60)+',60%,50%)',display:'inline-block'}"></span>
              {{ r.project_name }}: {{ fmtNum(r.tokens) }}
            </div>
          </div>

          <!-- 折線圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">每日趨勢</div>
            <svg width="400" height="120" v-if="report.daily.length > 1">
              <polyline :points="linePoints(report.daily)"
                fill="none" stroke="var(--primary)" stroke-width="2" />
              <circle v-for="(d,i) in report.daily" :key="d.date"
                :cx="20 + (i/Math.max(report.daily.length-1,1))*360"
                :cy="120 - 20 - (d.tokens/Math.max(...report.daily.map(x=>x.tokens),1))*80"
                r="3" fill="var(--primary)">
                <title>{{ d.date }}: {{ fmtNum(d.tokens) }}</title>
              </circle>
            </svg>
            <div v-else style="font-size:12px;color:var(--text-muted);padding:20px 0;text-align:center">資料不足</div>
          </div>
        </div>

        <!-- 明細表 -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:var(--border);font-weight:600;font-size:12px">
                <th style="padding:8px 12px;text-align:left">任務</th>
                <th style="padding:8px 12px;text-align:left">專案</th>
                <th style="padding:8px 12px;text-align:left">用戶</th>
                <th style="padding:8px 12px;text-align:right">Token 數</th>
                <th style="padding:8px 12px;text-align:left">記錄時間</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="t in report.tasks" :key="t.task_id || t.project_id">
                <tr style="border-top:1px solid var(--border);cursor:pointer"
                  @click="toggleTask(t.task_id || t.project_id)">
                  <td style="padding:8px 12px">
                    <span style="margin-right:6px;color:var(--text-muted)">
                      {{ expandedTasks[t.task_id || t.project_id] ? '▾' : '▸' }}
                    </span>
                    {{ t.title || t.task_id || '（無標題）' }}
                  </td>
                  <td style="padding:8px 12px;color:var(--text-muted)">{{ t.project_name || '—' }}</td>
                  <td style="padding:8px 12px;color:var(--text-muted)">{{ t.username || '—' }}</td>
                  <td style="padding:8px 12px;text-align:right;font-weight:600">{{ fmtNum(t.total_tokens) }}</td>
                  <td style="padding:8px 12px;color:var(--text-muted);font-size:11px">
                    {{ new Date(t.last_recorded_at).toLocaleString('zh-TW') }}
                  </td>
                </tr>
                <tr v-if="expandedTasks[t.task_id || t.project_id]"
                  style="background:#f8fafc">
                  <td colspan="5" style="padding:4px 12px 8px 32px">
                    <div v-for="a in t.agents" :key="a.agent_type"
                      style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary)">
                      <span :style="{width:'8px',height:'8px',borderRadius:'50%',background:agentColor(a.agent_type),display:'inline-block'}"></span>
                      {{ a.agent_type }}: {{ fmtNum(a.tokens) }}
                      <span v-if="a.duration_ms" style="color:var(--text-muted)">({{ (a.duration_ms/1000).toFixed(1) }}s)</span>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-if="!report.tasks.length" style="text-align:center;padding:32px;color:var(--text-muted)">
            本期間無 Token 使用記錄
          </div>
        </div>

      </template>
    </div>
  `
});
```

- [ ] **Step 3: 修改 index.html**

找到 views script tags 的最後一行（例如 `<script src="/js/views/WikiView.js"></script>`），在它之後、`app.js` 之前加：

```html
<script src="/js/views/TokenReport.js"></script>
```

- [ ] **Step 4: 修改 app.js — 路由**

在 `routes` 陣列，`/settings` 之前加：

```js
{ path: '/token-report', component: window.TokenReportView, meta: { requiresAuth: true } },
```

在 sidebar nav 的 `⚙️ 設定` 連結之前加：

```html
<router-link to="/token-report" custom v-slot="{ navigate, isActive }">
  <a :class="{ active: isActive }" @click="navigate">📊 用量報表</a>
</router-link>
```

- [ ] **Step 5: 手動驗證**

啟動伺服器：
```bash
cd app && node server/index.js
```

1. 登入後點擊 sidebar「📊 用量報表」
2. 確認頁面載入、卡片顯示 0（正常，還沒有資料）
3. 確認篩選下拉有專案列表
4. Console 無 JS error

- [ ] **Step 6: Commit**

```bash
git add app/public/js/views/TokenReport.js app/public/index.html app/public/js/app.js
git commit -m "feat(frontend): add token report view with SVG charts"
```

---

## Self-Review

**Spec coverage check:**
- ✅ DB Schema (Task 1)
- ✅ token-logger.js + claude-runner.js (Task 2)
- ✅ task-agent.js stream-json (Task 3)
- ✅ All callClaude agents (Task 4) — triage 需從 DB 多取 task_id/user_id
- ✅ Remove coding_cmd/qa_cmd (Task 5)
- ✅ cron.js JSONL ingest + CLAUDE.md (Task 6)
- ✅ Auto project binding (Task 7)
- ✅ Cascade delete (Task 7)
- ✅ ProjectDetail.js new fields (Task 7)
- ✅ TaskList.js badges + tags + search (Task 8)
- ✅ tasks-routes.js JOIN (Task 8)
- ✅ token-report API (Task 9)
- ✅ TokenReport.js + routing (Task 10)

**Known edge cases to watch:**
- Task 4 Step 7: `chat-agent.js` 的 `chatReply()` 需加 `userId` 參數，`chat-routes.js` 呼叫端也需更新
- Task 4 Step 4: `merge-agent.js` 的 resolveConflict 呼叫模式較複雜，注意 opts.taskId 的傳遞
- Task 9: `req.userRole` 需確認 auth middleware 的實際欄位名稱
- Task 5 Step 3: 確認 `task-agent.js` 是否有 `runTaskQa` 函式（若無則 runner.js 的 qa_running 直接設 stopped）
