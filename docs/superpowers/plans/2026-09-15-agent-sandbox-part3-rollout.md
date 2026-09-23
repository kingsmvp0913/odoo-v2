# 把 AI 關起來（子專案 0）實作計畫 — 第 3 部：內部 AI、自我檢測與分段啟用

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 內部 AI（健檢、夜間改善）以乾淨 worktree／修正 worktree 進容器；在正式平台以自我檢測端點跑規格 §8.3 的攻擊實測；照開發順序 1.2–1.7 分段打開開關、比對、最後移除無容器路徑。

**Architecture:** 見第 1 部檔頭。本部新增 `lib/platform-worktree.js`（每次內部 AI 執行開一個 detached 唯讀 worktree，用完即刪）、`lib/agent-sandbox-selftest.js`＋`POST /api/admin/agent-sandbox/selftest`（平台行程內真的開一個容器跑探針腳本，再用同一張通行證驗「結束後 401」）、`scripts/agent-sandbox-probe.sh`（容器內探針）、`scripts/verify-agent-sandbox.js`（管理員從終端機觸發並判讀）。

**Tech Stack:** 同第 1 部。

**Spec:** `docs/superpowers/specs/2026-09-11-agent-sandbox-design.md`；**前置：第 1、2 部全部完成**。Global Constraints 與「與規格不符之處」（X1–X21）以第 1 部檔頭為準。

## 重啟批次（X21）

使用者**只能在沒有任何 Claude session 在跑的時候**重啟平台（重啟會連同 session 一起砍掉）。所以本計畫的重啟只有三批，每批都由執行者**停手→回報→交接**，重啟後開新 session 從下一個 Task 接續：

| 批次 | 包含的碼 | 重啟前必須完成 | 重啟後第一件事 |
|---|---|---|---|
| **R-A** | 第 1、2 部全部＋本部 Task 3.1–3.3、3.13（開關 `off`，行為不變） | 全跑測試無新紅燈、整枝審查（Task 3.4）、合併進 master | Task 3.5：確認舊行為不變＋M3 Step 3＋自我檢測 |
| **R-B**（視需要） | 1.2–1.6 期間發現、必須改碼才能繼續的修正 | 同上；**開關先切回 `off` 或上一個安全值**再重啟 | 回到中斷的那個 Task 重驗 |
| **R-C** | Task 3.11：移除無容器路徑（1.7） | 1.6 全開觀察期結束、使用者同意 | Task 3.12 驗收 |

開關（`PUT /api/admin/agent-sandbox`）、映像檔 build、閘道／網路建立、session 檔複製**都不需要重啟**。

每次重啟前的共同檢查（開發順序 §2.3）：

```bash
# 在飛的任務與測試區（有就挑時段，不硬重啟）
curl -s -H "Authorization: Bearer $AIDEV_ADMIN_JWT" http://localhost:8771/api/pipeline/inflight
docker ps --filter name=odoo-test- --format '{{.Names}}'
```
重啟方式一律是使用者在主機跑 `upgrade.sh`；重啟後正在跑的測試區 cron 執行緒會死，要重開那些測試區（記憶 testenv-disconnect-from-platform-restart）。

## 共用指令：改開關（整組覆寫，務必帶齊上限）

`PUT /api/admin/agent-sandbox` 是**整組覆寫**：少帶 `memory`／`cpus`／`pids` 就會被清成 NULL，下一次 AI 執行立刻因「上限未設定」失敗。本部每次改開關一律用下面這個函式：先 GET 現值，只覆寫你給的欄位。

```bash
export AIDEV_ADMIN_JWT='<平台管理員登入後取得的 JWT>'
set_flag() {
  local cur body
  cur=$(curl -s -H "Authorization: Bearer $AIDEV_ADMIN_JWT" http://localhost:8771/api/admin/agent-sandbox)
  body=$(node -e '
    const c = JSON.parse(process.argv[1]); const o = JSON.parse(process.argv[2]);
    console.log(JSON.stringify({ mode: c.mode, project_ids: c.project_ids,
      memory: c.limits.memory, cpus: c.limits.cpus, pids: c.limits.pids,
      gateway_memory: c.gateway_limits.memory, gateway_cpus: c.gateway_limits.cpus, gateway_pids: c.gateway_limits.pids, ...o }));
  ' "$cur" "$1")
  curl -s -X PUT -H "Authorization: Bearer $AIDEV_ADMIN_JWT" -H 'Content-Type: application/json' http://localhost:8771/api/admin/agent-sandbox -d "$body"; echo
}
# 例：set_flag '{"mode":"internal"}'
```
（`8771` 是這台正式機的 `PORT`；其他機器看 `data/config.json`。）

## 執行順序

`3.1 → 3.2 → 3.3 → 3.13 → 3.4 → [R-A] → 3.5 → M10 → 3.6 → 3.7 → 3.8 → M11 → 3.9 → 3.10 → [R-C] → 3.11 → 3.12`（3.13 分支守衛：09-15 Q4 裁決必做，排在合併前）

| Task | 內容 | 對應開發順序 |
|---|---|---|
| 3.1 | `platform-worktree.js`：內部 AI 的乾淨 worktree＋啟動清殘留 | 1.1 |
| 3.2 | `platform_fix`／`fix_verify` 帶意見附件 id、容器內測試基線說明 | 1.1 |
| 3.3 | 自我檢測：探針腳本、selftest 模組、管理員端點、終端機腳本 | 1.1（為 1.2 準備） |
| 3.4 | 整枝審查＋合併進 master（開關 off）→ **R-A** | 1.3 |
| 3.5 | R-A 後：舊行為不變確認、唯讀角色（M3 Step 3）、映像檔 | 1.3 |
| M10 | 資源上限暫定值寫入設定（開關仍 off）→ 自我檢測在正式平台對測試專案全過 | 1.2（X15：排在合併之後；自我檢測需要上限已設） |
| 3.6 | 開關 `internal`：只開內部 AI，觀察一個夜間批次 | 1.4 |
| 3.7 | 複製既有 session 檔進各 scope 家目錄 | §9 第 4 步 |
| 3.8 | 開關 `projects`：只開測試專案，逐類任務試跑 | 1.5 |
| M11 | 容器內外 token 與結果比對（SQL） | 1.5 |
| 3.9 | 依 1.5 實測重訂資源上限 | 1.5 |
| 3.10 | 開關 `all`：開給全部 AI | 1.6 |
| 3.11 | 移除無容器路徑 → **R-C** | 1.7 |
| 3.12 | R-C 後驗收、階段 6 硬條件核對 | 1.7 |
| 3.13 | 主 clone refs 快照守衛（09-15 Q4 裁決必做，排在 3.4 之前） | 1.1 |

## 檔案地圖（第 3 部）

| 檔 | 動作 | 責任 |
|---|---|---|
| `app/server/lib/platform-worktree.js` | Create | 平台 repo 的 detached 唯讀 worktree（`<FIX_WORKTREE_DIR 或 .claude/worktrees>/ro-<runId>`）建立／移除／啟動清殘留 |
| `app/server/pipeline/finding-fix.js`、`fix-verify.js` | Modify | runClaude 帶 `feedbackIds` |
| `scripts/agent-sandbox-probe.sh` | Create | 容器內探針（bash＋curl＋claude，無 npm） |
| `app/server/lib/agent-sandbox-selftest.js` | Create | 平台行程內跑一次真容器自我檢測、解析探針輸出、驗結束後 401 |
| `app/server/admin-routes.js` | Modify | `POST /api/admin/agent-sandbox/selftest` |
| `scripts/verify-agent-sandbox.js` | Create | 終端機觸發自我檢測並判讀（只用 node 內建模組，rules/infra 113） |
| `app/server/pipeline/claude-runner.js`、`agent-runner.js`、`lib/agent-sandbox-flag.js`、`admin-routes.js` | Modify（3.11） | 移除無容器路徑 |
| 測試：`platform-worktree.test.js`、`agent-sandbox-selftest.test.js`、`fix-feedback-ids.test.js` | Create | |

---
## Task 3.1：`platform-worktree.js`——內部 AI 的乾淨唯讀 worktree

**為什麼**：規格 §4.5／總覽 D7——`workflow_health`、`fix_review`、`feedback_merge` 要看平台程式碼，但**絕不掛正在運作的 `/home/odoo/odoo-v2` 本體**（有 `data/config.json` 三把總鑰匙與 `data/run/ai.sock`）。每次執行從 git 開一個 detached worktree（只有 tracked 檔），容器以唯讀掛入，執行結束刪掉。

**Files:**
- Create: `app/server/lib/platform-worktree.js`
- Modify: `app/server/index.js`（第 2 部 Task 2.8 加的孤兒容器清理區塊之後）
- Test: `app/server/tests/platform-worktree.test.js`

**Interfaces:**
- Consumes：第 1 部 Task 1.12 的 git 加固（`process.env` 已帶 `core.hooksPath=/dev/null`）
- Produces（第 2 部 Task 2.5 `prepareSandboxRun` 以預設 deps 呼叫）：
  - `PLATFORM_RO_PREFIX = 'ro-'`
  - `worktreeRootFor(repoRoot) → string`（`FIX_WORKTREE_DIR` 或 `<repoRoot>/.claude/worktrees`，與 `finding-fix.js:32` 同一個根）
  - `createPlatformCleanWorktree(runId: string(hex), deps?: { repoRoot, execFile }) → Promise<string>`
  - `removePlatformCleanWorktree(wt: string, deps?) → Promise<void>`（只收 `ro-*`，其餘丟例外）
  - `removeStalePlatformWorktrees(deps?) → Promise<number>`（平台啟動時清上次沒收掉的 `ro-*`）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/platform-worktree.test.js
// 意圖：內部 AI 看平台碼只能看「git 裡有的檔」，不能看到工作目錄裡沒進版控的祕密（data/config.json）。
// 用真的暫存 git repo 驗：worktree 裡沒有 untracked 檔、刪除只動 ro-* 不會誤刪 nightly 的 fix-*。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const pw = require('../lib/platform-worktree');

let repo;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-wt-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(repo, 'data'));
  fs.writeFileSync(path.join(repo, 'data', 'config.json'), '{"APP_SECRET":"leak"}');
  fs.writeFileSync(path.join(repo, '.gitignore'), '/data/config.json\n');
  execFileSync('git', ['add', 'tracked.js', '.gitignore'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
const deps = () => ({ repoRoot: repo, execFile });

test('建出的 worktree 只有 tracked 檔，沒有 data/config.json', async () => {
  const wt = await pw.createPlatformCleanWorktree('abc123', deps());
  expect(wt).toBe(path.join(pw.worktreeRootFor(repo), 'ro-abc123'));
  expect(fs.existsSync(path.join(wt, 'tracked.js'))).toBe(true);
  expect(fs.existsSync(path.join(wt, 'data', 'config.json'))).toBe(false);
  await pw.removePlatformCleanWorktree(wt, deps());
  expect(fs.existsSync(wt)).toBe(false);
  expect(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })).not.toContain('ro-abc123');
});

test('runId 不是 hex → 丟例外（名字會進路徑）', async () => {
  await expect(pw.createPlatformCleanWorktree('../x', deps())).rejects.toThrow();
});

test('移除非 ro-* 或不在 worktree 根目錄底下的路徑 → 丟例外（不誤刪 nightly 的 fix-*）', async () => {
  const fix = path.join(pw.worktreeRootFor(repo), 'fix-9');
  fs.mkdirSync(fix, { recursive: true });
  await expect(pw.removePlatformCleanWorktree(fix, deps())).rejects.toThrow();
  await expect(pw.removePlatformCleanWorktree(repo, deps())).rejects.toThrow();
  expect(fs.existsSync(fix)).toBe(true);
});

test('啟動清殘留：只清 ro-*', async () => {
  await pw.createPlatformCleanWorktree('dead01', deps());
  await pw.createPlatformCleanWorktree('dead02', deps());
  const n = await pw.removeStalePlatformWorktrees(deps());
  expect(n).toBe(2);
  const left = fs.readdirSync(pw.worktreeRootFor(repo));
  expect(left).toContain('fix-9');
  expect(left.filter(x => x.startsWith('ro-'))).toEqual([]);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/platform-worktree.test.js`
Expected：FAIL，`Cannot find module '../lib/platform-worktree'`

- [ ] **Step 3：實作**

```js
// app/server/lib/platform-worktree.js
/**
 * platform-worktree.js — 內部 AI（健檢、審碼、統整）看平台碼用的乾淨唯讀 worktree（子專案 0 §4.5；總覽 D7）
 * detached HEAD、只含 tracked 檔；容器唯讀掛入；執行結束即刪。與 nightly 的 fix-* 同一個根目錄，名字以 ro- 區分。
 */
const fs = require('fs');
const path = require('path');
const { execFile: realExecFile } = require('child_process');

const PLATFORM_RO_PREFIX = 'ro-';
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function worktreeRootFor(repoRoot) {
  return process.env.FIX_WORKTREE_DIR || path.join(repoRoot, '.claude', 'worktrees');
}

function git(execFile, cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { message: `${err.message}\n${stderr || ''}`.trim() }));
      resolve(String(stdout || ''));
    });
  });
}

function assertOwned(wt, root) {
  const rel = path.relative(root, wt);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || !rel.startsWith(PLATFORM_RO_PREFIX)) {
    throw new Error(`拒絕移除：${wt} 不是 ${root}/${PLATFORM_RO_PREFIX}*`);
  }
}

async function createPlatformCleanWorktree(runId, deps = {}) {
  const repoRoot = deps.repoRoot || DEFAULT_REPO_ROOT;
  const execFile = deps.execFile || realExecFile;
  if (!/^[a-f0-9]+$/.test(String(runId))) throw new Error(`runId 不合法：${runId}`);
  const root = worktreeRootFor(repoRoot);
  fs.mkdirSync(root, { recursive: true });
  const wt = path.join(root, `${PLATFORM_RO_PREFIX}${runId}`);
  await git(execFile, repoRoot, ['worktree', 'add', '--detach', wt, 'HEAD']);
  return wt;
}

async function removePlatformCleanWorktree(wt, deps = {}) {
  const repoRoot = deps.repoRoot || DEFAULT_REPO_ROOT;
  const execFile = deps.execFile || realExecFile;
  assertOwned(wt, worktreeRootFor(repoRoot));
  try { await git(execFile, repoRoot, ['worktree', 'remove', '--force', wt]); }
  catch {
    await git(execFile, repoRoot, ['worktree', 'prune']).catch(() => {});
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

async function removeStalePlatformWorktrees(deps = {}) {
  const repoRoot = deps.repoRoot || DEFAULT_REPO_ROOT;
  const root = worktreeRootFor(repoRoot);
  let names = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  let n = 0;
  for (const name of names.filter(x => x.startsWith(PLATFORM_RO_PREFIX))) {
    await removePlatformCleanWorktree(path.join(root, name), deps);
    n++;
  }
  return n;
}

module.exports = { PLATFORM_RO_PREFIX, worktreeRootFor, createPlatformCleanWorktree, removePlatformCleanWorktree, removeStalePlatformWorktrees };
```

- [ ] **Step 4：`index.js` 啟動時清殘留**（第 2 部 Task 2.8 的 `[STARTUP] AI 孤兒容器` 區塊之後）

```js
    // 內部 AI 的乾淨 worktree：平台被重啟打斷時沒收掉的 ro-*（容器已被上一步清掉，這些不會再有人用）
    try {
      const n = await require('./lib/platform-worktree').removeStalePlatformWorktrees();
      if (n) console.log(`[STARTUP] 清掉 ${n} 個殘留的內部 AI worktree`);
    } catch (e) { console.error('[STARTUP] 清內部 AI worktree:', e.message); }
```

- [ ] **Step 5：跑測試確認通過**

Run: `cd app && npx jest server/tests/platform-worktree.test.js server/tests/sandbox-run.test.js`
Expected：PASS

- [ ] **Step 6：Commit**

```bash
git add app/server/lib/platform-worktree.js app/server/index.js app/server/tests/platform-worktree.test.js
git commit -m "[AgentSandbox]: 健檢與審碼 AI 要看平台碼，但平台資料夾裡有總鑰匙與 /ai socket，改成每次開一個只含 tracked 檔的唯讀 worktree

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3.2：`platform_fix` 帶意見附件 id；容器內測試基線的說明

**為什麼**：`platform_fix` 的 prompt 會列出意見回饋附件的絕對路徑（`finding-fix.js:255-262`，計畫 X7），容器裡要掛到那幾個 `feedback_<id>/` 才讀得到；掛載解析（第 1 部 Task 1.5）需要 `opts.feedbackIds`。

**Files:**
- Modify: `app/server/pipeline/finding-fix.js`（`runFix` 內 `runClaude(prompt, {`（09-15 第 338 行）；檔尾 `module.exports`）
- Test: `app/server/tests/fix-feedback-ids.test.js`

**Interfaces:**
- Consumes：`runFix(fixId, { findingId, startedBy, members })` 的 `members`（元素形如 `{ source: 'feedback'|'finding', id }`，見 `finding-fix.js:291` 附近 `refs.some(x => keys.has(\`${x.source}:${x.id}\`))`）
- Produces：`feedbackIdsOf(members) → number[]`（export）；`platform_fix` 的 runClaude opts 多 `feedbackIds`

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/fix-feedback-ids.test.js
// 意圖：容器只掛「這一組修正」用得到的意見附件；抓錯 id 不是讀不到圖，就是讀到別張意見的圖。
const { feedbackIdsOf } = require('../pipeline/finding-fix');

test('只取 feedback 來源、轉成整數、去重', () => {
  expect(feedbackIdsOf([
    { source: 'feedback', id: '3' }, { source: 'finding', id: 9 }, { source: 'feedback', id: 3 }, { source: 'feedback', id: 12 },
  ])).toEqual([3, 12]);
});

test('沒有 members（單一健檢提案）→ 空陣列', () => {
  expect(feedbackIdsOf(null)).toEqual([]);
  expect(feedbackIdsOf(undefined)).toEqual([]);
});

test('非正整數 id 丟掉（會進掛載路徑）', () => {
  expect(feedbackIdsOf([{ source: 'feedback', id: '../1' }, { source: 'feedback', id: 0 }])).toEqual([]);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/fix-feedback-ids.test.js`
Expected：FAIL，`feedbackIdsOf is not a function`

- [ ] **Step 3：實作**（`finding-fix.js`：在 `async function runFix` 之前加函式；runClaude 呼叫加一個屬性；exports 加名稱）

```js
// 容器模式下 platform_fix 只掛這一組修正的意見附件目錄（lib/agent-mounts.js 依此組 feedback_<id>/）
function feedbackIdsOf(members) {
  const ids = new Set();
  for (const m of members || []) {
    if (m && m.source === 'feedback' && /^[1-9]\d*$/.test(String(m.id))) ids.add(Number(m.id));
  }
  return [...ids];
}
```
```js
      const r = await runClaude(prompt, {
        model: agent.model, agentType: 'platform_fix', cwd: worktree, timeoutMs: FIX_TIMEOUT_MS,
        feedbackIds: feedbackIdsOf(members),
      });
```
`module.exports = { ... }` 內加 `feedbackIdsOf`。

- [ ] **Step 4：跑測試確認通過（含既有 finding-fix 測試）**

Run: `cd app && npx jest server/tests/fix-feedback-ids.test.js $(ls server/tests | grep -E '^finding-fix' | sed 's#^#server/tests/#')`
Expected：PASS

- [ ] **Step 5：容器內測試基線說明**（不改碼）：`finding-fix.js:171` 的 `measureTests` 是**平台行程**在宿主跑 jest 量基線，不在容器內；容器裡的 `platform_fix` 自己跑 `npm run test:quiet` 時，第 2 部 M8 記下的「容器內跑不起來的測試」會紅，但它們在基線與修改後都跑在宿主，基線比對不受影響。把 M8 的清單貼進 M1 表檔「3.2」段，1.4 觀察夜間批次時用它判讀 agent 輸出裡的紅燈。

- [ ] **Step 6：Commit**

```bash
git add app/server/pipeline/finding-fix.js app/server/tests/fix-feedback-ids.test.js
git commit -m "[AgentSandbox]: 容器裡的 platform_fix 讀不到意見回饋的附圖，掛載要知道這一組修正是哪幾張意見

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 3.3：自我檢測（規格 §8.3 攻擊實測）——探針、模組、端點、終端機腳本

**為什麼**：攻擊實測必須用**平台行程裡**的通行證清單、socket 與真的掛載解析才有意義，所以不是一支獨立腳本自己開容器，而是平台端點照正式路徑（`prepareSandboxRun`）開容器、把 command 換成探針，結束後再用同一張通行證驗 401。規格 §8.3 全部項目＋X20（宿主 loopback 8772 免密碼）＋R6-A（內部修正級查不到平台 DB）。

**Files:**
- Create: `scripts/agent-sandbox-probe.sh`
- Create: `app/server/lib/agent-sandbox-selftest.js`
- Modify: `app/server/admin-routes.js`（第 1 部 Task 1.3 的 `PUT /api/admin/agent-sandbox` 之後）
- Create: `scripts/verify-agent-sandbox.js`
- Test: `app/server/tests/agent-sandbox-selftest.test.js`

**Interfaces:**
- Consumes：`prepareSandboxRun`（第 2 部 2.5）、`profileFor`（1.1）、`getProjectInfo`／`worktreeParent`（既有）、`aiSocketPath`（1.8）、`ensureAgentInfra`（2.3）
- Produces：
  - 探針輸出協定：每行 `CHECK <name> PASS|FAIL <detail>`；另有 `TOKEN <token>`（僅供平台事後驗 401，不落地）
  - `EXPECTED_CHECKS: { project: string[], audit: string[] }`
  - `parseProbeOutput(stdout) → { checks: [{name, pass, detail}], token: string|null }`
  - `runSelftest({ projectId, taskDbId, otherProjectId }, deps?) → Promise<{ ok: boolean, checks: [{ name, pass, detail, phase }] }>`
  - HTTP：`POST /api/admin/agent-sandbox/selftest` body `{ project_id, task_id, other_project_id }`（平台管理員限定）→ 上面的結果
  - CLI：`AIDEV_ADMIN_JWT=<jwt> node scripts/verify-agent-sandbox.js <project_id> <task_id> <other_project_id>`；有任何 FAIL → exit 1

- [ ] **Step 1：寫探針腳本**（容器內執行；只用 bash、curl、claude；參數全走位置參數，因為容器 env 走白名單）

```bash
#!/usr/bin/env bash
# scripts/agent-sandbox-probe.sh — 子專案 0 自我檢測的容器內探針（由 lib/agent-sandbox-selftest.js 啟動）
# 用法：agent-sandbox-probe.sh <mode:project|audit> <appDir> <otherRoot> <ownGitDir|-> <ownSlug> <otherSlug> <hostTargets(空白分隔)>
# 輸出：CHECK <name> PASS|FAIL <detail>；TOKEN <token>
set -u
MODE="$1"; APP="$2"; OTHER_ROOT="$3"; OWN_GIT="$4"; OWN_SLUG="$5"; OTHER_SLUG="$6"; HOSTS="$7"
ok()  { echo "CHECK $1 PASS ${2:-}"; }
bad() { echo "CHECK $1 FAIL ${2:-}"; }
expect_fail() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name" "應失敗但成功：$*"; else ok "$name"; fi; }
expect_ok()   { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name" "應成功但失敗：$*"; fi; }
code() { curl -s -m 20 -o /dev/null -w '%{http_code}' "$@"; }

for k in APP_SECRET JWT_SECRET DATABASE_URL; do
  if [ -z "$(printenv "$k")" ]; then ok "env_no_$k"; else bad "env_no_$k" "有值"; fi
done
expect_fail read_platform_config cat "$APP/data/config.json"
expect_fail read_ai_socket_dir ls "$APP/data/run"
expect_fail read_other_project ls "$OTHER_ROOT"

for h in $HOSTS; do for p in 8771 8772 22 21000 5416; do
  expect_fail "tcp_blocked_${h}_${p}" timeout 3 bash -c "</dev/tcp/$h/$p"
done; done
expect_fail tcp_blocked_direct_internet timeout 5 bash -c '</dev/tcp/1.1.1.1/443'

c=$(code -x "$HTTPS_PROXY" https://api.anthropic.com/); [ "$c" != "000" ] && ok proxy_anthropic "$c" || bad proxy_anthropic "$c"
c=$(code -x "$HTTPS_PROXY" https://example.com/); [ "$c" = "000" ] && ok proxy_example_blocked || bad proxy_example_blocked "$c"

H="X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN"
if [ "$MODE" = project ]; then
  expect_fail write_git_config sh -c "echo '[core]' >> '$OWN_GIT/config'"
  expect_fail write_git_hooks touch "$OWN_GIT/hooks/aidev-probe"
  expect_ok write_git_objects sh -c "touch '$OWN_GIT/objects/aidev-probe' && rm -f '$OWN_GIT/objects/aidev-probe'"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/wiki/pages?project=$OWN_SLUG"); [ "$c" = 200 ] && ok ai_own_project "$c" || bad ai_own_project "$c"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/wiki/pages?project=$OTHER_SLUG"); [ "$c" = 403 ] && ok ai_other_project_403 "$c" || bad ai_other_project_403 "$c"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/db/connections?project=$OTHER_SLUG"); [ "$c" = 403 ] && ok ai_other_db_403 "$c" || bad ai_other_db_403 "$c"
  c=$(code -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT 1"}' "$AIDEV_AI_BASE/ai/platform/query"); [ "$c" = 403 ] && ok ai_platform_query_403 "$c" || bad ai_platform_query_403 "$c"
else
  expect_fail write_platform_worktree touch "$PWD/aidev-probe"
  body=$(curl -s -m 20 -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT COUNT(*) AS n FROM tasks"}' "$AIDEV_AI_BASE/ai/platform/query")
  echo "$body" | grep -q '"ok":true' && ok platform_query_ok || bad platform_query_ok "$body"
  body=$(curl -s -m 20 -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT password_hash FROM users LIMIT 1"}' "$AIDEV_AI_BASE/ai/platform/query")
  echo "$body" | grep -qi 'permission denied' && ok platform_query_sensitive_denied || bad platform_query_sensitive_denied "$body"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/db/connections"); [ "$c" = 403 ] && ok ai_internal_db_403 "$c" || bad ai_internal_db_403 "$c"
fi

out=$(echo "只回覆 PROBE-OK" | claude -p --output-format stream-json --verbose --dangerously-skip-permissions --strict-mcp-config --mcp-config "$APP/app/server/pipeline/mcp/none.json" 2>&1)
sid=$(echo "$out" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$out" | grep -q PROBE-OK && ok claude_run "$sid" || bad claude_run "$(echo "$out" | tail -1 | cut -c1-200)"
out=$(echo "只回覆 PROBE-RESUMED" | claude -p --output-format stream-json --verbose --dangerously-skip-permissions --strict-mcp-config --mcp-config "$APP/app/server/pipeline/mcp/none.json" --resume "$sid" 2>&1)
echo "$out" | grep -q PROBE-RESUMED && ok claude_resume || bad claude_resume "$(echo "$out" | tail -1 | cut -c1-200)"

echo "TOKEN $AIDEV_AI_TOKEN"
```
Run: `bash -n scripts/agent-sandbox-probe.sh && chmod +x scripts/agent-sandbox-probe.sh && git update-index --add --chmod=+x scripts/agent-sandbox-probe.sh`
Expected：無輸出（語法正確；rules/infra 151：Linux 上 index 要 100755）

- [ ] **Step 2：寫 selftest 的失敗測試**

```js
// app/server/tests/agent-sandbox-selftest.test.js
// 意圖：自我檢測的判讀本身不能出錯——探針漏報一項要算失敗（不是「沒 FAIL 就算過」）；
// 通行證必須在容器結束、release 之後才去驗 401；閘道沒記到被擋的網域也算失敗。
process.env.APP_SECRET = 'test-selftest';
const { EventEmitter } = require('events');
const st = require('../lib/agent-sandbox-selftest');

test('parseProbeOutput 解析 CHECK 與 TOKEN，忽略其他行', () => {
  const out = st.parseProbeOutput('noise\nCHECK a PASS\nCHECK b FAIL 應失敗但成功：x\nTOKEN v1.x\n');
  expect(out).toEqual({ checks: [{ name: 'a', pass: true, detail: '' }, { name: 'b', pass: false, detail: '應失敗但成功：x' }], token: 'v1.x' });
});

function fakeChild(lines) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { end: jest.fn(), on: jest.fn() };
  setImmediate(() => { c.stdout.emit('data', lines.join('\n') + '\n'); c.emit('close', 0); });
  return c;
}

function deps(over = {}) {
  const order = [];
  const HOSTS = ['127.0.0.1', '10.0.0.1'];
  const allPass = mode => [...st.EXPECTED_CHECKS[mode], ...HOSTS.flatMap(h => [8771, 8772, 22, 21000, 5416].map(p => `tcp_blocked_${h}_${p}`))]
    .map(n => `CHECK ${n} PASS`);
  return {
    order,
    d: {
      getProjectInfo: async id => ({ root: `/r/p${id}`, folder_name: `p${id}`, name: `p${id}`, repos: [{ local_path: `/r/p${id}/main` }] }),
      worktreeParent: (root, t) => `${root}/.worktrees/${t}`,
      query: async () => ({ rows: [{ task_id: 'task_1', project_id: 7 }] }),
      prepareSandboxRun: async ({ profile }) => ({
        argv: ['run', '-i', '--rm', 'aidev-agent:x', 'claude', '-p'], childEnv: {}, containerName: `c-${profile.scope}`, runId: 'r',
        kill: () => {}, release: async () => { order.push('release'); },
      }),
      ensureAgentInfra: async () => ({ image: 'aidev-agent:x', gatewayHost: 'odoo-v2-gw', network: 'odoo-v2-agent-net', instanceId: 'odoo-v2' }),
      hostTargets: async () => ['127.0.0.1', '10.0.0.1'],
      spawn: (cmd, argv) => { order.push('spawn'); return fakeChild([...allPass(argv.includes('audit') ? 'audit' : 'project'), 'TOKEN tok']); },
      checkTokenRevoked: async () => { order.push('check401'); return 401; },
      gatewayLogsSince: async () => '{"type":"deny","dest":"example.com:443"}',
      probePath: '/app/scripts/agent-sandbox-probe.sh',
      ...over,
    },
  };
}

test('全部通過 → ok，而且 401 檢查在 release 之後', async () => {
  const { d, order } = deps();
  const r = await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  expect(r.ok).toBe(true);
  expect(r.checks.filter(c => c.name === 'token_revoked_401').length).toBe(2);
  expect(order.indexOf('release')).toBeLessThan(order.indexOf('check401'));
});

test('探針少回報一項 → 該項算 FAIL', async () => {
  const { d } = deps({ spawn: () => fakeChild(['CHECK env_no_APP_SECRET PASS', 'TOKEN tok']) });
  const r = await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  expect(r.ok).toBe(false);
  expect(r.checks).toContainEqual(expect.objectContaining({ name: 'tcp_blocked_127.0.0.1_8772', pass: false, detail: expect.stringMatching(/沒有回報/) }));
});

test('結束後通行證仍然有效（非 401）→ FAIL', async () => {
  const { d } = deps({ checkTokenRevoked: async () => 200 });
  const r = await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  expect(r.ok).toBe(false);
});

test('閘道 log 沒有 example.com 的拒絕紀錄 → FAIL', async () => {
  const { d } = deps({ gatewayLogsSince: async () => '' });
  const r = await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  expect(r.checks).toContainEqual(expect.objectContaining({ name: 'gateway_logged_deny', pass: false }));
});

test('探針命令替換 claude，並把探針腳本唯讀掛進去', async () => {
  const seen = [];
  const { d } = deps({ spawn: (cmd, argv) => { seen.push(argv); return fakeChild(['TOKEN t']); } });
  await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  const argv = seen[0];
  const i = argv.indexOf('aidev-agent:x');
  expect(argv.slice(i + 1, i + 4)).toEqual(['bash', '/app/scripts/agent-sandbox-probe.sh', 'project']);
  expect(argv).toContain('type=bind,source=/app/scripts/agent-sandbox-probe.sh,target=/app/scripts/agent-sandbox-probe.sh,readonly');
  expect(argv).not.toContain('claude');
});

test('同一個專案當「別的專案」→ 丟例外（驗不出跨專案）', async () => {
  await expect(st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 7 }, deps().d)).rejects.toThrow();
});
```

- [ ] **Step 3：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-sandbox-selftest.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-sandbox-selftest'`

- [ ] **Step 4：實作 selftest 模組**

```js
// app/server/lib/agent-sandbox-selftest.js
/**
 * agent-sandbox-selftest.js — 子專案 0 規格 §8.3 攻擊實測，在平台行程內照正式路徑開真容器。
 * 兩輪：project（coding profile＋測試任務 worktree）與 audit（workflow_health profile＋乾淨 worktree）。
 * 判讀規則：探針「沒回報」的項目一律算失敗；通行證在 release 之後才驗 401；閘道必須記到 example.com 被擋。
 * 會花極少量 token（每輪一次 claude -p＋一次 --resume）。
 */
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, spawn: realSpawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const PORTS = [8771, 8772, 22, 21000, 5416];
const COMMON = ['env_no_APP_SECRET', 'env_no_JWT_SECRET', 'env_no_DATABASE_URL', 'read_platform_config', 'read_ai_socket_dir',
  'read_other_project', 'tcp_blocked_direct_internet', 'proxy_anthropic', 'proxy_example_blocked', 'claude_run', 'claude_resume'];
const EXPECTED_CHECKS = {
  project: [...COMMON, 'write_git_config', 'write_git_hooks', 'write_git_objects', 'ai_own_project', 'ai_other_project_403', 'ai_other_db_403', 'ai_platform_query_403'],
  audit: [...COMMON, 'write_platform_worktree', 'platform_query_ok', 'platform_query_sensitive_denied', 'ai_internal_db_403'],
};

function parseProbeOutput(stdout) {
  const checks = []; let token = null;
  for (const line of String(stdout || '').split('\n')) {
    const m = /^CHECK (\S+) (PASS|FAIL) ?(.*)$/.exec(line);
    if (m) checks.push({ name: m[1], pass: m[2] === 'PASS', detail: m[3] || '' });
    const t = /^TOKEN (\S+)$/.exec(line);
    if (t) token = t[1];
  }
  return { checks, token };
}

function defaultHostTargets() {
  const d0 = new Promise(resolve => execFile('docker', ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
    (err, out) => resolve(err ? null : String(out).trim())));
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  return d0.then(g => [...new Set(['127.0.0.1', 'host.docker.internal', g, lan && lan.address].filter(Boolean))]);
}

function defaultCheckTokenRevoked(token) {
  const { aiSocketPath } = require('./ai-socket-server');
  return new Promise(resolve => {
    const req = http.request({ socketPath: aiSocketPath(), path: '/ai/glossary?version=19&q=order', headers: { 'x-aidev-ai-token': token } },
      res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.end();
  });
}

function defaultGatewayLogsSince(gateway, sinceIso) {
  return new Promise(resolve => execFile('docker', ['logs', '--since', sinceIso, gateway], { maxBuffer: 4 * 1024 * 1024 },
    (err, out, errOut) => resolve(`${out || ''}${errOut || ''}`)));
}

async function runOnce(mode, ctx, d) {
  const { profileFor } = require('./agent-profiles');
  const profile = profileFor(mode === 'project' ? 'coding' : 'workflow_health');
  const opts = mode === 'project'
    ? { agentType: 'coding', taskId: ctx.taskDbId, cwd: ctx.worktree, projectId: ctx.projectId, timeoutMs: 300000 }
    : { agentType: 'workflow_health', timeoutMs: 300000 };
  const claudeArgs = ['-p', '--strict-mcp-config', '--mcp-config', path.join(APP_DIR, 'app', 'server', 'pipeline', 'mcp', 'none.json')];
  const run = await d.prepareSandboxRun({ claudeArgs, opts, profile, projectId: mode === 'project' ? ctx.projectId : null });
  const infra = await d.ensureAgentInfra();
  const i = run.argv.lastIndexOf(infra.image);
  const argv = [
    ...run.argv.slice(0, i),
    '--mount', `type=bind,source=${d.probePath},target=${d.probePath},readonly`,
    infra.image, 'bash', d.probePath, mode, APP_DIR, ctx.otherRoot, mode === 'project' ? ctx.ownGitDir : '-',
    ctx.ownSlug, ctx.otherSlug, ctx.hosts.join(' '),
  ];
  let stdout = '';
  try {
    await new Promise((resolve, reject) => {
      const child = d.spawn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'], env: run.childEnv });
      const timer = setTimeout(() => { run.kill(); reject(new Error('自我檢測逾時（5 分鐘）')); }, 300000);
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', () => {});
      child.on('close', () => { clearTimeout(timer); resolve(); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.stdin.end();
    });
  } finally {
    await run.release();
  }
  const { checks, token } = parseProbeOutput(stdout);
  const byName = new Map(checks.map(c => [c.name, c]));
  const out = [];
  const expected = [...EXPECTED_CHECKS[mode], ...ctx.hosts.flatMap(h => PORTS.map(p => `tcp_blocked_${h}_${p}`))];
  for (const name of expected) out.push(byName.get(name) || { name, pass: false, detail: '探針沒有回報這一項' });
  const status = token ? await d.checkTokenRevoked(token) : 0;
  out.push({ name: 'token_revoked_401', pass: status === 401, detail: `HTTP ${status}` });
  return out.map(c => ({ ...c, phase: mode }));
}

async function runSelftest({ projectId, taskDbId, otherProjectId }, deps = {}) {
  const d = {
    getProjectInfo: (...a) => require('../pipeline/task-agent').getProjectInfo(...a),
    worktreeParent: (...a) => require('../pipeline/task-agent').worktreeParent(...a),
    query: (...a) => require('../db').query(...a),
    prepareSandboxRun: (...a) => require('../pipeline/sandbox-run').prepareSandboxRun(...a),
    ensureAgentInfra: (...a) => require('./agent-infra').ensureAgentInfra(...a),
    hostTargets: defaultHostTargets, spawn: realSpawn,
    checkTokenRevoked: defaultCheckTokenRevoked, gatewayLogsSince: defaultGatewayLogsSince,
    probePath: path.join(APP_DIR, 'scripts', 'agent-sandbox-probe.sh'),
    ...deps,
  };
  if (!projectId || !taskDbId || !otherProjectId || Number(projectId) === Number(otherProjectId)) {
    throw Object.assign(new Error('需要 project_id、task_id，以及「另一個」專案的 other_project_id'), { statusCode: 400 });
  }
  const since = new Date().toISOString();
  const own = await d.getProjectInfo(Number(projectId));
  const other = await d.getProjectInfo(Number(otherProjectId));
  if (!own || !other) throw Object.assign(new Error('專案不存在或沒有 clone 完成的 repo'), { statusCode: 400 });
  const { rows: [t] } = await d.query('SELECT task_id, project_id FROM tasks WHERE id=$1', [Number(taskDbId)]);
  if (!t || Number(t.project_id) !== Number(projectId)) throw Object.assign(new Error('task_id 不屬於 project_id'), { statusCode: 400 });
  const ctx = {
    projectId: Number(projectId), taskDbId: Number(taskDbId),
    worktree: d.worktreeParent(own.root, t.task_id),
    ownGitDir: path.join(own.repos[0].local_path, '.git'),
    ownSlug: own.folder_name || own.name, otherSlug: other.folder_name || other.name, otherRoot: other.root,
    hosts: await d.hostTargets(),
  };
  const checks = [...await runOnce('project', ctx, d), ...await runOnce('audit', ctx, d)];
  const infra = await d.ensureAgentInfra();
  const logs = await d.gatewayLogsSince(infra.gatewayHost, since);
  checks.push({ name: 'gateway_logged_deny', pass: /"type":"deny","dest":"example\.com:443"/.test(logs), detail: '', phase: 'gateway' });
  return { ok: checks.every(c => c.pass), checks };
}

module.exports = { EXPECTED_CHECKS, parseProbeOutput, runSelftest };
```

- [ ] **Step 5：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-sandbox-selftest.test.js`
Expected：PASS

- [ ] **Step 6：管理員端點**（`admin-routes.js`，`PUT /api/admin/agent-sandbox` 之後；會開真容器、花少量 token，所以只給平台管理員）

```js
  // 子專案 0 規格 §8.3：在正式平台上以真容器跑攻擊實測。約 1–3 分鐘；只對測試專案跑（開發順序 §2.1）。
  app.post('/api/admin/agent-sandbox/selftest', ...auth, async (req, res) => {
    const b = req.body || {};
    try {
      const r = await require('./lib/agent-sandbox-selftest').runSelftest({ projectId: b.project_id, taskDbId: b.task_id, otherProjectId: b.other_project_id });
      console.log(`[AGENT-SANDBOX] 自我檢測（管理員 ${req.userId}）：${r.ok ? '全部通過' : `未通過 ${r.checks.filter(c => !c.pass).map(c => c.name).join(', ')}`}`);
      res.json(r);
    } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
  });
```

- [ ] **Step 7：終端機腳本**（只用 node 內建模組；rules/infra 113）

```js
#!/usr/bin/env node
// scripts/verify-agent-sandbox.js — 觸發平台的 AI 容器自我檢測並判讀（子專案 0 §8.3）
// 用法：AIDEV_ADMIN_JWT=<平台管理員 JWT> node scripts/verify-agent-sandbox.js <project_id> <task_id> <other_project_id>
// 埠：env PORT，否則讀 data/config.json 的 PORT，否則 3939。有任何一項未通過 → exit 1。
const fs = require('fs');
const path = require('path');
const http = require('http');

const [projectId, taskId, otherProjectId] = process.argv.slice(2).map(Number);
const jwt = process.env.AIDEV_ADMIN_JWT;
if (!projectId || !taskId || !otherProjectId || !jwt) {
  console.error('用法：AIDEV_ADMIN_JWT=<jwt> node scripts/verify-agent-sandbox.js <project_id> <task_id> <other_project_id>');
  process.exit(2);
}
let port = process.env.PORT;
if (!port) { try { port = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8')).PORT; } catch { port = null; } }
port = port || 3939;

const body = JSON.stringify({ project_id: projectId, task_id: taskId, other_project_id: otherProjectId });
const req = http.request({ host: '127.0.0.1', port, path: '/api/admin/agent-sandbox/selftest', method: 'POST', timeout: 600000,
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${jwt}` } }, res => {
  let raw = '';
  res.on('data', c => { raw += c; });
  res.on('end', () => {
    let r;
    try { r = JSON.parse(raw); } catch { console.error(`HTTP ${res.statusCode}：${raw.slice(0, 500)}`); process.exit(1); }
    if (res.statusCode !== 200) { console.error(`HTTP ${res.statusCode}：${r.error}`); process.exit(1); }
    for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  [${c.phase}] ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
    const failed = r.checks.filter(c => !c.pass).length;
    console.log(r.ok ? `\n全部 ${r.checks.length} 項通過` : `\n${failed} 項未通過`);
    process.exit(r.ok ? 0 : 1);
  });
});
req.on('timeout', () => { console.error('逾時（10 分鐘）'); req.destroy(); process.exit(1); });
req.on('error', e => { console.error(`連線失敗：${e.message}`); process.exit(1); });
req.end(body);
```
Run: `node --check scripts/verify-agent-sandbox.js && echo ok`
Expected：`ok`

- [ ] **Step 8：Commit**

```bash
git add scripts/agent-sandbox-probe.sh scripts/verify-agent-sandbox.js app/server/lib/agent-sandbox-selftest.js app/server/admin-routes.js app/server/tests/agent-sandbox-selftest.test.js
git commit -m "[AgentSandbox]: 隔離有沒有真的關好只能在正式平台開真容器驗，切換前必須能一鍵跑完規格的攻擊實測並判讀

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 3.4：整枝審查＋合併進 master（開關 off）→ 交接重啟批次 R-A

**為什麼**：rules/infra 156——逐 task 審查看不到跨檔一致性（旗標蒸發、介面名不一致、漏改消費端）。合併前做一次整枝審查；合併後開關仍 `off`，正式平台行為不變（開發順序 1.3）。

**Files:** 無程式變更（審查發現的問題回到對應 Task 修）

- [ ] **Step 1：併最新 master、全跑**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox && git fetch origin && git merge origin/master
cd app && npm run test:quiet > /tmp/claude-t34.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-t34.txt
grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-t34.txt
```
Expected：相對 Task 0 基線只多不少、無新紅燈（新紅燈先當自己造成，rules/always 2）

- [ ] **Step 2：整枝審查清單**（逐項執行並記結果；diff 基底一律用剛 fetch 的 `origin/master`，不用本地 main——記憶 task-diff-three-dot-stale-main）

```bash
B=origin/master
git diff --stat $B...HEAD
# a. app 程式碼沒有寫死宿主路徑（測試檔的暫存路徑除外）
git diff $B...HEAD -- app/server ':!app/server/tests' | grep -n '^+.*/home/odoo' || echo "a-ok"
# b. 每個 /ai 路由都掛了群組檢查
grep -rn "app\.\(get\|post\)('/ai/" app/server --include=*.js | grep -v tests/ | grep -v requireAiEndpoint || echo "b-ok"
# c. 所有字面 agentType 都已登記（Task 2.9 的守衛也在全跑裡）
cd app && npx jest server/tests/sandbox-callsites.test.js server/tests/skills-sync.test.js && cd ..
# d. 開關預設 off、未知值 all（Task 1.3 測試）；off 路徑的 claude-runner 既有測試全綠（Task 2.6 Step 4）
# e. .gitignore 三行都在
grep -nE '^/data/run/$|^/data/agent-home/$|context7\.sandbox\.local\.json' .gitignore
# f. 探針腳本在 index 是 100755
git ls-files -s scripts/agent-sandbox-probe.sh
```
Expected：`a-ok`、`b-ok`、c 全 PASS、e 三行、f 開頭 `100755`。另外用 superpowers:requesting-code-review 對整條分支做一次審查，重點：`runClaude` 的 off 路徑 diff 是否只有搬移（`git diff $B...HEAD -- app/server/pipeline/claude-runner.js`）、`prepareSandboxRun` 每個失敗分支是否都作廢通行證、`/ai/db/connections` 帶 project 參數時 project scope 是否一定以 `p.id` 覆寫。

- [ ] **Step 3：推分支並請使用者核准合併**（用 pushRepo skill；**合併進 master 前停下來問**——夜間改善會以新的 master 為基底）

- [ ] **Step 4：合併後在主 clone 確認開關預設值會是 off**（還沒重啟，只看碼）

```bash
cd /home/odoo/odoo-v2 && git log --oneline -1 origin/master && git show origin/master:app/server/db.js | grep -n "agent_sandbox_mode"
```
Expected：`DEFAULT 'off'`

- [ ] **Step 5：交接 R-A**：執行者**停手**，回報使用者以下內容後結束本 session：
  - 已合併的 commit 範圍、全跑結果
  - 重啟後生效的東西：socket listener、唯讀角色建立、git 加固、孤兒容器清理（此時不會有任何 AI 容器）、開關欄位（值 off）
  - 請使用者在**沒有任何 Claude session 在跑時**執行本檔「重啟批次」段的共同檢查＋`upgrade.sh`，重啟後重開正在跑的測試區
  - 重啟後開新 session，從 Task 3.5 接續

---

## Task 3.5：R-A 重啟後——舊行為不變、唯讀角色、映像檔

**Files:** 無程式變更

- [ ] **Step 1：開關是 off、socket 在、權限對**

```bash
cd /home/odoo/odoo-v2
curl -s -H "Authorization: Bearer $AIDEV_ADMIN_JWT" http://localhost:8771/api/admin/agent-sandbox
stat -c '%a %U %n' data/run data/run/ai.sock
```
Expected：`"mode":"off"`；`700 odoo data/run`、`600 odoo data/run/ai.sock`

- [ ] **Step 2：舊路徑的 AI 照常**：挑一個專案的對話問一句簡單問題；確認有回覆、`token_usage` 多一列：

```bash
node .claude/skills/platformDB/query.js "SELECT agent_type, status, recorded_at FROM token_usage ORDER BY id DESC LIMIT 3"
```
Expected：最新一列 `chat`／`completed`

同一步驟另外確認考試系統（第 2 部 Task 2.11 Step 6）：到考試頁對一張既有截圖按「重新審查」，要有審查結果、畫面沒有「Not logged in」。認證失敗 → 照 Task 2.11 Step 6 的說明補 `getClaudeAuthEnv()` 並回報（需改碼時走重啟批次 R-B）。

- [ ] **Step 3：唯讀角色已建、遮蔽生效**

```bash
node .claude/skills/platformDB/query.js "SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname='aidev_ai_ro'"
node .claude/skills/platformDB/query.js "SELECT COUNT(*) FROM information_schema.column_privileges WHERE grantee='aidev_ai_ro' AND column_name IN ('password_hash','github_pat_enc','claude_oauth_token_enc','sso_secret','e2e_password')"
node .claude/skills/platformDB/query.js "SELECT has_database_privilege('aidev_ai_ro', current_database(), 'CONNECT') AS can_connect"
```
Expected：`rolsuper=false, rolcanlogin=true`；遮蔽欄位授權數 `0`；`can_connect=true`（X19：2c 的 REVOKE FROM PUBLIC 之後仍連得上）

- [ ] **Step 4：跑第 1 部 Task M3 Step 3**（bridge 丟棄式容器驗密碼、權限、`set_config('role')`）。任何一項不符 → 停下來回報，後續不開 `internal`（健檢要查 DB）。

- [ ] **Step 5：映像檔在**（第 2 部 Task 2.1 若在 R-A 前已 build 就只確認）

```bash
docker image inspect "aidev-agent:$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')" --format '{{.Id}}'
```
Expected：印出 id；不存在 → 照第 2 部 Task 2.1 Step 2 build

---

## Task M10（量測＋開發順序 1.2）：資源上限暫定值 → 自我檢測全過

**前置**：Task 3.5 全過；待決 Q5（測試專案）已由使用者指定。自我檢測要：一個**測試專案**的 `project_id`、該專案一張**已建好任務 worktree** 的 `task_id`（`.worktrees/<task_id>` 存在）、另一個專案的 `other_project_id`（只讀它的路徑名，不會碰它的資料）。

- [ ] **Step 1：由第 2 部 M8 峰值訂 AI 容器暫定上限**（規則寫死、不臨場猜：記憶體＝峰值×1.5 向上取整到 GiB；pids＝峰值×2 向上取整到 64 的倍數；cpus＝M8 期間 `CPUPerc` 峰值÷100×1.5 向上取整，至少 1）。閘道暫定 `256m／0.5／128`，Step 4 驗證。

```bash
cd /home/odoo/odoo-v2
set_flag '{"mode":"off","project_ids":[],"memory":"<依規則算出，例 6g>","cpus":"<依規則>","pids":<依規則>,"gateway_memory":"256m","gateway_cpus":"0.5","gateway_pids":128}'
```
（`<依規則…>` 由執行者用 M8 記下的數字代入上式計算後填；把算式與結果記進 M1 表檔「M10」段。）
Expected：回傳 `mode:"off"` 與剛設的上限

- [ ] **Step 2：取測試資料的 id**

```bash
node .claude/skills/platformDB/query.js "SELECT t.id, t.task_id, p.id AS project_id, p.folder_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.id=1 ORDER BY t.id DESC LIMIT 5"
ls /home/odoo/odoo-v2/repos/*/.worktrees/ | head
```

- [ ] **Step 3：跑自我檢測，同時取樣閘道資源**

```bash
( while sleep 2; do docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}} {{.PIDs}}' odoo-v2-gw 2>/dev/null; done ) > /tmp/claude-m10-gw.txt &
S=$!
AIDEV_ADMIN_JWT="$AIDEV_ADMIN_JWT" node scripts/verify-agent-sandbox.js <project_id> <task_id> <other_project_id> > /tmp/claude-m10.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m10.txt
kill $S; cat /tmp/claude-m10.txt; sort -h /tmp/claude-m10-gw.txt | tail -2
```
Expected：`EXITCODE=0`、`全部 N 項通過`。**特別確認** `tcp_blocked_127.0.0.1_8772`、`tcp_blocked_<docker0>_8772` 為 PASS（X20）。

- [ ] **Step 4：判定**
  - 任一 FAIL → 停下來回報，開關維持 off；需要改碼 → 走重啟批次 R-B
  - 閘道記憶體峰值超過暫定上限的 50% → 把 `gateway_memory` 調成峰值×2（向上取整到 64m）並重跑 Step 3
  - 全過 → 記錄日期與結果，進 Task 3.6

---
## Task 3.6（開發順序 1.4）：開關 `internal`——只有健檢與夜間改善進容器

**前置**：M10 全過；Q2 已裁決（或接受預設）。**不需要重啟。**

**影響**：只影響 `workflow_health`、`platform_fix`、`fix_verify`、`fix_review`、`feedback_merge`；所有客戶 agent 照舊。夜間改善自動合併維持不變（R6）。

- [ ] **Step 1：打開並記下分界時間**

```bash
set_flag '{"mode":"internal"}'
node /home/odoo/odoo-v2/.claude/skills/platformDB/query.js "SELECT NOW() AS internal_on_at"
```
把 `internal_on_at` 記進 M1 表檔「3.6」段（之後比對用，`agent_sandbox_changed_at` 會被後續每次 PUT 蓋掉，不可依賴）。

- [ ] **Step 2：手動跑一次健檢，觀察容器**：到健檢頁按「開始健檢」（等同 `POST /api/admin/health-check`），同時：

```bash
watch -n 5 "docker ps --filter label=aidev.instance=odoo-v2 --format '{{.Names}} {{.Label \"aidev.scope\"}} {{.Status}}'"
```
Expected：出現 `odoo-v2-run-<16 hex>`、scope `internal-audit`；健檢結束後消失

- [ ] **Step 3：健檢結果與副作用**

```bash
cd /home/odoo/odoo-v2
node .claude/skills/platformDB/query.js "SELECT agent_type, status, duration_ms, error_message FROM token_usage WHERE agent_type='workflow_health' AND recorded_at >= '<internal_on_at>' ORDER BY id DESC LIMIT 3"
node .claude/skills/platformDB/query.js "SELECT id, status, severity, LEFT(title,60) t FROM health_check_findings WHERE created_at >= '<internal_on_at>' ORDER BY id DESC LIMIT 10"
ls .claude/worktrees | grep '^ro-' || echo no-ro-left
docker logs --since '<internal_on_at>' odoo-v2-gw 2>&1 | grep '"type":"deny"' | head
```
Expected：`workflow_health` 為 `completed`；有提案（或明確「無提案」）；`no-ro-left`；deny 若有，逐筆看目的地——健檢不該連任何白名單外的網域，有的話記下回報

- [ ] **Step 4：等一個夜間批次**（22:00 健檢 → 改善 → 合併 → 重啟；隔天早上查）

```bash
node .claude/skills/platformDB/query.js "SELECT agent_type, status, COUNT(*) n FROM token_usage WHERE agent_type IN ('workflow_health','platform_fix','fix_verify','fix_review','feedback_merge') AND recorded_at >= '<internal_on_at>' GROUP BY 1,2 ORDER BY 1,2"
node .claude/skills/platformDB/query.js "SELECT status, COUNT(*) FROM finding_fixes WHERE created_at >= '<internal_on_at>' GROUP BY 1"
node .claude/skills/platformDB/query.js "SELECT agent_type, COUNT(*) FILTER (WHERE status<>'completed') failed, COUNT(*) total FROM token_usage WHERE agent_type IN ('platform_fix','fix_verify','fix_review') AND recorded_at BETWEEN '<internal_on_at>'::timestamptz - INTERVAL '14 days' AND '<internal_on_at>' GROUP BY 1"
```
Expected：容器後的失敗率不高於前 14 天；`platform_fix` 的輸出裡紅燈與 M8 記下的「容器內跑不起來的測試」清單一致（Task 3.2 Step 5）。

- [ ] **Step 5：判定**
  - 正常 → 進 Task 3.7
  - 異常 → `set_flag '{"mode":"off"}'`（**立即恢復，不需要重啟**），記下症狀回報；要改碼走 R-B

---

## Task 3.7（規格 §9 第 4 步）：複製既有 session 檔

**前置**：Task 3.6 正常。在打開任何客戶 agent 之前做。**不需要重啟。**

- [ ] **Step 1：先驗「複製過去的 session 換 cwd 後續接得起來」**（第 2 部 Task 2.16 的前提；只拿一個 chat session 驗）

```bash
cd /home/odoo/odoo-v2
SID=$(node .claude/skills/platformDB/query.js --json "SELECT chat_session_id FROM project_chats WHERE chat_session_id IS NOT NULL ORDER BY id DESC LIMIT 1" | grep -o '"chat_session_id": "[^"]*"' | cut -d'"' -f4)
T=$(mktemp -d); mkdir -p "$T/cwd" "$T/home/.claude/projects/$(echo "$T/cwd" | sed 's/[^a-zA-Z0-9]/-/g')"
cp "/home/odoo/.claude/projects/-home-odoo-odoo-v2/$SID.jsonl" "$T/home/.claude/projects/$(echo "$T/cwd" | sed 's/[^a-zA-Z0-9]/-/g')/"
export CLAUDE_CODE_OAUTH_TOKEN="$(cd app/server && DATABASE_URL="$(node -p "require('/home/odoo/odoo-v2/data/config.json').DATABASE_URL")" APP_SECRET="$(node -p "require('/home/odoo/odoo-v2/data/config.json').APP_SECRET")" node -e "const a=require('./lib/claude-auth');a.loadClaudeToken().then(()=>{process.stdout.write(a.getClaudeAuthEnv().CLAUDE_CODE_OAUTH_TOKEN||'');process.exit(0)})")"
( cd "$T/cwd" && echo "只回覆 COPIED-RESUME-OK" | HOME="$T/home" claude -p --output-format stream-json --verbose --resume "$SID" > "$T/out" 2>&1; echo "EXITCODE=$?" >> "$T/out" )
grep -c COPIED-RESUME-OK "$T/out"; tail -2 "$T/out"; unset CLAUDE_CODE_OAUTH_TOKEN; rm -rf "$T"
```
Expected：`EXITCODE=0` 且有 `COPIED-RESUME-OK`。**失敗 → 不做 Step 2**（複製沒有用），直接進 3.8，並回報「切換後每個續接中的任務與對話第一輪會 fresh 重跑一次」。

- [ ] **Step 2：列計畫、再套用**

```bash
cd /home/odoo/odoo-v2
export DATABASE_URL="$(node -p "require('/home/odoo/odoo-v2/data/config.json').DATABASE_URL")"
node tools/copy-agent-sessions.js
node tools/copy-agent-sessions.js --apply
unset DATABASE_URL
du -sh data/agent-home
```
Expected：`結果：{ copied: N, skipped: 0 }`；記下 `du` 容量進 M1 表檔「3.7」段

---

## Task 3.8（開發順序 1.5）：開關 `projects`——只開測試專案，逐類試跑

**前置**：Task 3.7 完成；Q5 的測試專案 id。**不需要重啟。**

- [ ] **Step 1：打開、記分界、開始取樣資源**

```bash
set_flag '{"mode":"projects","project_ids":[1]}'
node /home/odoo/odoo-v2/.claude/skills/platformDB/query.js "SELECT NOW() AS projects_on_at"
( while sleep 2; do ids=$(docker ps -q --filter label=aidev.run=1 --filter label=aidev.instance=odoo-v2); [ -n "$ids" ] && docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}} {{.PIDs}}' $ids; done ) >> /home/odoo/odoo-v2/data/logs/agent-sandbox-stats.log 2>/dev/null &
echo $! > /tmp/claude-38-sampler.pid
```
把 `projects_on_at` 記進 M1 表檔「3.8」段。

- [ ] **Step 2：逐類觸發，每類確認「有進容器、成功、結果合理」**（全部在測試專案上做）

| 觸發方式 | 會跑到的 agentType | 通過條件 |
|---|---|---|
| 測試專案開新對話，問一個需要查正式區 DB 或 wiki 的問題 | `chat`、`chat-title` | 有回覆；回覆有實際查到的內容（證明 getSQL／wikiQuery skill 在容器內可用，X9） |
| 同一場對話按「轉任務」 | `chat-to-task` | 產出任務草稿 |
| 建一張小需求任務，讓它從分流一路跑到 QA | `cs`、`analysis`、（有澄清時）`respec`、`spec_tour`（若專案有開）、`coding`、`qa` | 每關 `completed`；coding 有 commit；QA 有判定 |
| 對那張任務按一次退回（寫一句具體修正） | `reject_classify`、`reject_triage`、`coding`、`qa` | 分診判定合理、重跑成功 |
| 讓它走到部署；部署若失敗 | `deploy_fix` | 分類結果合理 |
| 測試專案 wiki 某頁按「⟳ 更新」 | `wiki` | 頁面更新 |
| （若能製造）合併衝突 | `merge`、`merge-explain` | 產出建議 |

每類觸發後：
```bash
cd /home/odoo/odoo-v2
node .claude/skills/platformDB/query.js "SELECT agent_type, status, resumed, duration_ms, LEFT(COALESCE(error_message,''),120) err FROM token_usage WHERE project_id=1 AND recorded_at >= '<projects_on_at>' ORDER BY id DESC LIMIT 15"
docker logs --since '<projects_on_at>' odoo-v2-gw 2>&1 | grep '"type":"deny"' | sort | uniq -c
```

- [ ] **Step 3：確認清單外的專案照舊不進容器**：任一其他專案有 AI 執行時 `docker ps --filter label=aidev.run=1` 不應出現它（scope label 只會是 `project-1` 或 `internal-*`）。

- [ ] **Step 4：判定**：任何一類失敗或結果明顯變差 → `set_flag '{"mode":"internal"}'` 退回、記症狀回報；需改碼走 R-B。全部通過 → 保持 `projects`，進 M11。

---
## Task M11（量測，開發順序 1.5／規格 §8.4）：容器內外比對

**為什麼**：規格 §7——容器裡沒有使用者層外掛（superpowers 等）、`~/.claude/CLAUDE.md`、RTK hook，token 用量與輸出風格可能改變；只看「有沒有成功」不夠。

- [ ] **Step 1：同一個測試專案，分界前 30 天 vs 分界後**（`<projects_on_at>` 用 Task 3.8 記下的值）

```bash
cd /home/odoo/odoo-v2
node .claude/skills/platformDB/query.js "
SELECT agent_type,
       (recorded_at >= '<projects_on_at>') AS in_container,
       COUNT(*) AS n,
       ROUND(AVG(output_tokens)) AS avg_out,
       ROUND(AVG(input_tokens + cache_read_tokens + cache_create_tokens)) AS avg_ctx,
       ROUND(AVG(cache_create_tokens)) AS avg_cache_create,
       ROUND((AVG(duration_ms)/1000.0)::numeric, 1) AS avg_sec,
       COUNT(*) FILTER (WHERE status <> 'completed') AS not_completed,
       COUNT(*) FILTER (WHERE resumed) AS resumed
  FROM token_usage
 WHERE project_id = 1
   AND recorded_at >= '<projects_on_at>'::timestamptz - INTERVAL '30 days'
 GROUP BY 1, 2
 ORDER BY 1, 2"
```

- [ ] **Step 2：失敗原因分布（只看容器內）**

```bash
node .claude/skills/platformDB/query.js "SELECT agent_type, status, LEFT(COALESCE(error_message,''),100) err, COUNT(*) FROM token_usage WHERE project_id=1 AND recorded_at >= '<projects_on_at>' AND status<>'completed' GROUP BY 1,2,3 ORDER BY 4 DESC"
```

- [ ] **Step 3：結果品質抽樣**：Task 3.8 跑出來的那張任務，人工看規格（`analysis_yaml`）、coding diff、QA 判定是否與同類舊任務相當；對話回覆是否仍會引用實查結果（`檔案:行號`、SQL 結果）。

- [ ] **Step 4：記錄與判定**：結果表貼進 M1 表檔「M11」段。下列任一成立 → **回報使用者，由使用者決定是否繼續**（不自行調 prompt，rules/agent-prompt 與健檢判準見 healthCheck skill）：
  - 某 agentType 容器內 `not_completed` > 0 而容器外為 0
  - `avg_out` 或 `avg_ctx` 差距超過 ±30%
  - `avg_sec` 增加超過 50%
  - 對話回覆不再查證（抽樣看到憑印象回答）

---

## Task 3.9（開發順序 1.5）：依試跑實測重訂 AI 容器資源上限

**前置**：Task 3.8 期間的取樣檔 `data/logs/agent-sandbox-stats.log` 至少涵蓋一次 coding＋qa。**不需要重啟。**

- [ ] **Step 1：算峰值**

```bash
node -e '
const fs = require("fs");
const toMiB = s => { const m = /([\d.]+)\s*(KiB|MiB|GiB|B)/.exec(s); if (!m) return 0; const v = parseFloat(m[1]); return { B: v/1048576, KiB: v/1024, MiB: v, GiB: v*1024 }[m[2]]; };
let mem = 0, cpu = 0, pids = 0;
for (const line of fs.readFileSync("/home/odoo/odoo-v2/data/logs/agent-sandbox-stats.log", "utf8").split("\n")) {
  const m = /^(\S+) (.+?) \/ .+? ([\d.]+)% (\d+)$/.exec(line.trim());
  if (!m) continue;
  mem = Math.max(mem, toMiB(m[2])); cpu = Math.max(cpu, parseFloat(m[3])); pids = Math.max(pids, parseInt(m[4], 10));
}
const memG = Math.ceil(mem * 1.5 / 1024), cpus = Math.max(1, Math.ceil(cpu / 100 * 1.5)), pidLim = Math.ceil(pids * 2 / 64) * 64;
console.log(JSON.stringify({ peak: { memMiB: Math.round(mem), cpuPct: cpu, pids }, proposed: { memory: `${memG}g`, cpus: String(cpus), pids: pidLim } }));
'
```
（規則與 M10 相同：記憶體×1.5 向上取整 GiB、cpus＝峰值÷100×1.5 向上取整至少 1、pids×2 向上取整到 64 的倍數。）

- [ ] **Step 2：與 M10 暫定值比較後寫入**

```bash
set_flag '{"memory":"<proposed.memory>","cpus":"<proposed.cpus>","pids":<proposed.pids>}'
```
把 peak、proposed、實際寫入值記進 M1 表檔「3.9」段。若 proposed 的記憶體 × 開發順序的同時執行上限（runner 併發設定）超過主機可用記憶體（開發順序 §2.4：約 140 GB）的一半 → 回報使用者（要壓併發或壓上限），不自行決定。

---

## Task 3.10（開發順序 1.6）：開關 `all`——開給全部 AI

**前置**：M11 無待處理的回報（或使用者已同意繼續）；Task 3.9 已寫入上限。**不需要重啟。**觀察期長度由使用者決定；建議至少涵蓋一個完整工作天與一個夜間批次。

- [ ] **Step 1：打開並記分界**

```bash
set_flag '{"mode":"all","project_ids":[]}'
node /home/odoo/odoo-v2/.claude/skills/platformDB/query.js "SELECT NOW() AS all_on_at"
```

- [ ] **Step 2：觀察期每天查一次**

```bash
cd /home/odoo/odoo-v2
# 各關失敗率（分界前 7 天 vs 分界後）
node .claude/skills/platformDB/query.js "SELECT agent_type, (recorded_at >= '<all_on_at>') in_container, COUNT(*) n, COUNT(*) FILTER (WHERE status<>'completed') failed FROM token_usage WHERE recorded_at >= '<all_on_at>'::timestamptz - INTERVAL '7 days' GROUP BY 1,2 ORDER BY 1,2"
# oom／session_missing 出現次數
node .claude/skills/platformDB/query.js "SELECT agent_type, LEFT(error_message,80) e, COUNT(*) FROM token_usage WHERE recorded_at >= '<all_on_at>' AND (error_message LIKE '%記憶體上限%' OR error_message LIKE '%找不到要續接的 session%') GROUP BY 1,2"
# 沒收掉的容器（沒有 AI 在跑時應為 0）、閘道拒絕的網域、家目錄容量
docker ps -a --filter label=aidev.run=1 --filter label=aidev.instance=odoo-v2 --format '{{.Names}} {{.Status}}'
docker logs --since 24h odoo-v2-gw 2>&1 | grep '"type":"deny"' | grep -o '"dest":"[^"]*"' | sort | uniq -c
du -sh data/agent-home
```
異常處理：個別專案有問題 → `set_flag '{"mode":"projects","project_ids":[<正常的專案>]}'` 縮回；全面異常 → `set_flag '{"mode":"internal"}'` 或 `off`。都不需要重啟。

- [ ] **Step 3：觀察期結束**：停掉取樣（`kill $(cat /tmp/claude-38-sampler.pid)`），把觀察結果交給使用者（Q1、Q3 已於 09-15 裁決），**取得同意後**才做 Task 3.11。

---

## Task 3.11（開發順序 1.7）：移除無容器路徑 → 重啟批次 R-C

**前置**：Task 3.10 觀察期結束、使用者同意；Q1、Q3 已於 09-15 裁決（考試 AI 不進容器；Codex 名單保留、限內部人員，依公司擋在子專案 1）。規格 §9 第 6 步：**子專案 1 開放客戶登入之前，開關必須移除、只剩容器路徑**（開發順序階段 6 硬條件）。

**Files:**
- Modify: `app/server/pipeline/claude-runner.js`（刪 off 分支與舊路徑 spawn）
- Modify: `app/server/pipeline/sandbox-run.js`（`resolveSandboxPlan` 不再看開關）
- Modify: `app/server/lib/agent-sandbox-flag.js`（只剩資源上限；`mode`／`project_ids` 不再讀）
- Modify: `app/server/admin-routes.js`（PUT 帶 `mode`／`project_ids` → 400）
- Modify: 既有測試中假設 `spawn('claude')` 的檔案（Step 1 盤點）
- Test: `claude-runner-sandbox.test.js`、`agent-sandbox-flag.test.js`、`agent-runner.test.js`、`sandbox-run.test.js`（改寫）

**Interfaces:**
- Produces：
  - `runClaude` 永遠走容器；`resolveSandboxPlan(agentType, opts) → { profile, projectId }`（不再回 null）
  - `agent-sandbox-flag.js` 剩 `loadAgentSandboxFlag`、`getSandboxLimits`、`getGatewayLimits`、`getFlagState`（回 `{ limits, gatewayLimits, changedAt }`）、`validateFlagInput`（收到 `mode` 或 `project_ids` 丟 400）
  - DB 欄位 `agent_sandbox_mode`、`agent_sandbox_project_ids` **保留不刪**（rules/db-schema 41：沒有 drop column，程式不再讀寫）
- 不變：`/ai` TCP 舊路徑（互動式 `/getSQL`）保留（規格 §4.4）；`codex-runner.js` 的 env 白名單保留

- [ ] **Step 1：盤點會受影響的既有測試**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox/app/server
grep -ln "toHaveBeenCalledWith('claude'\|spawn.mock.calls\[0\]\[0\]).toBe('claude')\|_setFlagStateForTesting({ mode: 'off'\|sandboxAppliesTo\|getSandboxMode" tests/*.js
grep -rn "getSandboxMode\|sandboxAppliesTo\|normalizeMode\|parseProjectIds" --include=*.js . | grep -v tests/
```
記下清單。每一支的改寫原則（rules/testing 20）：**保住原測試的意圖**——原本驗「spawn claude 的參數／事件解析」的，改成 mock `../pipeline/sandbox-run` 回傳假 run、驗 `spawn('docker', run.argv, …)` 並對同一個 mock child 發同樣的事件；原本驗「off 時行為不變」的，整條刪除（該行為已不存在）並在 commit 訊息寫明。

- [ ] **Step 2：先改測試成為新行為（應該紅）**

`claude-runner-sandbox.test.js`：刪掉「off：同步 spawn claude」「plan 為 null → 舊路徑」兩條，加入：
```js
// 1.7 之後只剩容器路徑：不論 DB 裡殘留什麼設定值，都不得 spawn claude（規格 §9-6）
test('永遠只 spawn docker', async () => {
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: { scope: 'none', mount: 'none' }, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('x', { agentType: 'chat-title' });
  await tick(); await tick();
  expect(spawn.mock.calls.map(x => x[0])).toEqual(['docker']);
  c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
  await expect(p).resolves.toMatchObject({ text: 'done' });
});
```
並把該檔其餘測試裡的 `flag._setFlagStateForTesting({ mode: ... })` 呼叫刪除（開關已不存在）。

`sandbox-run.test.js` 的 `describe('resolveSandboxPlan')` 改為：
```js
describe('resolveSandboxPlan（1.7 之後不看開關）', () => {
  test('一律回 plan；由 tasks.id 補出專案', async () => {
    const { d } = deps();
    await expect(sr.resolveSandboxPlan('qa', { taskId: 70 }, d)).resolves.toMatchObject({ projectId: 7 });
  });
  test('未登記 agentType → 丟例外', async () => {
    await expect(sr.resolveSandboxPlan('mystery', {}, deps().d)).rejects.toThrow(/mystery/);
  });
});
```

`agent-sandbox-flag.test.js`：刪 `normalizeMode`、`parseProjectIds`、`off／internal／projects／all` 四條、`DB 裡被寫進怪值 → all` 那條；`validateFlagInput` 那條改為：
```js
  test('validateFlagInput：開關已移除，帶 mode 或 project_ids → 400；上限格式照舊檢查', () => {
    expect(() => f.validateFlagInput({ mode: 'off' })).toThrow(/已移除/);
    expect(() => f.validateFlagInput({ project_ids: [3] })).toThrow(/已移除/);
    expect(() => f.validateFlagInput({ memory: '4 GB' })).toThrow();
    expect(f.validateFlagInput({ memory: '4g', cpus: '2', pids: 512 })).toMatchObject({ memory: '4g', cpus: '2', pids: 512 });
  });
```
路由那組的 PUT 改送 `{ memory:'4g', cpus:'2', pids:512, gateway_memory:'256m', gateway_cpus:'0.5', gateway_pids:128 }`，斷言改為只驗上限，並加：
```js
  test('PUT 帶 mode → 400（開關已移除）', async () => {
    const res = await request(app).put('/api/admin/agent-sandbox').set('Authorization', `Bearer ${adminToken}`).send({ mode: 'off' });
    expect(res.status).toBe(400);
  });
```

（09-15 Q3：第 2 部 Task 2.12 沒有加 provider 限制，這裡不動 `agent-runner.test.js`。）

Run: `cd app && npx jest server/tests/claude-runner-sandbox.test.js server/tests/sandbox-run.test.js server/tests/agent-sandbox-flag.test.js server/tests/agent-runner.test.js`
Expected：FAIL（實作還沒改）

- [ ] **Step 3：改實作**

`claude-runner.js`：刪除 `legacyEnv`、`startLegacy`、`if (getSandboxMode() === 'off') { ... }`、`if (!plan) { startLegacy(); return; }`；error handler 的 ENOENT 只留 docker 那句；`require` 裡拿掉 `getSandboxMode`，並刪除已無人使用的 `getClaudeAuthEnv`、`aiTokenEnv`、`aiBaseEnv` import（先 `grep -n` 確認檔內沒有其他用處）。容器路徑段落變成：
```js
    const sr = require('./sandbox-run');
    sr.resolveSandboxPlan(agentType, opts)
      .then(async plan => {
        if (settled) return;
        const run = await sr.prepareSandboxRun({ claudeArgs: args, opts, profile: plan.profile, projectId: plan.projectId });
        sandboxRun = run;
        if (settled) { releaseSandbox(); return; }
        attachChild(spawn('docker', run.argv, { stdio: ['pipe', 'pipe', 'pipe'], env: run.childEnv }));
      })
      .catch(err => finish(() => reject(fail(err, 'error'))));
```
`sandbox-run.js` 的 `resolveSandboxPlan` 最後一行改為 `return { profile, projectId };`，並刪掉 `sandboxAppliesTo` 的 require。

`agent-sandbox-flag.js`：刪 `MODES`、`normalizeMode`、`parseProjectIds`、`getSandboxMode`、`sandboxAppliesTo`；`loadAgentSandboxFlag` 的 SELECT 拿掉兩個 mode 欄位、catch 分支不再設 mode；`getFlagState` 只回 `{ limits, gatewayLimits, changedAt }`；`validateFlagInput` 開頭加：
```js
  if (body.mode !== undefined || body.project_ids !== undefined) throw bad('AI 容器隔離的開關已移除（子專案 0 §9-6），只剩資源上限可設定');
```
並刪掉 mode／ids 的檢查與回傳欄位；`_setFlagStateForTesting` 的預設物件拿掉 `mode`、`projectIds`。

`admin-routes.js` 的 PUT：SQL 拿掉 `agent_sandbox_mode`、`agent_sandbox_project_ids` 兩欄與對應參數（改成 `$1..$6`），log 改記上限；GET 回傳拿掉 `mode`、`project_ids`。

第 3 部檔頭「共用指令」的 `set_flag` 之後不可再帶 `mode`／`project_ids`（1.7 後改開關的指令只剩上限）。

- [ ] **Step 4：跑受影響測試，再全跑**

Run: `cd app && npx jest server/tests/claude-runner-sandbox.test.js server/tests/sandbox-run.test.js server/tests/agent-sandbox-flag.test.js server/tests/agent-runner.test.js $(grep -ln "toHaveBeenCalledWith('claude'" server/tests/*.js | tr '\n' ' ')`
Expected：PASS（Step 1 盤點出的檔都已依原意改寫）
Run: `cd app && npm run test:quiet > /tmp/claude-t311.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-t311.txt; grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-t311.txt`
Expected：無新紅燈

- [ ] **Step 5：確認平台碼再也沒有容器外的 claude 呼叫**

```bash
grep -rn "spawn('claude'" app/server --include=*.js | grep -v tests/
```
Expected：只剩 `lib/exam/*.js` 三處（Q1 裁決「不進容器」時）；若 Q1 裁決「進容器」，這三處應已由另開的 Task 改掉、輸出為空。

- [ ] **Step 6：Commit、推分支、請使用者核准合併**

```bash
git add app/server/pipeline/claude-runner.js app/server/pipeline/sandbox-run.js app/server/lib/agent-sandbox-flag.js app/server/admin-routes.js app/server/pipeline/agent-runner.js app/server/tests/claude-runner-sandbox.test.js app/server/tests/sandbox-run.test.js app/server/tests/agent-sandbox-flag.test.js app/server/tests/agent-runner.test.js
# Step 1 盤點出的其他測試檔逐一 git add（不要 git add -A）
git commit -m "[AgentSandbox]: 客戶登入前隔離不能還是一個關得掉的開關，移除無容器路徑、只留資源上限設定

移除「off 時行為不變」類的測試：該行為已不存在（規格 §9-6）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7：交接 R-C**：執行者停手，回報：合併內容、全跑結果、重啟後「任何 AI 執行都在容器內；容器或閘道不可用時所有 AI 會失敗（不會退回）」；請使用者在沒有 session 時照「重啟批次」段檢查後重啟；重啟後開新 session 從 Task 3.12 接續。

---
## Task 3.12：R-C 重啟後驗收＋階段 6 硬條件核對

**Files:** 無程式變更

- [ ] **Step 1：自我檢測再跑一次**（與 M10 Step 3 同一組 id）

```bash
cd /home/odoo/odoo-v2
AIDEV_ADMIN_JWT="$AIDEV_ADMIN_JWT" node scripts/verify-agent-sandbox.js <project_id> <task_id> <other_project_id> > /tmp/claude-t312.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-t312.txt
tail -3 /tmp/claude-t312.txt
```
Expected：`EXITCODE=0`

- [ ] **Step 2：開關真的關不掉**

```bash
curl -s -X PUT -H "Authorization: Bearer $AIDEV_ADMIN_JWT" -H 'Content-Type: application/json' http://localhost:8771/api/admin/agent-sandbox -d '{"mode":"off"}'; echo
```
Expected：HTTP 400、訊息含「已移除」

- [ ] **Step 3：一般流程照常**：任一專案的對話問一句、任一任務推進一關；`token_usage` 最新列 `completed`，`docker ps --filter label=aidev.run=1` 在執行中看得到容器、結束後消失。

- [ ] **Step 4：階段 6 硬條件核對表**（開發順序 §4 階段 6；逐項填日期與證據，缺一項就不准開第一家客戶）

| 條件 | 怎麼確認 | 結果 |
|---|---|---|
| 1.7 完成：只剩容器路徑 | Task 3.11 Step 5 的 grep；本 Task Step 2 回 400 | |
| 2c 完成：測試區獨立 DB 帳號 | commit `8ca9913d` 已重啟生效：`node .claude/skills/platformDB/query.js "SELECT rolname FROM pg_roles WHERE rolname LIKE 'testenv_p%'"` 有列，且每個在跑的測試區容器 `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' odoo-test-<folder> \| grep ^USER=` 是 `testenv_p<id>` | |
| 0.5 完成：健檢提案人工核准 | commit `5f962094` 已重啟生效：最近一次健檢產生的提案 `status='pending'` | |
| R6-A 完成：只有健檢 AI 能查平台 DB | 自我檢測 `ai_platform_query_403`（project）與 `platform_query_ok`（audit）皆 PASS；`internal-fix` 的端點群組只有 `glossary`（Task 1.1 測試） | |

- [ ] **Step 5：回報使用者的收尾清單**
  - `.claude/rules/infra.md` 第 131 條（「`spawn('claude')` 只有一處」）已與現況不符（X2＋容器化後的 `spawn('docker')`）——**改 rules 需使用者同意**，提出建議文字：「AI 執行一律經 `runClaude` → `sandbox-run.js` → `spawn('docker')`；考試系統三處直接 spawn 的狀態見子專案 0 Q1」
  - `data/logs/agent-sandbox-stats.log` 可刪
  - 規格 §10 仍接受的風險：容器內的 Context7 key、平台 Claude 訂閱 token（子專案 2 前）、Codex 與考試系統同 uid 可讀 `data/config.json`（Q1）、夜間改善自動合併（R6）

---

## Task 3.13（09-15 Q4 裁決必做，排在 3.3 之後、3.4 之前）：任務主 clone 的 refs 快照守衛

**為什麼**：容器必須能寫任務主 clone 的 `.git`（commit 寫 objects、更新本任務分支），因此也寫得到同專案 `main`／`testing`／其他任務分支的 ref。被注入的 coding agent 可以把 `testing` 指到自己做的 commit，繞過 QA 與人工審核直接進部署。規格 §4.2 只擋了 config／hooks。守衛做法：執行前後比對 refs，除本任務分支外任何 ref 變動都還原並讓該輪失敗。

**Files:**
- Create: `app/server/lib/ref-guard.js`
- Modify: `app/server/pipeline/sandbox-run.js`（task-worktree 類 profile 準備時快照；run 物件多 `verifyRefs()`）
- Modify: `app/server/pipeline/claude-runner.js`（close 成功分支 resolve 前呼叫 `sandboxRun.verifyRefs`）
- Test: `app/server/tests/ref-guard.test.js`

**Interfaces:**
- Produces：
  - `snapshotRefs(repoPath, deps?) → Promise<Map<string, string>>`
  - `diffRefs(before, after, allowed: Set<string>) → { ref, before: string|null, after: string|null }[]`
  - `restoreRefs(repoPath, violations, deps?) → Promise<void>`
  - `run.verifyRefs() → Promise<null | string>`（有違規時回說明文字，已還原）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/ref-guard.test.js
// 意圖：AI 只准動本任務分支。改到 testing／main 的指標＝繞過審核直接進部署，必須還原並讓這一輪失敗。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const g = require('../lib/ref-guard');

let repo;
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'refguard-'));
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1'); git('add', 'a'); git('commit', '-q', '-m', 'base');
  git('branch', 'testing'); git('branch', 'task-1');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

test('只動本任務分支 → 沒有違規', async () => {
  const before = await g.snapshotRefs(repo, { execFile });
  git('checkout', '-q', 'task-1'); fs.writeFileSync(path.join(repo, 'a'), '2'); git('commit', '-q', '-am', 'work');
  const after = await g.snapshotRefs(repo, { execFile });
  expect(g.diffRefs(before, after, new Set(['refs/heads/task-1']))).toEqual([]);
});

test('改 testing 指標、新增分支 → 列為違規並能還原', async () => {
  const before = await g.snapshotRefs(repo, { execFile });
  const evil = git('commit-tree', '-m', 'evil', `${git('rev-parse', 'HEAD')}^{tree}`);
  git('update-ref', 'refs/heads/testing', evil);
  git('branch', 'sneaky');
  const after = await g.snapshotRefs(repo, { execFile });
  const v = g.diffRefs(before, after, new Set(['refs/heads/task-1']));
  expect(v.map(x => x.ref).sort()).toEqual(['refs/heads/sneaky', 'refs/heads/testing']);
  await g.restoreRefs(repo, v, { execFile });
  const restored = await g.snapshotRefs(repo, { execFile });
  expect(restored.get('refs/heads/testing')).toBe(before.get('refs/heads/testing'));
  expect(restored.has('refs/heads/sneaky')).toBe(false);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/ref-guard.test.js`
Expected：FAIL，`Cannot find module '../lib/ref-guard'`

- [ ] **Step 3：實作 `ref-guard.js`**

```js
// app/server/lib/ref-guard.js
/**
 * ref-guard.js — AI 容器執行前後比對任務主 clone 的 refs（子專案 0 Q4，09-15 裁決必做）
 * 容器寫得到 .git（commit 必要），也就寫得到 testing／main 指標；除本任務分支外任何變動都還原並判該輪失敗。
 */
const { execFile: realExecFile } = require('child_process');

function git(execFile, cwd, args) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60000 }, (err, out) => (err ? reject(err) : resolve(String(out || '')))));
}

async function snapshotRefs(repoPath, deps = {}) {
  const out = await git(deps.execFile || realExecFile, repoPath, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const m = new Map();
  for (const line of out.split('\n')) { const [ref, sha] = line.trim().split(' '); if (ref && sha) m.set(ref, sha); }
  return m;
}

function diffRefs(before, after, allowed) {
  const out = [];
  for (const ref of new Set([...before.keys(), ...after.keys()])) {
    if (allowed.has(ref)) continue;
    const b = before.get(ref) || null; const a = after.get(ref) || null;
    if (b !== a) out.push({ ref, before: b, after: a });
  }
  return out;
}

async function restoreRefs(repoPath, violations, deps = {}) {
  const execFile = deps.execFile || realExecFile;
  for (const v of violations) {
    if (v.before) await git(execFile, repoPath, ['update-ref', v.ref, v.before]);
    else await git(execFile, repoPath, ['update-ref', '-d', v.ref]);
  }
}

module.exports = { snapshotRefs, diffRefs, restoreRefs };
```

- [ ] **Step 4：接進 `prepareSandboxRun` 與 runner**

`sandbox-run.js`：`resolveSandboxMounts` 之後、`buildAgentRunArgs` 之前加（只對 task-worktree 類）：
```js
    let verifyRefs = async () => null;
    if (/^task-worktree/.test(profile.mount) && opts.taskId != null && scopeProjectId != null) {
      const guard = require('../lib/ref-guard');
      const q = deps.query || require('../db').query;
      const { rows: [t] } = await q('SELECT git_branch FROM tasks WHERE id=$1', [opts.taskId]);
      const info = await require('./task-agent').getProjectInfo(scopeProjectId);
      const allowed = new Set(t && t.git_branch ? [`refs/heads/${t.git_branch}`] : []);
      const repos = (info && info.repos) || [];
      const before = await Promise.all(repos.map(r => guard.snapshotRefs(r.local_path)));
      verifyRefs = async () => {
        const msgs = [];
        for (let i = 0; i < repos.length; i++) {
          const v = guard.diffRefs(before[i], await guard.snapshotRefs(repos[i].local_path), allowed);
          if (v.length) { await guard.restoreRefs(repos[i].local_path, v); msgs.push(`${repos[i].label}: ${v.map(x => x.ref).join(', ')}`); }
        }
        return msgs.length ? `AI 改動了本任務分支以外的 git ref，已還原：${msgs.join('；')}` : null;
      };
    }
```
回傳物件加 `verifyRefs,`。

`claude-runner.js` close handler 的成功分支（`const finalModel = ...` 之前）改為先驗：
```js
          if (sandboxRun && sandboxRun.verifyRefs) {
            return Promise.resolve(sandboxRun.verifyRefs()).then(msg => {
              if (msg) return reject(fail(new Error(msg), 'error'));
              const finalModel = usedModel || model || null;
              if (usage && finalModel) usage.model = finalModel;
              resolve({ text: resultText.trim(), assistantText: assistantText.trim(), raw: assistantText.trim() || resultText.trim(), usage, durationMs, sessionId, model: finalModel });
            }, err => reject(fail(err, 'error')));
          }
```
（其後原本的成功分支保留，給沒有 `verifyRefs` 的 run。另在 `sandbox-run.test.js`、`claude-runner-sandbox.test.js` 各補一條：`verifyRefs` 回訊息 → reject；回 null → resolve。）

- [ ] **Step 5：跑測試、全跑、Commit**（訊息：`[AgentSandbox]: 容器寫得到任務主 clone 的 refs，被注入的 AI 能把 testing 指到自己的 commit 繞過審核，執行後比對並還原`）

---

## 自我檢查（寫計畫時對照規格）

### 規格逐節對照

| 規格 | 認領的 Task | 備註 |
|---|---|---|
| §1 目標（三把鑰匙、別專案、客戶憑證、平台 DB 唯讀遮蔽；只連三處） | 1.4、1.5、1.10、2.2、2.3、3.3 | 「只連三處」由 2.2 白名單＋M6／3.3 實測 |
| §1 非目標 | —— | 未做：公司／角色（子專案 1）、BYOK（2）、更版機制（4）；`canRun` 只留檢查點（1.2）；Codex 不容器化（2.12） |
| §2 現況 | 第 1 部檔頭 X1–X21 | 逐條對照現行碼 |
| §3 設計總覽 | 1.8、2.2、2.3 | |
| §4.1 映像檔 | 2.1、M5 | 另加 python 三套件（chat 讀 Office 附件） |
| §4.2 容器參數／掛載／env | 1.4、1.5、1.12、2.5、2.15 | 另加附件與 log 掛載（X7）、skill 白名單（X9） |
| §4.3 出口閘道 | 2.2、2.3、M6 | 來源記 IP 不記容器名（X14） |
| §4.4 `/ai` 改動 | 1.2、1.6、1.7、1.8、1.9、1.10、1.11 | 唯讀角色改 LOGIN（X13）＋GRANT CONNECT（X19）；internal-fix 只給 glossary（X12／Q2） |
| §4.5 內部 AI | 1.1、1.5、3.1、3.2、M8 | `jest.setup.js` 已實查不需祕密（M8 說明） |
| §4.6 Codex | 2.11、2.12 | Q3（09-15）：名單保留、限內部人員；依觸發者公司擋 Codex 落在子專案 1 |
| §5 資料流 | 2.5、2.6 | |
| §6 錯誤處理 | 停止／逾時 2.6；重啟 2.8、3.1；`--resume` 2.4、2.16、3.7；137 2.6、2.7、M9；docker 不可用 2.3、2.6；閘道拒絕 2.2；env 白名單外 1.4 | |
| §7 會改變的行為 | 2.14、2.15、M11 | WebFetch／WebSearch 在容器內會失敗：規格已知並接受，不另開 Task |
| §8.1 單元測試 | 1.4 | |
| §8.2 `/ai` 範圍 | 1.6、1.7、1.8 | |
| §8.3 攻擊實測 | 3.3、M10、3.12 | 另加宿主 loopback 8772（X20）、R6-A 兩級 |
| §8.4 試跑比對 | M11 | |
| §9 切換步驟 | 1→第 1、2 部＋3.4；2→M10（X15：排在合併重啟之後）；3→3.6、3.8、3.10；4→3.7（複製 session 不需要重啟）；5→M11；6→3.11 | |
| §10 風險與未決 | 上限 M8／M10／3.9；agentType 表 M1；敏感欄位 1.10；Context7 key、訂閱 token、Codex 同 uid、自動合併：接受（3.12 Step 5 回報） | |
| 開發順序 §2.1 功能開關指定公司 | **不在本計畫範圍**（X16：公司表是子專案 1） | |
| 開發順序 1.2–1.7 | 3.5–3.12 | 重啟批次 R-A／R-B／R-C（X21） |

### 刻意留給執行當下填的值（不是佔位，都由本計畫前面的步驟產生）

- `session-signature.js` 的 `SAMPLE_LINE`：M2 Step 2 實測整行（2.4 Step 1 有測試閘門擋住沒換掉的情形）
- M10、3.9 的上限數值：由 M8／3.8 的取樣依寫死的規則計算
- `<project_id>`（＝1，09-15 Q5 指定 odoo17）／`<task_id>`／`<other_project_id>`：由 M10 Step 2 查出
- `<internal_on_at>`／`<projects_on_at>`／`<all_on_at>`：3.6／3.8／3.10 Step 1 查出並記錄
- `AIDEV_ADMIN_JWT`：平台管理員登入取得，不寫進任何檔案

### 介面一致性（跨部引用）

- scope 字串：`project-<id>`／`none`／`internal-audit`／`internal-fix`（1.1 定義；1.2、1.6、1.7、2.5、3.3 使用）
- 端點群組：`db`／`wiki`／`tasks`／`glossary`／`platform`（1.1 定義；1.6、1.7、1.9、1.11 使用）
- mount 種類：`task-worktree`／`task-worktree-or-none`／`task-worktree-or-clone`／`project-clone`／`none`／`platform-clean`／`platform-fix`（1.1 定義；1.5、2.15、3.13 使用）
- `prepareSandboxRun` 回傳 `{ argv, childEnv, containerName, runId, kill, release }`（2.5 定義；2.6、3.3 使用；3.13 另加 `verifyRefs`）
- `ensureAgentInfra` 回傳 `{ instanceId, image, network, gatewayHost }`（2.3 定義；2.5、3.3 使用）
- `claudeStatus` 新值：`session_missing`（2.4）、`oom`（2.6、2.7）
- runner opts 新欄位：`projectId`、`chatId`、`feedbackIds`、`logSessionMissing`（2.4、2.9、3.2）
- 開關欄位名：DB `agent_sandbox_*`／`agent_gateway_*`；HTTP `mode, project_ids, memory, cpus, pids, gateway_memory, gateway_cpus, gateway_pids`（1.3 定義；3.x 的 `set_flag` 使用）
