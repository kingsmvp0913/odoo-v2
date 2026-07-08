# 工作流程健檢 agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** admin 一鍵對每個 pipeline agent 跨全平台聚合近 30 天訊號，用 opus 出「診斷＋建議 prompt」，建議經人工帶入既有 agent 編輯器審後才生效。

**Architecture:** 後端 `health-data.js`（SQL 聚合成精簡摘要）→ `workflow-health.md`（opus agent、`<result>` JSON 契約）→ `health-check-runner.js`（fire-and-forget 遍歷 agents、落 findings）；`admin-routes.js` 加 3 個 admin 路由＋2 張表。前端新增 `AdminHealthCheck.js` 頁，findings 的建議 prompt 走「帶入編輯器」預填到既有 `AdminAgents.js`，經 `updateAgent` 契約校驗才寫檔。

**Tech Stack:** Node + Express + pg（pg-mem 測試）、既有 pipeline 工具（`runClaude`／`parseAgentResult`／`logTokenUsage`／`agent-loader`）、前端 Vue 3 global（`window.*View` + `Api`）。

## Global Constraints

- 前端配色一律走 `app.css` CSS 變數／dark-aware（`var(--text)`/`var(--surface)`/`var(--error)` 等）；禁寫死淺色底而不寫死文字色。
- agent `.md` frontmatter 欄位：`name/role/label/description/model/stage`；body 動態資料用 `{{placeholder}}`；輸出契約包在 `<result></result>`。
- admin 路由守衛＝ `const auth = [verifyToken, requireAdmin]`；未帶 token → 401、非 admin → 403。`req.userId` 為登入者 id。
- token 記帳一律 `logTokenUsage(ref, userId, agentType, usage, durationMs)`／失敗 `logFailedUsage(ref, userId, agentType, err)`；本專案 agentType＝`'workflow_health'`。
- `ALLOWED_MODELS = ['haiku','sonnet','opus','fable']`。
- 測試用 pg-mem：`dbModule._setPoolForTesting(new Pool())` → `migrate()`；`runClaude` mock 回 `{ text, usage, durationMs }`。
- `parseAgentResult(text, { parse: JSON.parse })` 解析失敗回 **null**（內部會再打一次 `runClaude` 做 haiku 補救，測試需一併 mock）。
- 禁寫死絕對路徑；只 commit 本專案相關檔（working tree 有平行工作，勿 `git add -A`）。

---

## File Structure

- Create `app/server/pipeline/health-data.js` — `buildAgentSummary(agent, opts)` SQL 聚合。
- Create `.claude/agents/workflow-health.md` — opus 健檢 agent。
- Create `app/server/pipeline/health-check-runner.js` — `runHealthCheck(runId, opts)` 遍歷 + 落 findings。
- Modify `app/server/db.js` — 新增 `health_check_runs`／`health_check_findings` 兩表 + 索引。
- Modify `app/server/admin-routes.js` — 3 個 `/api/admin/health-check` 路由。
- Create `app/public/js/views/AdminHealthCheck.js` — 健檢頁。
- Modify `app/public/index.html` — 掛 view script。
- Modify `app/public/js/app.js` — 加路由。
- Modify `app/public/js/views/Admin.js` — 加導覽卡片。
- Modify `app/public/js/views/AdminAgents.js` — 支援「帶入編輯器」預填。
- Modify `app/public/js/views/TokenReport.js` — `workflow_health` 配色。
- Tests: `app/server/tests/health-data.test.js`、`workflow-health-agent.test.js`、`health-check-runner.test.js`、`admin-health-check-routes.test.js`。

---

## Task 1: 資料表 migrate

**Files:**
- Modify: `app/server/db.js`（`CREATE TABLE` 陣列尾端、索引區）
- Test: `app/server/tests/health-data.test.js`（本任務先建檔，只驗表存在）

**Interfaces:**
- Produces: 表 `health_check_runs(id, status, window_days, started_by, created_at, finished_at)`、`health_check_findings(id, run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale, created_at)`。

- [ ] **Step 1: 寫失敗測試** — 建 `app/server/tests/health-data.test.js`：

```javascript
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app/server && npx jest tests/health-data.test.js`
Expected: FAIL（`relation "health_check_runs" does not exist`）

- [ ] **Step 3: 在 `db.js` 的 `CREATE TABLE` 陣列尾端（`rejection_items` 之後、`];` 之前）加兩表**

```javascript
    // 工作流程健檢 agent（子專案 2）：admin 一鍵健檢的一次執行＋每 agent 診斷 finding。
    `CREATE TABLE IF NOT EXISTS health_check_runs (
      id           SERIAL PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'running',   -- running | done | error
      window_days  INTEGER NOT NULL DEFAULT 30,
      started_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at  TIMESTAMPTZ
    )`,

    `CREATE TABLE IF NOT EXISTS health_check_findings (
      id                SERIAL PRIMARY KEY,
      run_id            INTEGER NOT NULL REFERENCES health_check_runs(id) ON DELETE CASCADE,
      agent_name        TEXT NOT NULL,
      agent_label       TEXT,
      diagnosis         TEXT NOT NULL,
      severity          TEXT NOT NULL,                -- ok | low | medium | high | error
      suggested_prompt  TEXT,
      rationale         TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
```

- [ ] **Step 4: 在索引區（`idx_rej_items_rid` 那一批附近）加索引**

```javascript
  await query('CREATE INDEX IF NOT EXISTS idx_hcf_run ON health_check_findings (run_id)').catch(() => {});
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app/server && npx jest tests/health-data.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/db.js app/server/tests/health-data.test.js
git commit -m "[HealthCheck] 健檢兩表 migrate（health_check_runs / findings）"
```

---

## Task 2: 資料聚合層 `health-data.js`

**Files:**
- Create: `app/server/pipeline/health-data.js`
- Test: `app/server/tests/health-data.test.js`（沿用 Task 1 檔案，追加 case）

**Interfaces:**
- Consumes: `require('../db').query`。`agent` 參數 = `{ name, stage, label }`（`listAgents()` 的一筆）。
- Produces: `buildAgentSummary(agent, { windowDays = 30 }) → Promise<{ agent, stage, window_days, token, tasks, rejections }>`
  - `token`: `{ calls, input_tokens, output_tokens, avg_duration_ms, cache_hit_rate, failed_calls }`
  - `tasks`: `{ total, stopped_rate, reentry: { min, max, avg }, blocker_samples: string[] }`
  - `rejections`: `{ by_category: {cat:n}, samples: string[] } | null`（僅 stage∈{coding,analysis} 時非 null）

> 註：實作時捨棄 spec 提及的 `task_events` 片段——該表存的是「整段終端串流」非「失敗片段」，抽樣噪音大且燒 token；失敗訊號改用 `blocker_content` 樣本＋`stopped_rate`＋`reentry` 涵蓋。

- [ ] **Step 1: 追加失敗測試到 `tests/health-data.test.js`**（在既有 test 之後）：

```javascript
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
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app/server && npx jest tests/health-data.test.js`
Expected: FAIL（`Cannot find module '../pipeline/health-data'`）

- [ ] **Step 3: 建 `app/server/pipeline/health-data.js`**

```javascript
const { query } = require('../db');

const SAMPLE = 5;                                   // 樣本上限，避免 prompt 過長
const REJECT_STAGES = new Set(['coding', 'analysis']); // 人工退回對這兩類 agent 最可行動

// 單一 agent 近 windowDays 天的精簡表現摘要（餵給健檢 agent 的原料，先在 JS 聚合壓縮避免整表塞 prompt）。
// 以 agent.stage 對 token_usage.agent_type 過濾；tasks 經 token_usage.task_id 業務 id 關聯 tasks.task_id。
async function buildAgentSummary(agent, { windowDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const stage = agent.stage;

  const { rows: [tk] } = await query(
    `SELECT COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::int  AS input_tokens,
            COALESCE(SUM(output_tokens),0)::int AS output_tokens,
            COALESCE(SUM(cache_read_tokens),0)::int AS cache_read,
            COALESCE(AVG(duration_ms),0)::int   AS avg_duration_ms,
            COUNT(*) FILTER (WHERE status <> 'completed')::int AS failed_calls
       FROM token_usage
      WHERE agent_type = $1 AND recorded_at >= $2`,
    [stage, cutoff]
  );
  const denom = tk.input_tokens + tk.cache_read;
  const token = {
    calls: tk.calls,
    input_tokens: tk.input_tokens,
    output_tokens: tk.output_tokens,
    avg_duration_ms: tk.avg_duration_ms,
    cache_hit_rate: denom ? Math.round((tk.cache_read / denom) * 100) / 100 : 0,
    failed_calls: tk.failed_calls
  };

  const { rows: taskRows } = await query(
    `SELECT DISTINCT t.id, t.status, t.reentry_count, t.blocker_content
       FROM tasks t
      WHERE t.task_id IN (
        SELECT DISTINCT task_id FROM token_usage
         WHERE agent_type = $1 AND task_id IS NOT NULL AND recorded_at >= $2)`,
    [stage, cutoff]
  );
  const total = taskRows.length;
  const stopped = taskRows.filter(r => r.status === 'stopped').length;
  const re = taskRows.map(r => r.reentry_count || 0);
  const tasks = {
    total,
    stopped_rate: total ? Math.round((stopped / total) * 100) / 100 : 0,
    reentry: {
      min: re.length ? Math.min(...re) : 0,
      max: re.length ? Math.max(...re) : 0,
      avg: re.length ? Math.round((re.reduce((a, b) => a + b, 0) / re.length) * 100) / 100 : 0
    },
    blocker_samples: taskRows.map(r => r.blocker_content).filter(Boolean).slice(0, SAMPLE)
  };

  let rejections = null;
  if (REJECT_STAGES.has(stage)) {
    const { rows: cats } = await query(
      `SELECT ri.category, COUNT(*)::int AS n
         FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
        WHERE tr.created_at >= $1 GROUP BY ri.category`,
      [cutoff]
    );
    const { rows: samp } = await query(
      `SELECT ri.description FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
        WHERE tr.created_at >= $1 ORDER BY ri.id DESC LIMIT $2`,
      [cutoff, SAMPLE]
    );
    rejections = {
      by_category: Object.fromEntries(cats.map(c => [c.category, c.n])),
      samples: samp.map(s => s.description)
    };
  }

  return { agent: agent.name, stage, window_days: windowDays, token, tasks, rejections };
}

module.exports = { buildAgentSummary };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app/server && npx jest tests/health-data.test.js`
Expected: PASS（3 個 test 全過）

- [ ] **Step 5: Commit**

```bash
git add app/server/pipeline/health-data.js app/server/tests/health-data.test.js
git commit -m "[HealthCheck] 資料聚合層 health-data：每 agent 精簡表現摘要"
```

---

## Task 3: 健檢 agent `.claude/agents/workflow-health.md`

**Files:**
- Create: `.claude/agents/workflow-health.md`
- Test: `app/server/tests/workflow-health-agent.test.js`（獨立檔、用**真實** `loadAgent` 驗 `.md`；不可與 Task 4 的 runner 測試同檔，因 Task 4 會 mock agent-loader）

**Interfaces:**
- Produces: agent 檔可被 `loadAgent('workflow-health')` 載入，`model==='opus'`、`stage==='workflow_health'`，`render({agent_label, agent_role, agent_prompt, summary})` 會填入 4 個 placeholder。

- [ ] **Step 1: 建 `app/server/tests/workflow-health-agent.test.js`（agent 契約測試）**

```javascript
// 意圖：健檢 agent 檔契約正確、runner 遍歷落 findings（工作流程健檢子專案 2）。
const { loadAgent } = require('../pipeline/agent-loader');

test('workflow-health agent：opus + workflow_health stage + 4 placeholder 可 render', () => {
  const a = loadAgent('workflow-health');
  expect(a.model).toBe('opus');
  expect(a.stage).toBe('workflow_health');
  const out = a.render({ agent_label: 'X 標籤', agent_role: '角色', agent_prompt: 'PROMPT-BODY', summary: '{"token":{}}' });
  expect(out).toContain('X 標籤');
  expect(out).toContain('PROMPT-BODY');
  expect(out).toContain('{"token":{}}');
  expect(out).not.toContain('{{');           // 無漏填 placeholder
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app/server && npx jest tests/workflow-health-agent.test.js`
Expected: FAIL（`ENOENT ... workflow-health.md`）

- [ ] **Step 3: 建 `.claude/agents/workflow-health.md`**

```markdown
---
name: workflow-health
role: analyzer
label: 工作流程健檢
description: 分析單一 pipeline agent 近期表現，出診斷與建議 prompt
model: opus
stage: workflow_health
---
你是「工作流程健檢分析師」。平台上有一個名為「{{agent_label}}」（角色：{{agent_role}}）的 pipeline agent。下面給你它的**現行提示詞**與**近期實際表現摘要**，請診斷它是否有系統性問題，並在有把握時提出改進後的完整提示詞。

## 現行提示詞
{{agent_prompt}}

## 近期表現摘要（JSON）
{{summary}}

## 判讀指引
- `token.failed_calls` 偏高、`tasks.stopped_rate` 偏高、`tasks.reentry.avg` 偏高＝該 agent 常失敗或反覆重跑，值得檢討提示詞。
- `rejections.by_category`（若有）反映人工退回的錯誤類型：「規格誤解」多＝分析/理解方向問題；「實作錯誤」多＝實作精確度問題。
- 若各指標正常、無明顯系統性問題，`severity` 給 `ok`、`suggested_prompt` 給 `null`，不要為改而改。

## 輸出
只回傳一個 JSON 物件，完整包在 <result></result> 內，標籤外不要任何文字：
- `diagnosis`：一段話，指出根據摘要中哪些訊號判斷出的問題（或「表現正常」）。
- `severity`：`ok` | `low` | `medium` | `high`（只能四選一）。
- `suggested_prompt`：改進後的**完整**提示詞 body（可直接取代現行提示詞）；無需改則為 `null`。若提供，必須沿用現行提示詞的 <result> 契約與所有 {{雙括號}} 佔位符，否則會被編輯器擋下。
- `rationale`：為何這樣改（對照摘要訊號）。

範例：
<result>
{"diagnosis":"近 30 天 stopped_rate 0.4、reentry.avg 1.8，且退回多為『規格誤解』，顯示需求理解不足。","severity":"medium","suggested_prompt":"<完整新提示詞，含原有 {{placeholder}} 與 <result> 契約>","rationale":"加強開工前對驗收條件的複述，降低方向性誤解。"}
</result>
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app/server && npx jest tests/workflow-health-agent.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/workflow-health.md app/server/tests/workflow-health-agent.test.js
git commit -m "[HealthCheck] workflow-health agent（opus、<result> JSON 契約）"
```

---

## Task 4: 執行 runner `health-check-runner.js`

**Files:**
- Create: `app/server/pipeline/health-check-runner.js`
- Test: `app/server/tests/health-check-runner.test.js`（**新檔**，與 Task 3 的 `workflow-health-agent.test.js` 分開；本檔 mock agent-loader）

**Interfaces:**
- Consumes: `buildAgentSummary`（Task 2）、`loadAgent`/`listAgents`（agent-loader）、`runClaude`、`parseAgentResult`、`logTokenUsage`/`logFailedUsage`、`query`。
- Produces: `runHealthCheck(runId, { windowDays = 30, startedBy = null }) → Promise<void>`。每個有 stage（且 stage≠workflow_health）的 agent 落一筆 `health_check_findings`；跑完把 run 設 `status='done', finished_at`；整體例外設 `status='error'`。

- [ ] **Step 1: 建 `app/server/tests/health-check-runner.test.js`**（全新檔）：

於檔案**最上方**（`require` 之前）放 mock：

```javascript
const { newDb } = require('pg-mem');
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
// 只健檢兩個假 agent，避免依賴真實 .md 清單
jest.mock('../pipeline/agent-loader', () => {
  const actual = jest.requireActual('../pipeline/agent-loader');
  return {
    ...actual,
    listAgents: () => ([
      { name: 'coding-project', stage: 'coding', label: '開發' },
      { name: 'qa', stage: 'qa', label: 'QA' },
      { name: 'workflow-health', stage: 'workflow_health', label: '健檢' } // 應被排除
    ]),
    loadAgent: (n) => n === 'workflow-health'
      ? { name: n, model: 'opus', render: () => 'RENDERED' }
      : actual.loadAgent(n)
  };
});
jest.mock('../pipeline/health-data', () => ({
  buildAgentSummary: jest.fn().mockResolvedValue({ token: {}, tasks: {}, rejections: null })
}));
```

於 mock 之後放 case：

```javascript
let dbModule2, runHealthCheck;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule2 = require('../db');
  dbModule2._setPoolForTesting(new Pool());
  await dbModule2.migrate();
  ({ runHealthCheck } = require('../pipeline/health-check-runner'));
});
afterAll(() => dbModule2._setPoolForTesting(null));
beforeEach(() => mockRunClaude.mockReset());

async function newRun() {
  const { rows: [r] } = await dbModule2.query(
    "INSERT INTO health_check_runs (status, window_days) VALUES ('running',30) RETURNING id");
  return r.id;
}

test('runHealthCheck：遍歷有 stage 的 agent（排除 workflow_health），每個落 finding，run 設 done', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"ok","severity":"low","suggested_prompt":null,"rationale":"r"}</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30, startedBy: null });

  const { rows: fs } = await dbModule2.query('SELECT agent_name, severity FROM health_check_findings WHERE run_id=$1 ORDER BY agent_name', [runId]);
  expect(fs.map(f => f.agent_name)).toEqual(['coding-project', 'qa']); // 排除 workflow-health
  const { rows: [run] } = await dbModule2.query('SELECT status, finished_at FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
  expect(run.finished_at).not.toBeNull();
});

test('某 agent 解析失敗 → 落 severity=error finding，其他 agent 照跑，run 仍 done', async () => {
  // 兩個 agent × (主呼叫 + haiku 補救) 都回壞資料 → parseAgentResult 回 null
  mockRunClaude.mockResolvedValue({ text: '不是結果', usage: null, durationMs: 5 });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query('SELECT severity FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.length).toBe(2);
  expect(fs.every(f => f.severity === 'error')).toBe(true);
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app/server && npx jest tests/health-check-runner.test.js`
Expected: FAIL（`Cannot find module '../pipeline/health-check-runner'`）

- [ ] **Step 3: 建 `app/server/pipeline/health-check-runner.js`**

```javascript
const { query } = require('../db');
const { listAgents, loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildAgentSummary } = require('./health-data');

const SEVERITIES = new Set(['ok', 'low', 'medium', 'high']);

// admin 一鍵健檢的背景執行（fire-and-forget）：對每個有 stage 的 pipeline agent（排除自己）
// 聚合摘要 → 跑 opus 健檢 agent → 落一筆 finding。單一 agent 失敗不影響其他（best-effort）。
async function runHealthCheck(runId, { windowDays = 30, startedBy = null } = {}) {
  try {
    const targets = listAgents().filter(a => a.stage && a.stage !== 'workflow_health');
    const ha = loadAgent('workflow-health');
    for (const agent of targets) {
      await checkOne(runId, agent, ha, windowDays, startedBy);
    }
    await query("UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1", [runId]);
  } catch (err) {
    await query("UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE id=$1", [runId]).catch(() => {});
  }
}

async function checkOne(runId, agent, ha, windowDays, startedBy) {
  let finding = null;
  try {
    const full = loadAgent(agent.name);                     // 取現行 prompt body
    const summary = await buildAgentSummary(agent, { windowDays });
    const prompt = ha.render({
      agent_label: agent.label,
      agent_role: full.role || '',
      agent_prompt: full.body || '',
      summary: JSON.stringify(summary)
    });
    const { text, usage, durationMs } = await runClaude(prompt, { model: ha.model });
    await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);
    const parsed = await parseAgentResult(text, { parse: JSON.parse });
    if (parsed && typeof parsed.diagnosis === 'string' && SEVERITIES.has(parsed.severity)) {
      finding = {
        severity: parsed.severity,
        diagnosis: parsed.diagnosis,
        suggested_prompt: parsed.suggested_prompt || null,
        rationale: parsed.rationale || null
      };
    }
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', err);
  }
  if (!finding) {
    finding = { severity: 'error', diagnosis: '健檢失敗：無法取得有效診斷', suggested_prompt: null, rationale: null };
  }
  await query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [runId, agent.name, agent.label, finding.diagnosis, finding.severity, finding.suggested_prompt, finding.rationale]
  );
}

module.exports = { runHealthCheck };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app/server && npx jest tests/health-check-runner.test.js`
Expected: PASS（agent 契約 + 2 個 runner case 全過）

- [ ] **Step 5: Commit**

```bash
git add app/server/pipeline/health-check-runner.js app/server/tests/health-check-runner.test.js
git commit -m "[HealthCheck] runner：遍歷 agent 落 findings、best-effort、run 收尾"
```

---

## Task 5: admin 路由

**Files:**
- Modify: `app/server/admin-routes.js`（`registerRoutes(app)` 內、agents 路由附近）
- Test: `app/server/tests/admin-health-check-routes.test.js`

**Interfaces:**
- Consumes: `runHealthCheck`（Task 4）、`const auth = [verifyToken, requireAdmin]`、`req.userId`。
- Produces:
  - `POST /api/admin/health-check { windowDays? }` → `{ runId }`（建 run、背景觸發、不 await）。
  - `GET /api/admin/health-check` → `[{ id, status, window_days, started_by, created_at, finished_at, findings_count }]`（近 20 筆）。
  - `GET /api/admin/health-check/:runId` → `{ run, findings: [...] }`。

- [ ] **Step 1: 建 `app/server/tests/admin-health-check-routes.test.js`**

```javascript
// 意圖：admin 一鍵健檢 API（建 run/背景觸發/查歷史與明細）＋admin-gate（子專案 2）。
const request = require('supertest');
const { newDb } = require('pg-mem');

const mockRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../pipeline/health-check-runner', () => ({ runHealthCheck: mockRun }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn(), getInflightTaskIds: () => [], getInflightInfo: () => [], abortTask: jest.fn(), whenIdle: jest.fn()
}));
process.env.JWT_SECRET = 'test-hc-routes';

let app, dbModule, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const setup = await request(app).post('/api/auth/setup').send({ username: 'admin1', password: 'pass1234', display_name: 'A' });
  adminToken = setup.body.token;
  await request(app).post('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'bob', password: 'pass1234', display_name: 'B', role: 'user' });
  const login = await request(app).post('/api/auth/login').send({ username: 'bob', password: 'pass1234' });
  userToken = login.body.token;
}, 30000);
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => mockRun.mockClear());

test('401 未帶 token / 403 非 admin', async () => {
  expect((await request(app).post('/api/admin/health-check')).status).toBe(401);
  expect((await request(app).post('/api/admin/health-check').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
});

test('POST → 建 run(running)、回 runId、背景觸發 runHealthCheck', async () => {
  const res = await request(app).post('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`).send({ windowDays: 14 });
  expect(res.status).toBe(200);
  expect(typeof res.body.runId).toBe('number');
  const { rows: [r] } = await dbModule.query('SELECT status, window_days FROM health_check_runs WHERE id=$1', [res.body.runId]);
  expect(r.status).toBe('running');
  expect(r.window_days).toBe(14);
  expect(mockRun).toHaveBeenCalledWith(res.body.runId, expect.objectContaining({ windowDays: 14 }));
});

test('GET list 回近筆含 findings_count；GET :id 回 run+findings', async () => {
  const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status, window_days) VALUES ('done',30) RETURNING id");
  await dbModule.query("INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity) VALUES ($1,'qa','d','ok')", [run.id]);

  const list = await request(app).get('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`);
  expect(list.status).toBe(200);
  const item = list.body.find(x => x.id === run.id);
  expect(item.findings_count).toBe(1);

  const detail = await request(app).get(`/api/admin/health-check/${run.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.run.id).toBe(run.id);
  expect(detail.body.findings[0].agent_name).toBe('qa');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app/server && npx jest tests/admin-health-check-routes.test.js`
Expected: FAIL（404 / route 未定義）

- [ ] **Step 3: 在 `admin-routes.js` 檔頭 require 加入 runner**

於既有 `const { getInflightInfo, abortTask } = require('./pipeline/runner');` 之後加：

```javascript
const { runHealthCheck } = require('./pipeline/health-check-runner');
```

- [ ] **Step 4: 在 `registerRoutes(app)` 內（`app.put('/api/admin/agents/:name', ...)` 之後）加三個路由**

```javascript
  // --- 工作流程健檢（子專案 2）：admin 一鍵，背景對每個 pipeline agent 出診斷 ---

  app.post('/api/admin/health-check', auth, async (req, res) => {
    try {
      const windowDays = Math.max(1, parseInt(req.body?.windowDays, 10) || 30);
      const { rows: [r] } = await query(
        "INSERT INTO health_check_runs (status, window_days, started_by) VALUES ('running',$1,$2) RETURNING id",
        [windowDays, req.userId]
      );
      // fire-and-forget：不 await，runner 自行落 status='done'/'error'
      runHealthCheck(r.id, { windowDays, startedBy: req.userId }).catch(() => {});
      res.json({ runId: r.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/health-check', auth, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.id, r.status, r.window_days, r.started_by, r.created_at, r.finished_at,
                (SELECT COUNT(*)::int FROM health_check_findings f WHERE f.run_id = r.id) AS findings_count
           FROM health_check_runs r ORDER BY r.id DESC LIMIT 20`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/health-check/:runId', auth, async (req, res) => {
    try {
      const { rows: [run] } = await query('SELECT * FROM health_check_runs WHERE id=$1', [req.params.runId]);
      if (!run) return res.status(404).json({ error: 'run 不存在' });
      const { rows: findings } = await query(
        'SELECT * FROM health_check_findings WHERE run_id=$1 ORDER BY id', [req.params.runId]);
      res.json({ run, findings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app/server && npx jest tests/admin-health-check-routes.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/admin-routes.js app/server/tests/admin-health-check-routes.test.js
git commit -m "[HealthCheck] admin 路由：POST 觸發＋GET 歷史/明細（admin-gate）"
```

---

## Task 6: 前端健檢頁 + 路由 + 導覽

**Files:**
- Create: `app/public/js/views/AdminHealthCheck.js`
- Modify: `app/public/index.html`（掛 script）
- Modify: `app/public/js/app.js`（加路由）
- Modify: `app/public/js/views/Admin.js`（加導覽卡片）

**Interfaces:**
- Consumes: `Api.get/post`、`GET/POST /api/admin/health-check`（Task 5）、`showToast`。
- Produces: 全域 `window.AdminHealthCheckView`；路由 `/admin/health`。

- [ ] **Step 1: 建 `app/public/js/views/AdminHealthCheck.js`**

```javascript
// 工作流程健檢（子專案 2）：admin 一鍵，對每個 pipeline agent 出診斷＋建議 prompt。
// 配色一律走 app.css CSS 變數／dark-aware，禁寫死淺色底。
const HC_SEV = {
  ok:     { label: '正常', color: 'var(--success, #059669)' },
  low:    { label: '輕微', color: 'var(--warning, #d97706)' },
  medium: { label: '中等', color: 'var(--warning, #d97706)' },
  high:   { label: '嚴重', color: 'var(--error)' },
  error:  { label: '健檢失敗', color: 'var(--text-muted)' }
};

window.AdminHealthCheckView = Vue.defineComponent({
  name: 'AdminHealthCheckView',
  data() {
    return { runId: null, run: null, findings: [], history: [], running: false, windowDays: 30, _timer: null };
  },
  async mounted() { await this.loadHistory(); },
  unmounted() { if (this._timer) clearInterval(this._timer); },
  methods: {
    async loadHistory() {
      try { this.history = await Api.get('admin/health-check'); }
      catch (e) { showToast(e.message, 'error'); }
    },
    async start() {
      this.running = true; this.findings = []; this.run = null;
      try {
        const { runId } = await Api.post('admin/health-check', { windowDays: this.windowDays });
        this.runId = runId;
        this._timer = setInterval(() => this.poll(), 3000);
        await this.poll();
      } catch (e) { showToast(e.message, 'error'); this.running = false; }
    },
    async poll() {
      try {
        const { run, findings } = await Api.get('admin/health-check/' + this.runId);
        this.run = run; this.findings = findings;
        if (run.status !== 'running') {
          clearInterval(this._timer); this._timer = null; this.running = false;
          await this.loadHistory();
        }
      } catch (e) { /* 單次輪詢失敗保留上批，下次恢復 */ }
    },
    async openRun(id) { this.runId = id; await this.poll(); },
    sev(s) { return HC_SEV[s] || HC_SEV.error; },
    applyToEditor(f) {
      if (!f.suggested_prompt) return;
      // 帶入既有 agent 編輯器：以 sessionStorage 暫存建議 prompt，導到 /admin/agents 由該頁預填
      sessionStorage.setItem('agentPrefill', JSON.stringify({ name: f.agent_name, prompt: f.suggested_prompt }));
      this.$router.push('/admin/agents?prefill=' + encodeURIComponent(f.agent_name));
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:12px">← 返回</button>
      <h1>工作流程健檢</h1>
    </div>
    <div class="content">
      <div style="max-width:1000px">
        <div class="admin-section" style="display:flex;align-items:center;gap:12px">
          <label style="font-size:13px">近
            <input type="number" v-model.number="windowDays" min="1" style="width:64px" class="form-control" /> 天
          </label>
          <button class="btn btn-primary btn-sm" :disabled="running" @click="start">
            {{ running ? '健檢中...' : '開始健檢' }}
          </button>
          <span v-if="run" style="font-size:12px;color:var(--text-muted)">
            狀態：{{ run.status }}（{{ findings.length }} 個 agent 已診斷）
          </span>
        </div>

        <div v-for="f in findings" :key="f.id" class="admin-section"
          style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--surface)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-family:monospace;font-weight:600">{{ f.agent_label || f.agent_name }}</span>
            <span :style="{fontSize:'11px',padding:'1px 8px',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
              {{ sev(f.severity).label }}
            </span>
          </div>
          <div style="font-size:13px;color:var(--text);margin-bottom:6px">{{ f.diagnosis }}</div>
          <div v-if="f.rationale" style="font-size:12px;color:var(--text-muted);margin-bottom:6px">理由：{{ f.rationale }}</div>
          <button v-if="f.suggested_prompt" class="btn btn-outline btn-sm" @click="applyToEditor(f)">帶入編輯器 →</button>
        </div>

        <div class="admin-section">
          <h2 class="section-title">歷史健檢</h2>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
              <th style="padding:6px 10px">時間</th><th style="padding:6px 10px">視窗</th>
              <th style="padding:6px 10px">狀態</th><th style="padding:6px 10px">診斷數</th>
            </tr></thead>
            <tbody>
              <tr v-for="h in history" :key="h.id" style="border-bottom:1px solid var(--border);cursor:pointer" @click="openRun(h.id)">
                <td style="padding:6px 10px">{{ new Date(h.created_at).toLocaleString() }}</td>
                <td style="padding:6px 10px">{{ h.window_days }} 天</td>
                <td style="padding:6px 10px">{{ h.status }}</td>
                <td style="padding:6px 10px">{{ h.findings_count }}</td>
              </tr>
              <tr v-if="history.length === 0"><td colspan="4" style="padding:16px;text-align:center;color:var(--text-muted)">尚無健檢紀錄</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
});
```

- [ ] **Step 2: 在 `index.html` 掛 script**（`AdminPipelines.js` 那一行之後）

```html
  <script src="/js/views/AdminHealthCheck.js"></script>
```

- [ ] **Step 3: 在 `app.js` 路由陣列加一行**（`/admin/pipelines` 那筆之後）

```javascript
    { path: '/admin/health', component: window.AdminHealthCheckView, meta: { requiresAuth: true, requiresAdmin: true } },
```

- [ ] **Step 4: 在 `Admin.js` 加導覽卡片**（「Agent 管理」`setting-block` 之後、`</div>` 收尾之前）

```html
        <!-- 工作流程健檢 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">工作流程健檢</div>
            <div class="setting-block-desc">分析各 pipeline agent 近期表現，提出提示詞改進建議。</div>
          </div>
          <div class="setting-block-footer" style="border-top:none;padding-top:0">
            <button class="btn btn-primary btn-sm" @click="$router.push('/admin/health')">前往健檢 →</button>
          </div>
        </div>
```

- [ ] **Step 5: 手動驗證（前端無單元測試框架）**

啟動平台，以 admin 登入 → `/admin` 見「工作流程健檢」卡片 → 進入頁面按「開始健檢」→ 觀察 findings 卡片逐一出現、歷史列表更新、深色模式文字不隱形。
Expected: 頁面正常渲染、輪詢到 `status='done'`、severity badge 配色正確。

- [ ] **Step 6: Commit**

```bash
git add app/public/js/views/AdminHealthCheck.js app/public/index.html app/public/js/app.js app/public/js/views/Admin.js
git commit -m "[HealthCheck] 前端健檢頁＋路由＋Admin 導覽卡"
```

---

## Task 7: 帶入編輯器預填 + 用量報表配色

**Files:**
- Modify: `app/public/js/views/AdminAgents.js`（`created()` 讀 query/sessionStorage 預填）
- Modify: `app/public/js/views/TokenReport.js`（`agentColor` map 加 `workflow_health`）

**Interfaces:**
- Consumes: `sessionStorage['agentPrefill']`（Task 6 寫入）、`this.$route.query.prefill`。
- Produces: 進入 `/admin/agents?prefill=<name>` 時自動選該 agent 並把建議 prompt 填入 `form.prompt`（保持 `dirty=true`，需人工按儲存才走 `updateAgent` 校驗）。

- [ ] **Step 1: 修改 `AdminAgents.js` 的 `created()`**

將原：
```javascript
  async created() { await this.load(); },
```
改為：
```javascript
  async created() {
    await this.load();
    // 健檢「帶入編輯器」：帶 ?prefill=<name> 進來時自動選該 agent 並填入建議 prompt（人工審後才儲存）
    const name = this.$route.query.prefill;
    if (name) {
      const stash = sessionStorage.getItem('agentPrefill');
      sessionStorage.removeItem('agentPrefill');
      await this.select({ name });
      if (this.selected && stash) {
        try {
          const { name: n, prompt } = JSON.parse(stash);
          if (n === this.selected.name && prompt) this.form.prompt = prompt;  // 留 dirty，提示「尚未儲存」
        } catch (_) { /* 壞資料忽略 */ }
      }
    }
  },
```

- [ ] **Step 2: 修改 `TokenReport.js` 的 `agentColor` map**

將：
```javascript
      const map = { cs: '#7c3aed', triage: '#6b7280', analysis: '#2563eb', coding: '#059669',
                    qa: '#d97706', merge: '#db2777', deploy_fix: '#dc2626', wiki: '#0891b2', chat: '#f59e0b' };
```
改為（尾端加一色 `workflow_health`）：
```javascript
      const map = { cs: '#7c3aed', triage: '#6b7280', analysis: '#2563eb', coding: '#059669',
                    qa: '#d97706', merge: '#db2777', deploy_fix: '#dc2626', wiki: '#0891b2', chat: '#f59e0b',
                    workflow_health: '#7e22ce' };
```

- [ ] **Step 3: 手動驗證**

健檢頁一張有建議的卡片按「帶入編輯器 →」→ 導到 `/admin/agents`，該 agent 已選中、提示詞已換成建議內容、顯示「尚未儲存」；改動若破壞 `<result>`／`{{placeholder}}` 按儲存會被擋（沿用既有 `updateAgent` 校驗）。用量報表出現 `workflow_health` 有專屬顏色、非灰色 fallback。
Expected: 預填生效、校驗生效、配色生效。

- [ ] **Step 4: Commit**

```bash
git add app/public/js/views/AdminAgents.js app/public/js/views/TokenReport.js
git commit -m "[HealthCheck] 帶入編輯器預填＋用量報表 workflow_health 配色"
```

---

## Self-Review

**Spec coverage：**
- A 資料聚合 `health-data.js` → Task 2 ✓（task_events 片段刻意捨棄，改 blocker_content，已於 Task 2 註記並向使用者說明）。
- B 健檢 agent `workflow-health.md`（opus、`<result>` JSON 契約、4 placeholder）→ Task 3 ✓。
- C runner `health-check-runner.js`（遍歷、best-effort、run 收尾、`workflow_health` 記帳）→ Task 4 ✓。
- D API 三路由（POST 觸發／GET 歷史／GET 明細、admin-gate）→ Task 5 ✓。
- E 兩表 + 索引 → Task 1 ✓。
- F 前端 Admin 新頁（按鈕/進度/每 agent 卡/severity 配色/歷史/帶入編輯器）→ Task 6 ✓；帶入編輯器預填＋updateAgent 校驗＋TokenReport 配色 → Task 7 ✓。

**Placeholder scan：** 無 TBD／TODO；所有 step 附完整程式碼或具體驗證指令。

**Type consistency：** `buildAgentSummary(agent,{windowDays})` 回傳結構於 Task 2 定義、Task 4 以 `JSON.stringify(summary)` 消費；`runHealthCheck(runId,{windowDays,startedBy})` 於 Task 4 定義、Task 5 同簽名呼叫；findings 欄位（`agent_name/agent_label/diagnosis/severity/suggested_prompt/rationale`）Task 1 建表、Task 4 寫入、Task 5 讀出、Task 6 顯示一致。
