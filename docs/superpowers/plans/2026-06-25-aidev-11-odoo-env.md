# AI Dev Web Platform — Sub-plan 11: Odoo Test Environment

**Goal:** 讓使用者從平台一鍵建立 Odoo 測試環境：git clone → venv → install deps → init DB → start。夜間定時自動關機。

**Architecture:** 新表 `odoo_envs`；`env-routes.js`；`env-agent.js`（非同步執行 shell 命令）；cron 加夜間 shutdown；UI 在 ProjectDetail 顯示環境狀態與按鈕。

**Tech Stack:** Express 4、Node.js child_process、Vue 3 CDN、pg pool

## Global Constraints

- shell 命令透過 Node.js `child_process.exec` 執行，非同步
- 僅支援 Linux 環境（生產伺服器）；路徑不寫死 Windows
- env status: `idle` | `setting_up` | `running` | `error`
- pg-mem 相容性
- 136/136 現有測試繼續通過

---

## Task 1: DB + Env Agent + Routes

**Files:**
- Modify: `app/server/db.js`
- Create: `app/server/pipeline/env-agent.js`
- Create: `app/server/env-routes.js`
- Modify: `app/server/index.js`
- Modify: `app/server/cron.js`
- Create: `app/server/tests/env-routes.test.js`

### Table

```sql
CREATE TABLE IF NOT EXISTS odoo_envs (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
  status     TEXT NOT NULL DEFAULT 'idle',
  pid        INTEGER,
  port       INTEGER,
  url        TEXT,
  error_msg  TEXT,
  setup_log  TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

### API Routes

```
GET    /api/projects/:id/env          → get env status (或 {status:'idle'} if not exists)
POST   /api/projects/:id/env/setup    → start setup (body: { port?: number })
POST   /api/projects/:id/env/stop     → stop running env
DELETE /api/projects/:id/env          → reset to idle
```

### Env Agent (env-agent.js)

```javascript
const { exec } = require('child_process');
const { query } = require('../db');

async function runEnvSetup(projectId, port = 8069) {
  // 1. get project (name, odoo_version)
  // 2. upsert odoo_envs status='setting_up'
  // 3. determine paths: baseDir = process.env.ODOO_ENV_BASE || '/opt/odoo-envs'
  //    envDir = `${baseDir}/${project.name}`
  // 4. execSequence:
  //    a. git clone odoo source (from odoo_version_configs.odoo_bin_path's parent or a fixed template)
  //       → actually clone from GitHub: `https://github.com/odoo/odoo.git --branch ${major}.0 --depth=1`
  //    b. create venv: `python3 -m venv ${envDir}/venv`
  //    c. pip install: `${envDir}/venv/bin/pip install -r ${envDir}/src/requirements.txt`
  //    d. init DB: `${envDir}/venv/bin/python ${envDir}/src/odoo-bin -d test_${project.name} --stop-after-init -i base`
  //    e. start: `${envDir}/venv/bin/python ${envDir}/src/odoo-bin -d test_${project.name} --http-port=${port} &`
  //       capture PID
  // 5. on success: update odoo_envs status='running', pid, port, url=`http://localhost:${port}`
  // 6. on any step failure: update status='error', error_msg=stderr
}

async function stopEnv(projectId) {
  // get pid from odoo_envs, kill process, update status='idle'
}

async function nightlyShutdown() {
  // stop all running envs
  const { rows } = await query("SELECT id, pid, project_id FROM odoo_envs WHERE status='running'");
  for (const env of rows) {
    if (env.pid) { try { process.kill(env.pid, 'SIGTERM'); } catch {} }
    await query("UPDATE odoo_envs SET status='idle', pid=NULL, updated_at=NOW() WHERE id=$1", [env.id]);
  }
}
```

- [ ] **Step 1: db.js 加 odoo_envs 表**

```javascript
`CREATE TABLE IF NOT EXISTS odoo_envs (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'idle',
  pid        INTEGER,
  port       INTEGER,
  url        TEXT,
  error_msg  TEXT,
  setup_log  TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id)
)`,
```

- [ ] **Step 2: 建立 env-agent.js**

核心邏輯如上所述。使用 `child_process.exec` + Promise wrapper：

```javascript
function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}
```

完整實作包含：
- `runEnvSetup(projectId, port)`：依序執行 5 步驟，每步驟失敗即 catch 寫入 error_msg
- `stopEnv(projectId)`：SIGTERM + status='idle'
- `nightlyShutdown()`：遍歷所有 running envs，全部 stop

- [ ] **Step 3: 建立 env-routes.js**

```javascript
function registerRoutes(app) {
  // GET /api/projects/:id/env
  // POST /api/projects/:id/env/setup
  // POST /api/projects/:id/env/stop
  // DELETE /api/projects/:id/env
}
```

- [ ] **Step 4: index.js 加 registerEnvRoutes**

- [ ] **Step 5: cron.js 加夜間 shutdown**

讀取 users 表中第一個 admin 的 settings.env_shutdown_time（格式 'HH:MM'，預設 '23:00'），在該時間觸發 nightlyShutdown()。

```javascript
const now = new Date();
const [h, m] = (shutdownTime || '23:00').split(':').map(Number);
if (now.getHours() === h && now.getMinutes() === m) {
  const { nightlyShutdown } = require('./pipeline/env-agent');
  await nightlyShutdown();
}
```

cron 每分鐘跑一次（已是現有行為），在 runCron 中加入此判斷。

- [ ] **Step 6: 建立 env-routes.test.js**

mock exec + 測試 CRUD + status 流程。

```javascript
// mock exec
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, opts, cb) => cb(null, 'ok', ''))
}));

// 測試:
// GET → idle if not exists
// POST setup → 200, triggers runEnvSetup
// POST stop → 200
// DELETE → resets to idle
```

- [ ] **Step 7: 執行測試 + 全套 + Commit**

---

## Task 2: Env UI in ProjectDetail

**Files:**
- Modify: `app/public/js/views/ProjectDetail.js`

在 Wiki/Chat 按鈕區下方加入「測試環境」區塊：

```
測試環境狀態：● idle / 設定中... / 運行中 (http://localhost:8069) / 錯誤

[一鍵建立環境] [停止] [刪除]
```

- [ ] **Step 1: ProjectDetail.js 加 envStatus data + loadEnv() method**

```javascript
// data: envStatus: null (null=未載入), env: null
// methods:
// loadEnv() → GET /api/projects/:id/env
// setupEnv() → POST /api/projects/:id/env/setup
// stopEnv() → POST /api/projects/:id/env/stop
// deleteEnv() → DELETE /api/projects/:id/env
```

在 created() 中加入 await this.loadEnv()。

- [ ] **Step 2: template 加環境狀態區塊**

- [ ] **Step 3: 全套測試 + Commit**
