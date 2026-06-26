# AI Dev Web Platform — Sub-plan 12: Auto-deploy Error Fixing

**Goal:** 部署失敗後，AI 自動判斷錯誤類型：Odoo 模組錯誤→呼叫 coding agent 修改程式碼；環境錯誤（pip install 等）→AI 先嘗試自動修復；需人工授權→通知使用者；成功後重試部署。

**Architecture:** 新增 `deploy-fixer.js`；pipeline runner 的 `deploy_pending` 失敗路徑改呼叫 deploy-fixer；deploy-fixer 分析 stderr 並決定路徑；新增 `deploy_fixing` 狀態。

**Tech Stack:** Express 4、Node.js child_process（execFile）、Claude API（haiku）、pg pool

## Global Constraints

- deploy 失敗後進入 `deploy_fixing` 狀態（不直接 stopped）
- 分類：
  - `odoo_error`：Odoo 模組載入錯誤 → 走 coding_running（重新開發）
  - `env_error_fixable`：pip、apt、chmod 等 → AI 嘗試自動修復（execFile 執行指令）
  - `env_error_needs_auth`：需 sudo/root/cert → 通知人工，status='stopped' blocker_type='tech'
- 最多重試 3 次（loop guard 存 deploy_retry_count 欄位）
- 142/142 現有測試繼續通過

---

## Task 1: deploy-fixer.js + runner 修改

**Files:**
- Modify: `app/server/db.js` — tasks 加 `deploy_retry_count` 欄位
- Create: `app/server/pipeline/deploy-fixer.js`
- Modify: `app/server/pipeline/runner.js` — deploy 失敗路徑改為呼叫 deploy-fixer；加 `deploy_fixing` 狀態
- Create: `app/server/tests/deploy-fixer.test.js`

### deploy-fixer.js 核心邏輯

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const { execFile } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

const client = new Anthropic();
const MAX_RETRY = 3;

async function analyzeDeployError(errorText) {
  // call haiku to classify error
  // returns { type: 'odoo_error'|'env_error_fixable'|'env_error_needs_auth', fix_cmd?: string[], fix_bin?: string }
}

async function runDeployFixer(taskId, userId, errorMsg) {
  // 1. check deploy_retry_count < MAX_RETRY
  // 2. increment deploy_retry_count
  // 3. classify error via analyzeDeployError
  // 4a. odoo_error → set status='coding_running'
  // 4b. env_error_fixable → execFile fix command → if ok → set status='deploy_pending' (retry)
  //                       → if fail → set status='stopped' blocker_type='tech'
  // 4c. env_error_needs_auth → set status='stopped' blocker_type='tech' notify
}
```

- [ ] **Step 1: db.js colMigrations 加 deploy_retry_count**

```javascript
{ table: 'tasks', col: 'deploy_retry_count', sql: 'ALTER TABLE tasks ADD COLUMN deploy_retry_count INTEGER DEFAULT 0' },
```

- [ ] **Step 2: 建立 deploy-fixer.js**

完整實作：

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const { execFile } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

const client = new Anthropic();
const MAX_RETRY = 3;

function runFix(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function analyzeDeployError(errorText) {
  const prompt = `分析以下部署錯誤，判斷類型並提供修復指令。

回傳 JSON（不要其他文字）：
{
  "type": "odoo_error",        // Odoo 模組 Python 錯誤（語法錯誤、欄位錯誤等）
  "fix_bin": null,
  "fix_args": null
}
或
{
  "type": "env_error_fixable", // 可自動修復的環境問題
  "fix_bin": "pip",            // 要執行的程式（pip/chmod/python3）
  "fix_args": ["install", "xxx"] // 參數陣列
}
或
{
  "type": "env_error_needs_auth", // 需要 root/sudo/cert 授權
  "fix_bin": null,
  "fix_args": null
}

部署錯誤：
${errorText}`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = msg.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { type: 'env_error_needs_auth', fix_bin: null, fix_args: null };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { type: 'env_error_needs_auth', fix_bin: null, fix_args: null };
  }
}

async function runDeployFixer(taskId, userId, errorMsg) {
  const { rows: [task] } = await query(
    'SELECT deploy_retry_count FROM tasks WHERE id=$1', [taskId]
  );
  if (!task) return;

  const retryCount = (task.deploy_retry_count || 0) + 1;
  await query('UPDATE tasks SET deploy_retry_count=$2 WHERE id=$1', [taskId, retryCount]);

  if (retryCount > MAX_RETRY) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='tech', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, `部署重試超過 ${MAX_RETRY} 次上限：${errorMsg}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  let classification;
  try {
    classification = await analyzeDeployError(errorMsg);
  } catch {
    classification = { type: 'env_error_needs_auth' };
  }

  if (classification.type === 'odoo_error') {
    await query(
      "UPDATE tasks SET status='coding_running', updated_at=NOW() WHERE id=$1", [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    return;
  }

  if (classification.type === 'env_error_fixable' && classification.fix_bin && Array.isArray(classification.fix_args)) {
    try {
      await runFix(classification.fix_bin, classification.fix_args);
      await query(
        "UPDATE tasks SET status='deploy_pending', updated_at=NOW() WHERE id=$1", [taskId]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_pending' });
    } catch (fixErr) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_type='tech', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, `自動修復失敗：${fixErr.message}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    }
    return;
  }

  // env_error_needs_auth or fallback
  await query(
    "UPDATE tasks SET status='stopped', blocker_type='tech', blocker_content=$2, updated_at=NOW() WHERE id=$1",
    [taskId, `部署失敗需人工處理：${errorMsg}`]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

module.exports = { runDeployFixer, analyzeDeployError };
```

- [ ] **Step 3: runner.js deploy 失敗改呼叫 runDeployFixer**

找到 deploy_pending 失敗路徑：

```javascript
// 原來：
await query("UPDATE tasks SET status='stopped' ...")

// 改為：
await query("UPDATE tasks SET status='deploy_fixing' ...")
notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'deploy_fixing' });
```

並在 RUNNABLE_STATUSES 加入 `'deploy_fixing'`，加入 handler：

```javascript
if (status === 'deploy_fixing') {
  if (_inFlight.has(taskId)) return;
  _inFlight.add(taskId);
  try {
    const { runDeployFixer } = require('./deploy-fixer');
    const blocker = task.blocker_content || '';
    await runDeployFixer(taskId, task.user_id, blocker);
  } finally { _inFlight.delete(taskId); }
  return;
}
```

需要 runner 的 deploy_pending handler 把錯誤訊息存到 blocker_content 後設為 `deploy_fixing`。

- [ ] **Step 4: 建立 deploy-fixer.test.js**

```javascript
// mock @anthropic-ai/sdk, child_process, notify
// 測試：
// - odoo_error → coding_running
// - env_error_fixable → fix succeeds → deploy_pending
// - env_error_fixable → fix fails → stopped
// - env_error_needs_auth → stopped
// - max retry exceeded → stopped
```

- [ ] **Step 5: 全套測試 + Commit**

---

## Task 2: TaskDetail UI + Deploy Status Labels

**Files:**
- Modify: `app/public/js/views/TaskDetail.js`

加入 `deploy_fixing` 狀態 label 到 TD_STATUS_LABELS。

- [ ] **Step 1: 加 `deploy_fixing: '部署修復中'` 到 TD_STATUS_LABELS**

- [ ] **Step 2: 全套測試 + Commit**
