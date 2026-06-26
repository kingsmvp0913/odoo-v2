# AI Dev Web Platform — Sub-plan 9: Customer Service Agent

**Goal:** 新增客服 Agent 對現有 task sync 進來的 `service` 任務做初步分流：操作問題 → 生回覆 → `cs_reply_pending`；需改程式但資料模糊 → `cs_data_needed`；需改程式且資料足夠 → 直接走現有 analysis pipeline。

**Architecture:** 新增 `cs_agent.js`；pipeline runner 新增 `cs_running` 狀態；tasks 加 `task_type` 欄位（'odoo' | 'service'）；sync 進來的 service task 初始化為 `cs_running`；TaskDetail UI 支援 `cs_reply_pending`（顯示回覆草稿，人工確認後送出）和 `cs_data_needed`（顯示需補充資料提示）。

**Tech Stack:** Express 4、Vue 3 CDN、Claude API（haiku）

## Global Constraints

- task_type: 'odoo'（預設）| 'service'
- service task sync 進來時 status = 'cs_running'（不是 'new'）
- CS agent 判斷結果：
  - `cs_reply_pending`：task 加 `cs_reply` 欄位（TEXT，回覆草稿）
  - `cs_data_needed`：task 加 `cs_question` 欄位（TEXT，需補充什麼）
  - `analysis_running`：直接進現有 pipeline
- 122/122 現有測試必須繼續通過

---

## Task 1: DB Migration + CS Agent

**Files:**
- Modify: `app/server/db.js` — tasks 加 `task_type`、`cs_reply`、`cs_question`
- Create: `app/server/pipeline/cs-agent.js`
- Modify: `app/server/pipeline/runner.js` — 加 `cs_running` 狀態
- Modify: `app/server/sync.js` — service task 初始狀態改為 `cs_running`
- Create: `app/server/tests/cs-agent.test.js`

- [ ] **Step 1: db.js colMigrations 加三欄**

```javascript
{ table: 'tasks', col: 'task_type',   sql: "ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'odoo'" },
{ table: 'tasks', col: 'cs_reply',    sql: 'ALTER TABLE tasks ADD COLUMN cs_reply TEXT' },
{ table: 'tasks', col: 'cs_question', sql: 'ALTER TABLE tasks ADD COLUMN cs_question TEXT' },
```

- [ ] **Step 2: 建立 cs-agent.js**

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../db');
const notify = require('../notify');

const client = new Anthropic();

async function runCsAgent(taskId, userId) {
  const { rows: [task] } = await query(
    'SELECT id, title, original_text, project_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;

  // 取 wiki context（若有關聯 project）
  let wikiContext = '';
  if (task.project_id) {
    const { rows: pages } = await query(
      'SELECT title, content FROM wiki_pages WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 5',
      [task.project_id]
    );
    wikiContext = pages.map(p => `## ${p.title}\n${p.content}`).join('\n\n');
  }

  const prompt = `你是客服分流 Agent。分析以下客戶問題，判斷其性質並決定處理方式。

回傳 JSON（不要其他文字）：
{
  "type": "operation" | "code_change_clear" | "code_change_vague",
  "reply": "<若 type=operation，生成給客戶的回覆；否則 null>",
  "question": "<若 type=code_change_vague，列出需要客戶補充的資訊；否則 null>"
}

判斷標準：
- operation：純操作問題，用現有功能就能解決
- code_change_clear：需要修改程式，且問題描述足夠清楚（有明確的預期行為、步驟可重現）
- code_change_vague：需要修改程式，但描述模糊（缺乏重現步驟、版本資訊、截圖說明等）

客戶問題標題：${task.title || '未命名'}
客戶問題內容：
${task.original_text || '（無詳細內容）'}

Wiki 參考資料：
${wikiContext || '（無 wiki）'}`;

  let result = null;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) result = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[CS-AGENT] API error task ${taskId}:`, err.message);
  }

  if (!result) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='agent', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, 'CS agent failed to parse response']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  if (result.type === 'operation') {
    await query(
      "UPDATE tasks SET status='cs_reply_pending', cs_reply=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.reply || '']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_reply_pending' });
  } else if (result.type === 'code_change_vague') {
    await query(
      "UPDATE tasks SET status='cs_data_needed', cs_question=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.question || '']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_data_needed' });
  } else {
    await query(
      "UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
  }
}

module.exports = { runCsAgent };
```

- [ ] **Step 3: runner.js 加 cs_running**

`RUNNABLE_STATUSES` 加入 `'cs_running'`。

在 `wiki_updating` 之後加入：

```javascript
if (status === 'cs_running') {
  if (_inFlight.has(taskId)) return;
  _inFlight.add(taskId);
  try {
    const { runCsAgent } = require('./cs-agent');
    await runCsAgent(taskId, task.user_id);
  } finally { _inFlight.delete(taskId); }
  return;
}
```

- [ ] **Step 4: sync.js 讓 service task 初始狀態為 cs_running**

找到 sync.js 中 INSERT tasks 的地方，service task 的 status 改為 `'cs_running'`，並設 `task_type='service'`。

（讀取 sync.js 後精確修改）

- [ ] **Step 5: cs-agent.test.js**

```javascript
const { newDb } = require('pg-mem');

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, runCsAgent;
let userSeq = 0;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ runCsAgent } = require('../pipeline/cs-agent'));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

async function makeTask(overrides = {}) {
  userSeq++;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('cs${userSeq}', $1, 'CS') RETURNING id`,
    [hash]
  );
  const { rows: [task] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, task_type)
     VALUES ($1, $2, 'service', $3, $4, 'cs_running', 'service') RETURNING id`,
    [user.id, `svc${userSeq}`, overrides.title || 'How do I export?', overrides.text || 'I want to export a report.']
  );
  return { userId: user.id, taskId: task.id };
}

test('operation → cs_reply_pending with reply', async () => {
  mockCreate.mockResolvedValueOnce({ content: [{ text: '{"type":"operation","reply":"請到報表 > 匯出","question":null}' }] });
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_reply FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_reply_pending');
  expect(t.cs_reply).toContain('匯出');
});

test('code_change_clear → analysis_running', async () => {
  mockCreate.mockResolvedValueOnce({ content: [{ text: '{"type":"code_change_clear","reply":null,"question":null}' }] });
  const { userId, taskId } = await makeTask({ title: 'Bug in report', text: 'When clicking export the system crashes. Steps: 1. Go to report 2. Click export. Expected: file downloads. Actual: 500 error.' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('analysis_running');
});

test('code_change_vague → cs_data_needed with question', async () => {
  mockCreate.mockResolvedValueOnce({ content: [{ text: '{"type":"code_change_vague","reply":null,"question":"請提供重現步驟和錯誤截圖"}' }] });
  const { userId, taskId } = await makeTask({ title: 'Something is wrong', text: 'It does not work.' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_question FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_data_needed');
  expect(t.cs_question).toContain('重現步驟');
});

test('API error → stopped with blocker', async () => {
  mockCreate.mockRejectedValueOnce(new Error('timeout'));
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('agent');
});
```

- [ ] **Step 6: 執行測試**

```
cd app && npx jest tests/cs-agent.test.js --no-coverage
```

- [ ] **Step 7: 全套測試**

```
npx jest --no-coverage
```

- [ ] **Step 8: Commit**

```
git add app/server/db.js app/server/pipeline/cs-agent.js app/server/pipeline/runner.js app/server/sync.js app/server/tests/cs-agent.test.js
git commit -m "feat: CS agent with triage logic and cs_running pipeline status"
```

---

## Task 2: TaskDetail CS UI

**Files:**
- Modify: `app/public/js/views/TaskDetail.js`
- Modify: `app/server/pipeline-routes.js` — 加 `POST /api/tasks/:id/cs-confirm` 和 `POST /api/tasks/:id/cs-retry`

**新增 API：**
- `POST /api/tasks/:id/cs-confirm`：`cs_reply_pending` → `done`（人工確認回覆內容後送出）
- `POST /api/tasks/:id/cs-data-submit`：`cs_data_needed` → `cs_running`（客戶補完資料後重新分流）

**TaskDetail 新增顯示：**
- `cs_reply_pending`：顯示 `cs_reply` 內容 + 「確認送出」按鈕
- `cs_data_needed`：顯示 `cs_question` + 「已補充資料，重新分析」按鈕

- [ ] **Step 1: 在 pipeline-routes.js 加入兩個 CS endpoint**

```javascript
app.post('/api/tasks/:id/cs-confirm', verifyToken, async (req, res) => {
  try {
    const { rows } = await query('SELECT id, status FROM tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status !== 'cs_reply_pending') return res.status(400).json({ error: 'Task not in cs_reply_pending' });
    await query("UPDATE tasks SET status='done', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/:id/cs-data-submit', verifyToken, async (req, res) => {
  try {
    const { rows } = await query('SELECT id, status FROM tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status !== 'cs_data_needed') return res.status(400).json({ error: 'Task not in cs_data_needed' });
    await query("UPDATE tasks SET status='cs_running', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 2: TaskDetail.js 加入 CS 狀態顯示**

在 TaskDetail 的 status 顯示區加入：

```javascript
// cs_reply_pending 區塊
// cs_data_needed 區塊
// 對應的 confirm/retry 方法
```

讀取 TaskDetail.js 後精確插入。

- [ ] **Step 3: 全套測試 + Commit**
