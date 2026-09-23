# 把 AI 關起來（子專案 0）實作計畫 — 第 2 部：映像檔、閘道與 runner 整合

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `runClaude` 在開關涵蓋的 agent 上改以 `docker run` 執行：映像檔、出口閘道、infra 確保、容器分支（停止＝`docker kill`、137＝記憶體上限、session 遺失辨識）、重啟清孤兒容器、所有呼叫端補齊專案脈絡、Codex／考試的 env 白名單、skill 改打 `/ai`、session 檔搬家。

**Architecture:** 見第 1 部檔頭。本部新增 `pipeline/sandbox-run.js`（準備一次容器執行：scope→通行證→掛載→參數）與 `lib/agent-infra.js`（網路、閘道、映像檔），並把 `claude-runner.js` 的子行程處理抽成 `attachChild`，兩條路徑（`spawn('claude')`／`spawn('docker')`）共用同一份 stream-json 解析。

**Tech Stack:** 同第 1 部。

**Spec:** `docs/superpowers/specs/2026-09-11-agent-sandbox-design.md`；**前置：第 1 部全部完成**（`docs/superpowers/plans/2026-09-15-agent-sandbox.md`，Global Constraints 與「與規格不符之處」以該檔為準，本部不重複）。

## 執行順序

`2.1 → M5 → 2.2 → 2.3 → M6 → M7 → M8 → M9 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8 → 2.9 → 2.10 → 2.11 → 2.12 → 2.13 → 2.14 → 2.15 → 2.16`

量測 M5–M9 需要在主機上真的開容器；它們**不改平台程式碼、不重啟平台**，但會 `docker build`／`docker run`。主機同時跑約 110 個容器（開發順序 §2.4），量測用的容器一律 `--rm` 並帶暫定上限。

## 檔案地圖（第 2 部）

| 檔 | 動作 | 責任 |
|---|---|---|
| `docker/agent/Dockerfile` | Create | AI 映像檔（claude、context7-mcp、git、ripgrep、curl、python3＋讀 Office 附件的三個套件） |
| `app/server/agent-gateway/gateway.js` | Create | 出口閘道：CONNECT 白名單（3128）＋`/ai/*` 轉 unix socket（8080）；只用 node 內建模組 |
| `app/server/lib/agent-infra.js` | Create | 實例 id、名稱、映像檔檢查、internal 網路與閘道容器確保 |
| `app/server/pipeline/session-signature.js` | Create | `--resume` 找不到 session 的字面（M2 實測值） |
| `app/server/pipeline/sandbox-run.js` | Create | `resolveSandboxPlan`、`prepareSandboxRun`、`sandboxMcpConfigPath` |
| `app/server/pipeline/claude-runner.js` | Modify | 子行程處理抽 `attachChild`；容器分支；kill／137／session_missing |
| `app/server/pipeline/failure-classifier.js` | Modify | `claudeStatus:'oom'` → `env` |
| `app/server/lib/agent-orphans.js` | Create | 平台啟動時清本實例殘留的 AI 容器 |
| `app/server/index.js` | Modify | 啟動時呼叫孤兒清理 |
| 呼叫端（`chat-agent.js`、`chat-title.js`、`chat-to-task.js`、`failure-classifier.js`、`classify-rejections.js`、`wiki-drift.js`、`library-agent.js`、`admin-routes.js`、`task-agent.js`） | Modify | 補 `projectId`／`chatId`／`agentType`；coding／spec_tour 的 env 只給 git 身分 |
| `app/server/lib/git-identity.js` | Modify | `pickGitIdentity(gitEnv)` |
| `app/server/lib/agent-env.js` | Create | 非容器子行程（Codex、考試）的 env 白名單 |
| `app/server/pipeline/codex-runner.js`、`agent-runner.js` | Modify | env 白名單；容器模式下客戶 agent 禁用 Codex |
| `app/server/lib/exam/challenge.js`、`review.js`、`evidence.js` | Modify | spawn 帶 env 白名單 |
| `.claude/skills/platformDB/query.js`、`platformDB/SKILL.md`、`odooGlossary/SKILL.md`、`getLog/SKILL.md` | Modify | 容器內改打 `/ai`；getLog 不寫死埠 |
| `app/server/lib/agent-session-migrate.js`、`tools/copy-agent-sessions.js` | Create | 切換日把既有 session 檔複製進各 scope 家目錄 |
| `.gitignore` | Modify | `app/server/pipeline/mcp/context7.sandbox.local.json` |

---

## Task 2.1：AI 映像檔 `aidev-agent:<claude 版本>`

**Files:**
- Create: `docker/agent/Dockerfile`

**Interfaces:**
- Produces：映像檔標籤 `aidev-agent:<claude 版本>`（09-15 為 `aidev-agent:2.1.266`），build arg `NODE_IMAGE`（預設 `node:22-slim`；M8 若判定要換就傳 `node:20-slim`）、`CLAUDE_CODE_VERSION`、`CONTEXT7_MCP_VERSION`。Task 2.3 以 `agentImageTag(version)` 找它。

- [ ] **Step 1：寫 Dockerfile**

```dockerfile
# docker/agent/Dockerfile
# 子專案 0 §4.1：每次 AI 執行用完即丟的容器映像。
# - 與平台同版的 claude CLI（升版兩邊一起升）；context7-mcp 裝在映像內，容器專用 MCP 設定直接呼叫它
#   （平台生成的設定檔指向宿主 node 與 app/node_modules，容器內都不存在，見計畫 X8）
# - python3＋openpyxl／python-docx／xlrd：chat／cs 讀 Office 附件的指引（chat-agent.js ATTACHMENT_READ_HINTS）
#   指名這三個；平台映像以 pip 裝，這裡走 Debian 套件避開 PEP 668
# - 不裝 rtk、不帶任何使用者層外掛或設定；以 --user <宿主 uid:gid> 執行（見 lib/agent-sandbox.js）
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION
ARG CONTEXT7_MCP_VERSION

RUN test -n "$CLAUDE_CODE_VERSION" && test -n "$CONTEXT7_MCP_VERSION" \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates \
         python3 python3-openpyxl python3-docx python3-xlrd \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@upstash/context7-mcp@${CONTEXT7_MCP_VERSION}" \
    && npm cache clean --force

# 容器內家目錄由 --mount 掛入並以 -e HOME 指定；不在映像內建任何設定檔
WORKDIR /tmp
```

- [ ] **Step 2：在主機 build**（版本取自平台實際安裝值，不手打）

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox
CV=$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
MV=$(node -p "require('/home/odoo/odoo-v2/app/node_modules/@upstash/context7-mcp/package.json').version")
echo "claude=$CV context7=$MV"
docker build -f docker/agent/Dockerfile --build-arg CLAUDE_CODE_VERSION="$CV" --build-arg CONTEXT7_MCP_VERSION="$MV" -t "aidev-agent:$CV" docker/agent > /tmp/claude-agent-build.log 2>&1; echo "EXITCODE=$?" >> /tmp/claude-agent-build.log
tail -3 /tmp/claude-agent-build.log
```
Expected：`EXITCODE=0`（rules/always 12：exit code 先落檔再看）

- [ ] **Step 3：驗內容**

```bash
docker run --rm --network none --entrypoint sh "aidev-agent:$CV" -c 'claude --version; command -v context7-mcp; git --version; rg --version | head -1; python3 -c "import openpyxl, docx, xlrd; print(\"py-ok\")"; command -v rtk || echo no-rtk'
```
Expected：claude 版本與 `$CV` 相同、`context7-mcp` 有路徑、`py-ok`、`no-rtk`

- [ ] **Step 4：Commit**

```bash
git add docker/agent/Dockerfile
git commit -m "[AgentSandbox]: AI 要在用完即丟的容器裡跑，需要一個與平台同版 claude、不帶個人外掛的映像檔

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task M5（量測）：映像檔啟動時間

**為什麼**：規格 §2.12 量的是 `node:22-slim`（226–259 ms），沒有裝 claude；實際成本要用真映像量。

- [ ] **Step 1：量 5 次（不接網路與接 bridge 各一組）**

```bash
CV=$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
for i in 1 2 3 4 5; do /usr/bin/time -f "none %e s" docker run --rm --network none --entrypoint claude "aidev-agent:$CV" --version >/dev/null; done 2>&1 | grep none
for i in 1 2 3 4 5; do /usr/bin/time -f "bridge %e s" docker run --rm --entrypoint claude "aidev-agent:$CV" --version >/dev/null; done 2>&1 | grep bridge
```

- [ ] **Step 2：記錄與判定**：把 10 個數字記進 `docs/superpowers/plans/2026-09-15-agent-sandbox-M1-table.md` 的「M5」段。中位數超過 **2 秒**（chat p50 40.6 s 的 5%）→ 回報使用者（這會改變規格 §1「不影響使用者感受」的前提），不自行調整設計。

---

## Task 2.2：出口閘道程式 `gateway.js`

**Files:**
- Create: `app/server/agent-gateway/gateway.js`
- Test: `app/server/tests/agent-gateway.test.js`

**Interfaces:**
- Produces：
  - `ALLOWED_CONNECT: Set<string>`＝`api.anthropic.com:443`、`platform.claude.com:443`、`context7.com:443`、`mcp.context7.com:443`
  - `createConnectProxy({ allow: Set<string>, log: (obj)=>void }) → http.Server`（CONNECT 在白名單→200 並雙向 pipe；否則 403＋log `{type:'deny', dest, src}`；非 CONNECT 請求→405）
  - `createAiForwarder({ socketPath, log }) → http.Server`（`/ai/` 開頭轉發到 unix socket，其餘 404；socket 連不上→502）
  - 直接執行時：3128 跑 proxy、8080 跑 forwarder，socket 路徑取 `AIDEV_AI_SOCKET`（必填，未設 exit 1）
- 只用 node 內建模組（閘道容器用平台映像的 node，不裝任何套件）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-gateway.test.js
// 意圖：容器唯一的出口。白名單外一律拒絕並留紀錄（事後查得到 AI 試圖連哪裡）；/ai 以外的路徑不轉發（/api 不經閘道暴露）。
// 用本機的真 TCP／unix socket 驗，白名單以注入的本機位址代替 api.anthropic.com。
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectProxy, createAiForwarder, ALLOWED_CONNECT } = require('../agent-gateway/gateway');

const listen = (srv, arg = 0) => new Promise(r => srv.listen(arg, '127.0.0.1', () => r(srv.address().port)));
const listenSock = (srv, p) => new Promise(r => srv.listen(p, r));
const close = srv => new Promise(r => srv.close(r));

function connectVia(proxyPort, dest) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: dest });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', res => resolve({ status: res.statusCode }));
    req.on('error', reject);
    req.end();
  });
}

test('正式白名單只有四個網域的 443', () => {
  expect([...ALLOWED_CONNECT].sort()).toEqual(['api.anthropic.com:443', 'context7.com:443', 'mcp.context7.com:443', 'platform.claude.com:443']);
});

describe('CONNECT proxy', () => {
  let target, targetPort, proxy, proxyPort, logs;
  beforeAll(async () => {
    target = net.createServer(s => s.on('data', d => s.write(`echo:${d}`)));
    targetPort = await listen(target);
    logs = [];
    proxy = createConnectProxy({ allow: new Set([`127.0.0.1:${targetPort}`]), log: o => logs.push(o) });
    proxyPort = await listen(proxy);
  });
  afterAll(async () => { await close(proxy); await close(target); });

  test('白名單內 → 200 且資料雙向通', async () => {
    const { status, socket } = await connectVia(proxyPort, `127.0.0.1:${targetPort}`);
    expect(status).toBe(200);
    const reply = await new Promise(r => { socket.once('data', d => r(String(d))); socket.write('ping'); });
    expect(reply).toBe('echo:ping');
    socket.destroy();
  });

  test('白名單外 → 403 並記下目的地', async () => {
    const { status } = await connectVia(proxyPort, 'example.com:443');
    expect(status).toBe(403);
    expect(logs).toContainEqual(expect.objectContaining({ type: 'deny', dest: 'example.com:443' }));
  });

  test('一般 HTTP 代理請求（非 CONNECT）→ 405', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: 'http://example.com/' }, res => resolve(res.statusCode));
      req.on('error', reject); req.end();
    });
    expect(status).toBe(405);
  });
});

describe('/ai 轉發', () => {
  let backend, fwd, fwdPort, dir, sock;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
    sock = path.join(dir, 'ai.sock');
    backend = http.createServer((req, res) => res.end(JSON.stringify({ path: req.url, token: req.headers['x-aidev-ai-token'] || null })));
    await listenSock(backend, sock);
    fwd = createAiForwarder({ socketPath: sock, log: () => {} });
    fwdPort = await listen(fwd);
  });
  afterAll(async () => { await close(fwd); await close(backend); fs.rmSync(dir, { recursive: true, force: true }); });

  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fwdPort, path: p, headers }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.end();
  });

  test('/ai/* 原樣轉進 socket，header 保留', async () => {
    const r = await get('/ai/wiki/pages?project=x', { 'x-aidev-ai-token': 't1' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ path: '/ai/wiki/pages?project=x', token: 't1' });
  });

  test.each(['/api/tasks', '/', '/aix/y'])('%s → 404，不轉發', async (p) => {
    expect((await get(p)).status).toBe(404);
  });

  test('socket 不存在 → 502', async () => {
    const bad = createAiForwarder({ socketPath: path.join(dir, 'missing.sock'), log: () => {} });
    const port = await listen(bad);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ai/x' }, res => resolve(res.statusCode));
      req.on('error', reject); req.end();
    });
    expect(status).toBe(502);
    await close(bad);
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-gateway.test.js`
Expected：FAIL，`Cannot find module '../agent-gateway/gateway'`

- [ ] **Step 3：實作**

```js
// app/server/agent-gateway/gateway.js
/**
 * 出口閘道（子專案 0 §4.3）。跑在 <實例id>-gw 容器內，同時接 internal 網路與預設 bridge；**不持有任何憑證**。
 *   3128：HTTPS CONNECT proxy，只放行 ALLOWED_CONNECT；其餘 403 並寫一行 JSON 到 stdout（docker logs 看得到）
 *   8080：/ai/* 轉發到掛入的 unix socket（平台 node 的 /ai 入口）；其餘 404
 * 只用 node 內建模組：閘道容器沿用平台映像的 node，不另裝套件。
 * 來源只記 IP（閘道沒有 docker socket，查不到容器名）；對應容器用 `docker network inspect <net>` 查（計畫 X14）。
 */
const http = require('http');
const net = require('net');

const ALLOWED_CONNECT = new Set([
  'api.anthropic.com:443',
  'platform.claude.com:443',
  'context7.com:443',
  'mcp.context7.com:443',
]);

const defaultLog = obj => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`);

function createConnectProxy({ allow = ALLOWED_CONNECT, log = defaultLog } = {}) {
  const server = http.createServer((req, res) => {
    log({ type: 'deny-method', method: req.method, url: req.url, src: req.socket.remoteAddress });
    res.writeHead(405).end('only CONNECT is allowed');
  });
  server.on('connect', (req, clientSocket, head) => {
    const dest = String(req.url || '').toLowerCase();
    const src = clientSocket.remoteAddress;
    if (!allow.has(dest)) {
      log({ type: 'deny', dest, src });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const idx = dest.lastIndexOf(':');
    const upstream = net.connect(Number(dest.slice(idx + 1)), dest.slice(0, idx), () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const done = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', err => { log({ type: 'upstream-error', dest, src, error: err.message }); clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    clientSocket.on('error', done);
  });
  return server;
}

function createAiForwarder({ socketPath, log = defaultLog }) {
  if (!socketPath) throw new Error('缺 socketPath');
  return http.createServer((req, res) => {
    if (!String(req.url || '').startsWith('/ai/')) { res.writeHead(404).end('not found'); return; }
    const up = http.request({ socketPath, path: req.url, method: req.method, headers: req.headers }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', err => {
      log({ type: 'ai-forward-error', path: req.url, error: err.message });
      if (!res.headersSent) res.writeHead(502);
      res.end('platform /ai socket unavailable');
    });
    req.pipe(up);
  });
}

if (require.main === module) {
  const socketPath = process.env.AIDEV_AI_SOCKET;
  if (!socketPath) { console.error('AIDEV_AI_SOCKET 未設定'); process.exit(1); }
  createConnectProxy().listen(3128, '0.0.0.0', () => defaultLog({ type: 'listen', port: 3128 }));
  createAiForwarder({ socketPath }).listen(8080, '0.0.0.0', () => defaultLog({ type: 'listen', port: 8080, socketPath }));
}

module.exports = { ALLOWED_CONNECT, createConnectProxy, createAiForwarder };
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-gateway.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/agent-gateway/gateway.js app/server/tests/agent-gateway.test.js
git commit -m "[AgentSandbox]: 光把 AI 放進容器，它仍連得到宿主的 8771／22／8772，出口要有一個只放行 Anthropic、Context7 與 /ai 的閘道

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 2.3：`agent-infra.js`——實例 id、映像檔、internal 網路、閘道容器

**Files:**
- Create: `app/server/lib/agent-infra.js`
- Test: `app/server/tests/agent-infra.test.js`（比照 `vpn-gateway-run.test.js`：注入 callback 式 `execFile`）

**Interfaces:**
- Consumes：`getGatewayLimits()`（第 1 部 Task 1.3）；`aiSocketPath()`（第 1 部 Task 1.8）
- Produces：
  - `instanceId() → string`（取 `PLATFORM_CONTAINER`；未設或含非法字元丟例外）
  - `infraNames(id) → { network: '<id>-agent-net', gateway: '<id>-gw' }`
  - `agentImageTag(version) → 'aidev-agent:<version>'`
  - `ensureAgentInfra(deps?) → Promise<{ instanceId, image, network, gatewayHost }>`（成功結果快取 60 秒）
    - `deps = { execFile, instanceId, claudeVersion, gatewayLimits, appDir, socketPath, uid, gid, now }`（皆可注入）
  - `_resetInfraCacheForTesting()`
- 行為：映像檔不存在 → **丟例外並附 build 指令**（不在執行期自動 build，那要數分鐘）；網路不存在 → `docker network create --internal`；閘道沒在跑 → `rm -f` 後重建並接上 internal 網路；閘道上限三個缺一 → 丟例外。閘道映像取平台容器自己的 `Config.Image`（不寫死 `odoo-v2:latest`），並以 `--entrypoint node` 蓋掉平台映像會起 PostgreSQL 的 `entrypoint.sh`。

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-infra.test.js
// 意圖：網路與閘道的名字帶實例 id（同主機兩套平台不互砍）；閘道不持憑證、唯讀、權限最小；
// 映像檔缺了要大聲失敗並告訴人怎麼 build，而不是退回無容器執行（規格 §6）。
const infra = require('../lib/agent-infra');

function fakeDocker(state) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    const a = args.join(' ');
    const ok = out => cb(null, out, '');
    const fail = msg => cb(Object.assign(new Error(msg), { stderr: msg }), '', msg);
    if (cmd === 'claude') return ok('2.1.266 (Claude Code)\n');
    if (a.startsWith('image inspect')) return state.image ? ok('[]') : fail('No such image');
    if (a.startsWith('network inspect')) return state.network ? ok('[]') : fail('No such network');
    if (a.startsWith('network create')) { state.network = true; return ok('id'); }
    if (a.startsWith('inspect -f {{.Config.Image}}')) return ok('odoo-v2:latest\n');
    if (a.startsWith('inspect -f {{.State.Running}}')) return state.gwRunning ? ok('true\n') : fail('No such container');
    if (a.startsWith('inspect -f {{json .NetworkSettings.Networks}}')) return ok(JSON.stringify(state.gwNets || {}));
    if (a.startsWith('rm -f')) return ok('');
    if (a.startsWith('run -d')) { state.gwRunning = true; state.gwNets = { bridge: {} }; return ok('cid'); }
    if (a.startsWith('network connect')) { state.gwNets = { ...(state.gwNets || {}), [args[2]]: {} }; return ok(''); }
    return fail(`unexpected: ${cmd} ${a}`);
  };
  return { execFile, calls };
}
const deps = (d, over = {}) => ({
  execFile: d.execFile, instanceId: 'odoo-v2', gatewayLimits: { memory: '256m', cpus: '0.5', pids: 128 },
  appDir: '/srv/app', socketPath: '/srv/app/data/run/ai.sock', uid: 1004, gid: 1004, ...over,
});

beforeEach(() => infra._resetInfraCacheForTesting());

describe('instanceId', () => {
  const saved = process.env.PLATFORM_CONTAINER;
  afterEach(() => { if (saved === undefined) delete process.env.PLATFORM_CONTAINER; else process.env.PLATFORM_CONTAINER = saved; });
  test('未設 → 丟例外（不猜實例，否則清孤兒容器會砍到別套平台）', () => {
    delete process.env.PLATFORM_CONTAINER;
    expect(() => infra.instanceId()).toThrow(/PLATFORM_CONTAINER/);
  });
  test('非法字元 → 丟例外；合法 → 原樣', () => {
    process.env.PLATFORM_CONTAINER = 'a b';
    expect(() => infra.instanceId()).toThrow();
    process.env.PLATFORM_CONTAINER = 'odoo-v2';
    expect(infra.instanceId()).toBe('odoo-v2');
  });
});

test('名稱帶實例 id', () => {
  expect(infra.infraNames('odoo-v2')).toEqual({ network: 'odoo-v2-agent-net', gateway: 'odoo-v2-gw' });
  expect(infra.agentImageTag('2.1.266')).toBe('aidev-agent:2.1.266');
});

test('映像檔不存在 → 丟例外並附 build 指令，不建網路也不起閘道', async () => {
  const d = fakeDocker({ image: false });
  await expect(infra.ensureAgentInfra(deps(d))).rejects.toThrow(/aidev-agent:2\.1\.266[\s\S]*docker build/);
  expect(d.calls.some(c => c[1] === 'network' && c[2] === 'create')).toBe(false);
  expect(d.calls.some(c => c[1] === 'run')).toBe(false);
});

test('全新主機：建 internal 網路、起閘道（唯讀、cap-drop、上限、蓋掉 entrypoint）、接上網路', async () => {
  const state = { image: true };
  const d = fakeDocker(state);
  const out = await infra.ensureAgentInfra(deps(d));
  expect(out).toEqual({ instanceId: 'odoo-v2', image: 'aidev-agent:2.1.266', network: 'odoo-v2-agent-net', gatewayHost: 'odoo-v2-gw' });
  const create = d.calls.find(c => c[1] === 'network' && c[2] === 'create');
  expect(create).toEqual(expect.arrayContaining(['--internal', '--label', 'aidev.instance=odoo-v2', 'odoo-v2-agent-net']));
  const run = d.calls.find(c => c[1] === 'run');
  expect(run).toEqual(expect.arrayContaining([
    '--name', 'odoo-v2-gw', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '256m', '--cpus', '0.5', '--pids-limit', '128', '--network', 'bridge', '--entrypoint', 'node',
    'type=bind,source=/srv/app/app/server/agent-gateway,target=/srv/app/app/server/agent-gateway,readonly',
    'type=bind,source=/srv/app/data/run,target=/srv/app/data/run,readonly',
    'AIDEV_AI_SOCKET=/srv/app/data/run/ai.sock', 'odoo-v2:latest', '/srv/app/app/server/agent-gateway/gateway.js',
  ]));
  // 閘道不持憑證：參數裡不得出現任何 -e 帶祕密
  expect(run.join(' ')).not.toMatch(/APP_SECRET|JWT_SECRET|DATABASE_URL|OAUTH/);
  expect(d.calls).toContainEqual(['docker', 'network', 'connect', 'odoo-v2-agent-net', 'odoo-v2-gw']);
});

test('已就緒：只檢查不重建', async () => {
  const d = fakeDocker({ image: true, network: true, gwRunning: true, gwNets: { bridge: {}, 'odoo-v2-agent-net': {} } });
  await infra.ensureAgentInfra(deps(d));
  expect(d.calls.some(c => c[1] === 'run' || c[1] === 'rm' || (c[1] === 'network' && c[2] !== 'inspect'))).toBe(false);
});

test('閘道在跑但沒接 internal 網路 → 補接', async () => {
  const d = fakeDocker({ image: true, network: true, gwRunning: true, gwNets: { bridge: {} } });
  await infra.ensureAgentInfra(deps(d));
  expect(d.calls).toContainEqual(['docker', 'network', 'connect', 'odoo-v2-agent-net', 'odoo-v2-gw']);
});

test('閘道上限未設 → 丟例外', async () => {
  const d = fakeDocker({ image: true, network: true });
  await expect(infra.ensureAgentInfra(deps(d, { gatewayLimits: { memory: null, cpus: '1', pids: 64 } }))).rejects.toThrow(/上限/);
});

test('60 秒內重複呼叫走快取', async () => {
  const d = fakeDocker({ image: true, network: true, gwRunning: true, gwNets: { 'odoo-v2-agent-net': {} } });
  let t = 1000;
  await infra.ensureAgentInfra(deps(d, { now: () => t }));
  const n = d.calls.length;
  t += 59000;
  await infra.ensureAgentInfra(deps(d, { now: () => t }));
  expect(d.calls.length).toBe(n);
  t += 2000;
  await infra.ensureAgentInfra(deps(d, { now: () => t }));
  expect(d.calls.length).toBeGreaterThan(n);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-infra.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-infra'`

- [ ] **Step 3：實作**

```js
// app/server/lib/agent-infra.js
/**
 * agent-infra.js — AI 容器需要的主機端設施（子專案 0 §4.1、§4.3）
 * 名字與 label 全帶實例 id（PLATFORM_CONTAINER）。映像檔不自動 build；網路與閘道缺了就建。
 * 成功結果快取 60 秒：每次 AI 執行都打三次 docker inspect 不值得；失敗不快取，下一次重新檢查。
 */
const path = require('path');
const { execFile: realExecFile } = require('child_process');

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const CACHE_MS = 60000;
let _cache = null;

function instanceId() {
  const id = process.env.PLATFORM_CONTAINER;
  if (!id || !NAME_RE.test(id)) {
    throw new Error('PLATFORM_CONTAINER 未設定或含非法字元：AI 容器、網路、閘道都靠它區分平台實例（見 start.sh 讀 data/config.json）');
  }
  return id;
}

function infraNames(id) { return { network: `${id}-agent-net`, gateway: `${id}-gw` }; }
function agentImageTag(version) { return `aidev-agent:${version}`; }

function run(execFile, cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || err.stderr || '') }));
      resolve(String(stdout || ''));
    });
  });
}

async function ensureAgentInfra(deps = {}) {
  const now = deps.now || Date.now;
  if (_cache && now() - _cache.at < CACHE_MS) return _cache.value;

  const execFile = deps.execFile || realExecFile;
  const id = deps.instanceId || instanceId();
  const { network, gateway } = infraNames(id);
  const appDir = deps.appDir || path.resolve(__dirname, '..', '..', '..');
  const socketPath = deps.socketPath || require('./ai-socket-server').aiSocketPath();

  const versionOut = deps.claudeVersion || await run(execFile, 'claude', ['--version']);
  const version = (String(versionOut).match(/\d+\.\d+\.\d+/) || [])[0];
  if (!version) throw new Error(`讀不到 claude 版本：${versionOut}`);
  const image = agentImageTag(version);
  try { await run(execFile, 'docker', ['image', 'inspect', image]); }
  catch {
    throw new Error(`AI 映像檔 ${image} 不存在。請在主機執行：docker build -f docker/agent/Dockerfile `
      + `--build-arg CLAUDE_CODE_VERSION=${version} --build-arg CONTEXT7_MCP_VERSION=<app/node_modules/@upstash/context7-mcp 的版本> -t ${image} docker/agent`);
  }

  try { await run(execFile, 'docker', ['network', 'inspect', network]); }
  catch { await run(execFile, 'docker', ['network', 'create', '--internal', '--label', `aidev.instance=${id}`, network]); }

  let running = false;
  try { running = (await run(execFile, 'docker', ['inspect', '-f', '{{.State.Running}}', gateway])).trim() === 'true'; }
  catch { running = false; }
  if (!running) {
    const lim = deps.gatewayLimits || require('./agent-sandbox-flag').getGatewayLimits();
    if (lim.memory == null || lim.cpus == null || lim.pids == null) {
      throw new Error('出口閘道的資源上限未設定（gateway_memory／gateway_cpus／gateway_pids，見 PUT /api/admin/agent-sandbox）');
    }
    const platformImage = (await run(execFile, 'docker', ['inspect', '-f', '{{.Config.Image}}', id])).trim();
    const gwDir = path.join(appDir, 'app', 'server', 'agent-gateway');
    const runDir = path.dirname(socketPath);
    const uid = deps.uid ?? process.getuid();
    const gid = deps.gid ?? process.getgid();
    await run(execFile, 'docker', ['rm', '-f', gateway]).catch(() => {});
    await run(execFile, 'docker', [
      'run', '-d', '--restart', 'unless-stopped', '--name', gateway,
      '--label', `aidev.instance=${id}`, '--label', 'aidev.gateway=1',
      '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', String(lim.memory), '--memory-swap', String(lim.memory), '--cpus', String(lim.cpus), '--pids-limit', String(lim.pids),
      '--network', 'bridge',
      '--mount', `type=bind,source=${gwDir},target=${gwDir},readonly`,
      '--mount', `type=bind,source=${runDir},target=${runDir},readonly`,
      '-e', `AIDEV_AI_SOCKET=${socketPath}`,
      '--entrypoint', 'node', platformImage, path.join(gwDir, 'gateway.js'),
    ]);
  }
  const nets = JSON.parse((await run(execFile, 'docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', gateway])) || '{}');
  if (!nets[network]) await run(execFile, 'docker', ['network', 'connect', network, gateway]);

  const value = { instanceId: id, image, network, gatewayHost: gateway };
  _cache = { at: now(), value };
  return value;
}

function _resetInfraCacheForTesting() { _cache = null; }

module.exports = { instanceId, infraNames, agentImageTag, ensureAgentInfra, _resetInfraCacheForTesting };
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-infra.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/agent-infra.js app/server/tests/agent-infra.test.js
git commit -m "[AgentSandbox]: AI 容器要有只接 internal 網路的出口與不持憑證的閘道，名字帶實例 id 才不會在同主機砍到別套平台

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task M6（量測）：閘道真的擋得住、`/ai` 經唯讀掛載的 socket 連得到、容器碰不到宿主

**為什麼**：Task 2.2／2.3 的單元測試跑在本機 loopback；真正的隔離取決於 docker 的 `--internal` 網路、閘道雙網路、ro bind mount 上的 unix socket——這些只能實機驗。另外 X20：宿主 loopback 8772 是免密碼 superuser，AI 容器絕對不能碰到。

**前置**：Task 2.1 映像已 build。本量測**不動正式平台**：用 worktree 自己的 `data/run/` 起一個假的 `/ai` socket，閘道用暫定上限（`256m／0.5／128`，只供量測，正式值在第 3 部 M10 定）。

**Files:** 無（結果記進 `docs/superpowers/plans/2026-09-15-agent-sandbox-M1-table.md` 的「M6」段）

- [ ] **Step 1：起假的 `/ai` socket、internal 網路與閘道**（實例 id 用量測專用的 `aidevm6`，名字與正式 `odoo-v2-*` 不撞；閘道參數與 `agent-infra.js` 的 `run -d` 逐項相同——不呼叫 `ensureAgentInfra`，因為它要 `docker inspect <實例id>` 取平台映像，而 `aidevm6` 不是真的平台容器）

```bash
WT=/home/odoo/odoo-v2/.claude/worktrees/agent-sandbox
mkdir -p "$WT/data/run" && chmod 700 "$WT/data/run"
node -e "const s=require('http').createServer((q,r)=>r.end('fake-ai '+q.url));s.listen(process.argv[1],()=>require('fs').chmodSync(process.argv[1],0o600))" "$WT/data/run/ai.sock" &
FAKE_PID=$!
```

```bash
GWDIR="$WT/app/server/agent-gateway"
docker network create --internal --label aidev.instance=aidevm6 aidevm6-agent-net
docker run -d --name aidevm6-gw --label aidev.instance=aidevm6 --label aidev.gateway=1 --user "$(id -u):$(id -g)" \
  --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 128 \
  --network bridge --mount "type=bind,source=$GWDIR,target=$GWDIR,readonly" \
  --mount "type=bind,source=$WT/data/run,target=$WT/data/run,readonly" \
  -e "AIDEV_AI_SOCKET=$WT/data/run/ai.sock" --entrypoint node odoo-v2:latest "$GWDIR/gateway.js"
docker network connect aidevm6-agent-net aidevm6-gw
sleep 2; docker logs aidevm6-gw
```
Expected：log 有 `listen 3128`、`listen 8080`

- [ ] **Step 2：從 agent 網路上的丟棄式容器探測**

```bash
CV=$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
AGW=$(docker network inspect aidevm6-agent-net --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
D0=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
HOSTIP=$(hostname -I | awk '{print $1}')
docker run --rm --network aidevm6-agent-net --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp --cap-drop ALL \
  -e HTTPS_PROXY=http://aidevm6-gw:3128 --entrypoint bash "aidev-agent:$CV" -c "
    p() { if timeout 3 bash -c \"</dev/tcp/\$1/\$2\" 2>/dev/null; then echo \"REACHABLE \$1:\$2\"; else echo \"blocked \$1:\$2\"; fi; }
    for h in 127.0.0.1 host.docker.internal $AGW $D0 $HOSTIP; do for port in 8771 8772 22 21000 5416; do p \$h \$port; done; done
    echo anthropic=\$(curl -s -o /dev/null -w '%{http_code}' -x \$HTTPS_PROXY https://api.anthropic.com/)
    echo context7=\$(curl -s -o /dev/null -w '%{http_code}' -x \$HTTPS_PROXY https://context7.com/)
    echo example=\$(curl -s -o /dev/null -w '%{http_code}' -x \$HTTPS_PROXY https://example.com/)
    echo direct=\$(curl -s -m 5 -o /dev/null -w '%{http_code}' https://api.anthropic.com/ --noproxy '*')
    echo ai=\$(curl -s http://aidevm6-gw:8080/ai/ping)
    echo api=\$(curl -s -o /dev/null -w '%{http_code}' http://aidevm6-gw:8080/api/tasks)
  " > /tmp/claude-m6.out 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m6.out
cat /tmp/claude-m6.out; docker logs aidevm6-gw 2>&1 | grep deny
```
Expected（全部要成立）：
- 沒有任何 `REACHABLE` 行（尤其 `127.0.0.1:8772`、`host.docker.internal:8772`、`$D0:8772`——X20）
- `anthropic` 與 `context7` 是 HTTP 狀態碼（非 `000`）；`example=000`（CONNECT 被 403，curl 回 000）；`direct=000`
- `ai=fake-ai /ai/ping`（證明**唯讀 bind mount 上的 unix socket 連得到**）；`api=404`
- 閘道 log 有 `"type":"deny","dest":"example.com:443"`

- [ ] **Step 3：收掉量測用設施**（只刪本量測建的東西，名字都帶 `aidevm6`）

```bash
docker rm -f aidevm6-gw; docker network rm aidevm6-agent-net; kill $FAKE_PID; rm -f "$WT/data/run/ai.sock"
docker ps -a --filter label=aidev.instance=aidevm6 --format '{{.Names}}'
```
Expected：最後一行沒有輸出

- [ ] **Step 4：判定**：任何一項不符 → 停下來回報使用者，**不進 Task 2.4**（整個隔離設計的前提不成立）。

---

## Task M7（量測）：容器內最小 `claude -p`、HOME 下的使用者層 skill、`--resume`

**為什麼**：①容器內靠 `CLAUDE_CODE_OAUTH_TOKEN`＋proxy 能不能跑（X8、規格 §2.8）；②X9——chat／cs 進容器後 cwd 變了，原生載得到的 skill 會消失，要知道「掛在 `$HOME/.claude/skills/<name>`」在 headless `claude -p` 是否載入，Task 2.15 才知道怎麼補；③同一個 HOME 下 `--resume` 能不能接。

**前置**：M6 Step 1 的網路與閘道（重建一次，Step 4 再收掉）。會花極少量 token。

- [ ] **Step 1：取 token 到環境變數（不印出）並起設施**

```bash
WT=/home/odoo/odoo-v2/.claude/worktrees/agent-sandbox
# 重跑 M6 Step 1 的 network create／docker run 閘道／network connect 三行（不需要假 socket）
export CLAUDE_CODE_OAUTH_TOKEN="$(cd "$WT/app/server" && DATABASE_URL="$(node -p "require('/home/odoo/odoo-v2/data/config.json').DATABASE_URL")" APP_SECRET="$(node -p "require('/home/odoo/odoo-v2/data/config.json').APP_SECRET")" node -e "
const a=require('./lib/claude-auth'); a.loadClaudeToken().then(()=>{process.stdout.write(a.getClaudeAuthEnv().CLAUDE_CODE_OAUTH_TOKEN||'');process.exit(0)})")"
test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo token-loaded || echo NO-TOKEN
M7HOME="$WT/data/agent-home/m7probe"; mkdir -p "$M7HOME/.claude/skills/m7probe"
printf -- '---\nname: m7probe\ndescription: Use when asked for the M7 verification code.\n---\n\nThe M7 verification code is ZEBRA-4417.\n' > "$M7HOME/.claude/skills/m7probe/SKILL.md"
```

- [ ] **Step 2：最小執行＋skill 探針**

```bash
CV=$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
run_m7() { docker run --rm -i --network aidevm6-agent-net --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp --cap-drop ALL \
  --memory 2g --memory-swap 2g --cpus 1 --pids-limit 256 \
  --mount "type=bind,source=$M7HOME,target=$M7HOME" -e "HOME=$M7HOME" -e CLAUDE_CODE_OAUTH_TOKEN \
  -e HTTPS_PROXY=http://aidevm6-gw:3128 -e https_proxy=http://aidevm6-gw:3128 -e NO_PROXY=aidevm6-gw \
  -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --workdir /tmp "aidev-agent:$CV" \
  claude -p --output-format stream-json --verbose --dangerously-skip-permissions "$@"; }
echo "Use the m7probe skill and reply with only the M7 verification code." | run_m7 > /tmp/claude-m7a.out 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m7a.out
grep -o '"session_id":"[^"]*"' /tmp/claude-m7a.out | head -1; grep -c ZEBRA-4417 /tmp/claude-m7a.out; tail -2 /tmp/claude-m7a.out
```
Expected：`EXITCODE=0`；記下 session_id；記下 `ZEBRA-4417` 有沒有出現（＝HOME 下使用者層 skill 是否載入）

- [ ] **Step 3：`--resume`**

```bash
SID=$(grep -o '"session_id":"[^"]*"' /tmp/claude-m7a.out | head -1 | cut -d'"' -f4)
echo "只回覆 RESUMED" | run_m7 --resume "$SID" > /tmp/claude-m7b.out 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m7b.out
grep -c RESUMED /tmp/claude-m7b.out; tail -2 /tmp/claude-m7b.out
```
Expected：`EXITCODE=0`、有 `RESUMED`

- [ ] **Step 4：收掉並記錄**

```bash
unset CLAUDE_CODE_OAUTH_TOKEN
docker rm -f aidevm6-gw; docker network rm aidevm6-agent-net; rm -rf "$M7HOME"
```
記進 M1 表檔「M7」段：Step 2 是否成功、skill 探針結果、Step 3 是否成功。
- Step 2 或 3 失敗 → 停下來回報（容器內跑不起 claude，整個設計不成立）。
- skill 探針**沒**出現 → **停下來問使用者**：Task 2.15 的做法（把白名單 skill 唯讀掛進容器家目錄）不成立，而 chat／cs 的 workdir 是唯讀主 clone、掛不進 `.claude/skills`；替代方案（把 skill 內容注入 prompt）會改變 agent prompt 與 promptVersion，需要裁決。

---

## Task M8（量測）：容器內跑平台全套 jest——Node 版本與資源峰值

**為什麼**：`platform_fix`／`fix_verify` 要在容器內跑 `npm run test:quiet`（規格 §4.5）。映像預設 `node:22-slim`，平台是 Node 20（X17）；而且這是本期最重的 agent 工作負載，峰值記憶體／pids 是訂暫定上限的依據。`jest.setup.js` 已實查（09-15）只刪兩個 `NGINX_*` 環境變數、不需要任何祕密。

**前置**：Task 0 的基線數字；Task 2.1 映像。

- [ ] **Step 1：容器內全跑，同時每 2 秒取樣資源**

```bash
WT=/home/odoo/odoo-v2/.claude/worktrees/agent-sandbox
CV=$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
NM=$(readlink -f "$WT/app/node_modules")
( while sleep 2; do docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}} {{.PIDs}}' aidev-m8 2>/dev/null; done ) > /tmp/claude-m8-stats.txt &
SAMPLER=$!
docker run --rm --name aidev-m8 --network none --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp --cap-drop ALL \
  --memory 8g --memory-swap 8g --cpus 4 --pids-limit 4096 \
  --mount "type=bind,source=$WT,target=$WT" --mount "type=bind,source=$NM,target=$NM,readonly" \
  -e HOME=/tmp --workdir "$WT/app" --entrypoint npm "aidev-agent:$CV" run test:quiet > /tmp/claude-m8.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m8.txt
kill $SAMPLER
grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-m8.txt
sort -h /tmp/claude-m8-stats.txt | tail -3
```
（`8g／4／4096` 只是量測用的寬鬆上限，不是正式值。）

- [ ] **Step 2：判定 Node 版本**：`Tests:` 與 Task 0 基線（Node 20、宿主）相同 → 維持 `node:22-slim`。多出紅燈 → 對每支紅的單獨在容器內重跑一次（rules/always 2），確認是 Node 22 差異（非 docker／網路類測試本來就跑不起來）後，改以 `--build-arg NODE_IMAGE=node:20-slim` 重 build（**需要 pull `node:20-slim`，先問使用者**），再跑一次 Step 1。記下「容器內已知跑不起來的測試清單」（例如需要 docker CLI 的），第 3 部 Task 3.2 要把它寫進 `platform_fix` 的基線比對說明。

- [ ] **Step 3：記錄峰值**：記下 `MemUsage` 最大值、`PIDs` 最大值，存進 M1 表檔「M8」段。第 3 部 M10 以它當暫定上限的依據。

---

## Task M9（量測）：超過記憶體上限時 `docker run` 的 exit code

**為什麼**：規格 §6「超過記憶體上限（exit 137）→ 錯誤訊息明寫記憶體上限、分類 env 不重試」。容器帶 `--rm`，結束後 `docker inspect .State.OOMKilled` 已查不到，只能靠 exit code；要確認 docker CLI 在這台真的回 137。

- [ ] **Step 1**

```bash
CV=$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
docker run --rm --network none --memory 64m --memory-swap 64m --entrypoint node "aidev-agent:$CV" -e "const a=[];for(;;)a.push(Buffer.alloc(1e6,1))" > /tmp/claude-m9.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m9.txt
cat /tmp/claude-m9.txt
docker run --rm --network none --entrypoint sh "aidev-agent:$CV" -c 'kill -KILL $$'; echo "SELFKILL_EXIT=$?"
```
Expected：`EXITCODE=137`、stderr 空或只有一行；`SELFKILL_EXIT=137`（程序自己被 SIGKILL 也是 137 ⇒ 137 只能說「可能是記憶體上限」，Task 2.6 的訊息照這個措辭）。實際值不是 137 → 把 Task 2.6 的 `OOM_EXIT_CODE` 改成實測值並回報。

---
## Task 2.4：辨識「`--resume` 找不到 session」並在任務時間軸留說明

**前置**：Task M2 已抄下字面。

**Files:**
- Create: `app/server/pipeline/session-signature.js`
- Modify: `app/server/pipeline/claude-runner.js`（close handler，09-15 第 326-357 行；stdout 非 JSON 分支第 301-304 行）
- Modify: `app/server/pipeline/task-agent.js:345-348`（analysis resume）、`task-agent.js:586-590`（spec_tour runOpts）：帶 `logSessionMissing: false`（這兩處已自己寫 task_logs，計畫 X4）
- Test: `app/server/tests/session-signature.test.js`、`app/server/tests/claude-runner-session.test.js`

**Interfaces:**
- Produces：
  - `SAMPLE_LINE: string`（M2 實測整行）、`MISSING_SESSION: RegExp[]`、`looksLikeMissingSession(text) → boolean`、`missingSessionReason(text) → string|null`
  - `runClaude` 新增：帶 `resumeSessionId` 且失敗文字命中 → reject `claudeStatus: 'session_missing'`；有 `taskId` 且 `opts.logSessionMissing !== false` → 寫一列 `task_logs`（role `ai`）
- 既有降級行為不變：qa／with-resume／analysis／spec_tour 對「非 timeout 的續接失敗」本來就改跑 fresh

- [ ] **Step 1：寫 `session-signature.js` 的失敗測試**

```js
// app/server/tests/session-signature.test.js
// 意圖：切換到容器後 HOME 換了，舊 session 必定找不到。要能分辨「session 不在」與「CLI 其他錯誤」，
// 時間軸才寫得出人看得懂的原因。比照 sandbox-signature.js：只收 CLI 自己印的字面，不收籠統詞。
const sig = require('../pipeline/session-signature');

// 閘門：佔位文字本身也含 UUID，不擋的話沒貼 M2 實測值測試照樣綠
test('SAMPLE_LINE 已換成 M2 實測值（不是計畫裡的佔位文字）', () => {
  expect(sig.SAMPLE_LINE).not.toMatch(/M2 Step 2|逐字抄下/);
});

test('M2 實測的那行（換一個 session id）也認得出來', () => {
  const other = sig.SAMPLE_LINE.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, '12345678-abcd-4def-8abc-1234567890ab');
  expect(sig.looksLikeMissingSession(`something before\n${other}\nafter`)).toBe(true);
  expect(sig.missingSessionReason(other)).toBe(other.trim().slice(0, 300));
});

test.each([
  'Error: Not logged in',
  'API Error: 529 overloaded',
  'claude exited with code 1',
  'No such file or directory',
  'session',
])('其他錯誤不誤判：%s', (t) => {
  expect(sig.looksLikeMissingSession(t)).toBe(false);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/session-signature.test.js`
Expected：FAIL，`Cannot find module '../pipeline/session-signature'`

- [ ] **Step 3：實作**（把 M2 Step 2 抄下的**整行**原樣貼進 `SAMPLE_LINE`；它必須含一個 UUID——M2 用的是 `00000000-0000-4000-8000-000000000000`）

```js
// app/server/pipeline/session-signature.js
/**
 * session-signature.js — 「--resume 指定的 session 不存在」的 CLI 字面（子專案 0 §6）
 * SAMPLE_LINE 是 Task M2 在這台主機以不存在的 session id 實測取得的整行，不是猜的。
 * 比對時只把其中的 UUID 換成萬用樣式，其餘逐字；claude 升版後字面若變了，這支測試不會紅，
 * 但續接失敗仍會照舊降級 fresh（只是時間軸少一行說明）——升版時重跑 M2。
 */
const SAMPLE_LINE = '（M2 Step 2 逐字抄下的整行，含 00000000-0000-4000-8000-000000000000）';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineToPattern(line) {
  const m = UUID_RE.exec(line);
  if (!m) throw new Error('SAMPLE_LINE 必須含 M2 實測時用的 session UUID');
  const before = escapeRe(line.slice(0, m.index).trim());
  const after = escapeRe(line.slice(m.index + m[0].length).trim());
  return new RegExp(`${before}\\s*[0-9a-f-]{36}\\s*${after}`, 'i');
}

const MISSING_SESSION = [lineToPattern(SAMPLE_LINE)];

function missingSessionReason(text) {
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (MISSING_SESSION.some(re => re.test(line))) return line.trim().slice(0, 300);
  }
  return null;
}

function looksLikeMissingSession(text) { return missingSessionReason(text) !== null; }

module.exports = { SAMPLE_LINE, MISSING_SESSION, looksLikeMissingSession, missingSessionReason };
```
⚠ 沒換掉佔位文字時 Step 1 的第一條測試會紅（刻意的閘門）；貼上的行沒有 UUID 時 `lineToPattern` 在載入時就丟例外。若 M2 發現字面在 stdout 的 JSON `result` 事件裡，`SAMPLE_LINE` 抄 `result` 欄位的文字值。

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/session-signature.test.js`
Expected：PASS

- [ ] **Step 5：寫 runner 的失敗測試**

```js
// app/server/tests/claude-runner-session.test.js
// 意圖：續接輪找不到 session 時，runner 要標出 session_missing（呼叫端照舊降級 fresh），
// 並在任務時間軸留一行人看得懂的原因——否則使用者只看到這一關莫名多跑一次、慢了一倍（rules/pipeline 77）。
process.env.CLAUDE_RATE_LIMIT_CACHE = require('path').join(require('os').tmpdir(), 'test-claude-rate-limit-session.json');
const { EventEmitter } = require('events');
const { newDb } = require('pg-mem');
jest.mock('child_process', () => ({ spawn: jest.fn(), execFile: jest.fn() }));

let dbModule, taskDbId;
function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  c.kill = jest.fn(); c.once = c.once.bind(c);
  return c;
}
const flush = () => new Promise(r => setTimeout(r, 30));

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('sess','x','S') RETURNING id");
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,folder_name,odoo_version) VALUES ('sp','sp','17.0') RETURNING id");
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (project_id, user_id, source, task_id, title, status) VALUES ($1,$2,'odoo','task_sess_1','t','qa_running') RETURNING id", [p.id, u.id]);
  taskDbId = t.id;
});
afterAll(() => dbModule._setPoolForTesting(null));

async function runWith(emit, opts) {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('x', { agentType: 'qa', taskId: taskDbId, resumeSessionId: 'old-session', ...opts });
  emit(c);
  return p.then(() => null, e => e);
}
const line = () => require('../pipeline/session-signature').SAMPLE_LINE;

test('字面在 stderr → session_missing，且寫一列 task_logs', async () => {
  const err = await runWith(c => { c.stderr.emit('data', `${line()}\n`); c.emit('close', 1); });
  expect(err.claudeStatus).toBe('session_missing');
  await flush();
  const { rows } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND content LIKE '[續接]%'", [taskDbId]);
  expect(rows.length).toBe(1);
});

test('字面在 stdout 的 result 事件 → 同樣認得', async () => {
  const err = await runWith(c => {
    c.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: line() })}\n`);
    c.emit('close', 1);
  });
  expect(err.claudeStatus).toBe('session_missing');
});

test('logSessionMissing:false（analysis／spec_tour 已自己寫）→ 不重複寫', async () => {
  await dbModule.query("DELETE FROM task_logs WHERE task_id=$1", [taskDbId]);
  await runWith(c => { c.stderr.emit('data', `${line()}\n`); c.emit('close', 1); }, { logSessionMissing: false });
  await flush();
  const { rows } = await dbModule.query("SELECT 1 FROM task_logs WHERE task_id=$1", [taskDbId]);
  expect(rows.length).toBe(0);
});

test('沒有 resumeSessionId 時同樣文字不算 session_missing', async () => {
  const err = await runWith(c => { c.stderr.emit('data', `${line()}\n`); c.emit('close', 1); }, { resumeSessionId: undefined });
  expect(err.claudeStatus).toBe('error');
});

test('其他失敗照舊是 error', async () => {
  const err = await runWith(c => { c.stderr.emit('data', 'boom\n'); c.emit('close', 1); });
  expect(err.claudeStatus).toBe('error');
});
```

- [ ] **Step 6：跑測試確認失敗**

Run: `cd app && npx jest server/tests/claude-runner-session.test.js`
Expected：FAIL（`claudeStatus` 是 `error`）

- [ ] **Step 7：改 `claude-runner.js`**

檔頭 require 區加：
```js
const { missingSessionReason } = require('./session-signature');
```
`let errorResult = null;` 之後加：
```js
    // 非 JSON 的 stdout 行（CLI 自己印的訊息）：辨識 session 遺失要用，最多留 4000 字
    let plainOut = '';
```
stdout 的 `catch {` 分支（`if (!authReason && looksLikeAuthFailure(line))` 那行之前）加：
```js
          if (plainOut.length < 4000) plainOut += `${line}\n`;
```
close handler 裡 `if (auth) reject(...)` 改成：
```js
          const missing = resumeSessionId ? missingSessionReason(`${stderr}\n${errorResult || ''}\n${plainOut}`) : null;
          if (auth) reject(fail(new Error(`Claude CLI 未登入或認證失效：${auth}`), 'auth'));
          else if (missing) {
            // 續接的 session 不在（換到容器後 HOME 不同、或 CLI 清掉舊檔）。呼叫端本來就會降級 fresh；
            // 這裡只負責把原因標清楚，並在時間軸留一行（analysis／spec_tour 自己寫，帶 logSessionMissing:false）
            if (taskId && opts.logSessionMissing !== false) {
              query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
                [taskId, '[續接] 上一輪對話的 session 已不存在（多半是 AI 改在容器內執行、家目錄換了），本輪改以完整脈絡重跑']).catch(() => {});
            }
            reject(fail(new Error(`找不到要續接的 session（${resumeSessionId}）：${missing}`), 'session_missing'));
          }
```
（`else {` 之後原本的 externalKill 分支原封不動。）

- [ ] **Step 8：analysis 與 spec_tour 帶 `logSessionMissing: false`**

`task-agent.js` analysis resume 那次呼叫（`resumeSessionId: task.analysis_session_id, model: retryAgent.model, agentType: 'analysis'`）改為：
```js
          resumeSessionId: task.analysis_session_id, model: retryAgent.model, agentType: 'analysis', logSessionMissing: false
```
spec_tour 的 `const runOpts = {` 物件內加一個屬性：
```js
    logSessionMissing: false,
```

- [ ] **Step 9：跑測試確認通過（含既有 runner／resume 測試）**

Run: `cd app && npx jest server/tests/claude-runner-session.test.js server/tests/session-signature.test.js server/tests/claude-runner.test.js server/tests/qa-agent.test.js server/tests/with-resume.test.js`
Expected：PASS

- [ ] **Step 10：Commit**

```bash
git add app/server/pipeline/session-signature.js app/server/pipeline/claude-runner.js app/server/pipeline/task-agent.js app/server/tests/session-signature.test.js app/server/tests/claude-runner-session.test.js
git commit -m "[AgentSandbox]: 換到容器後舊 session 必定找不到，續接失敗要標出是 session 不在並在時間軸說明，而不是只看到這關莫名重跑

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 2.5：`sandbox-run.js`——判斷要不要進容器、準備一次容器執行

**Files:**
- Create: `app/server/pipeline/sandbox-run.js`
- Modify: `.gitignore`（`app/server/pipeline/mcp/context7.local.json` 那行之後）
- Test: `app/server/tests/sandbox-run.test.js`

**Interfaces:**
- Consumes：`profileFor`、`runScope`（1.1）；`issueRunToken`、`revokeRun`、`canRun`（1.2）；`sandboxAppliesTo`、`getSandboxLimits`（1.3）；`buildAgentRunArgs`（1.4）；`resolveSandboxMounts`（1.5）；`ensureAgentInfra`（2.3）；`getClaudeAuthEnv`（既有 `lib/claude-auth.js`）；`MCP_PROFILES`（既有 `claude-runner.js:20`）；`getContext7ApiKey`（既有 `lib/context7-auth.js`）；`createPlatformCleanWorktree`、`removePlatformCleanWorktree`（第 3 部 Task 3.1，預設 lazy require，測試注入）
- Produces：
  - `resolveSandboxPlan(agentType, opts, deps?) → Promise<null | { profile, projectId: number|null }>`（agentType 未登記丟例外；`opts.projectId` 沒給且 profile 是 project 類、有 `opts.taskId`（`tasks.id`）→ 查 DB 補）
  - `prepareSandboxRun({ claudeArgs: string[], opts, profile, projectId }, deps?) → Promise<{ argv, childEnv, containerName, runId, kill(): void, release(): Promise<void> }>`
  - `sandboxMcpConfigPath(agentType, deps?) → string`（有登記 context7 的 agentType→生成 `mcp/context7.sandbox.local.json`，command 為映像內的 `context7-mcp`；其餘→`mcp/none.json`）
  - `replaceArg(args, flag, value) → string[]`
- 保證：準備過程任何一步失敗 → 已簽發的通行證作廢、已建的乾淨 worktree 刪除、**往外丟例外**（呼叫端不得改走 `spawn('claude')`）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/sandbox-run.test.js
// 意圖：這支把「profile＋專案＋開關」變成一次真正的 docker run。要鎖住：
//  - 開關沒涵蓋的 agent 回 null（照舊路徑），涵蓋的一定走容器；未登記的 agentType 直接丟例外
//  - 容器 env 帶的是本次通行證與閘道位址，不是全域通行碼與 localhost
//  - 沒有 Claude token 就失敗（不退回容器外的憑證檔）；任何準備失敗都收回通行證與 worktree
//  - 停止＝docker kill 容器名（只殺 docker CLI 不會停容器，會繼續燒錢，規格 §6）
process.env.APP_SECRET = 'test-sandbox-run';
const path = require('path');
const sr = require('../pipeline/sandbox-run');
const rt = require('../lib/agent-run-token');
const flag = require('../lib/agent-sandbox-flag');

const APP = path.resolve(__dirname, '..', '..', '..');
function deps(over = {}) {
  const calls = { kill: [], wtRemoved: [] };
  return {
    calls,
    d: {
      ensureAgentInfra: async () => ({ instanceId: 'odoo-v2', image: 'aidev-agent:2.1.266', network: 'odoo-v2-agent-net', gatewayHost: 'odoo-v2-gw' }),
      getClaudeAuthEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x' }),
      getSandboxLimits: () => ({ memory: '4g', cpus: '2', pids: 512 }),
      resolveSandboxMounts: async (ctx) => ({ mounts: [], workdir: ctx.platformWorktree || ctx.home }),
      mkdirSync: () => {},
      execFile: (cmd, args, cb) => { calls.kill.push([cmd, ...args]); cb && cb(null); },
      createPlatformCleanWorktree: async (runId) => path.join(APP, '.claude', 'worktrees', `ro-${runId}`),
      removePlatformCleanWorktree: async (wt) => { calls.wtRemoved.push(wt); },
      sandboxMcpConfigPath: () => path.join(APP, 'app', 'server', 'pipeline', 'mcp', 'none.json'),
      query: async () => ({ rows: [{ project_id: 7 }] }),
      getuid: () => 1004, getgid: () => 1004,
      ...over,
    },
  };
}
const ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
  '--strict-mcp-config', '--mcp-config', '/host/only/context7.local.json', '--settings', '/x/scan-guard.settings.json'];

beforeEach(() => rt._resetRunsForTesting());

describe('resolveSandboxPlan', () => {
  afterEach(() => flag._setFlagStateForTesting({ mode: 'off' }));
  test('projects 模式：由 tasks.id 補出專案，清單內才進容器', async () => {
    flag._setFlagStateForTesting({ mode: 'projects', projectIds: new Set([7]) });
    const { d } = deps();
    await expect(sr.resolveSandboxPlan('qa', { taskId: 70 }, d)).resolves.toMatchObject({ projectId: 7 });
    const { d: d2 } = deps({ query: async () => ({ rows: [{ project_id: 8 }] }) });
    await expect(sr.resolveSandboxPlan('qa', { taskId: 71 }, d2)).resolves.toBeNull();
  });
  test('未登記 agentType → 丟例外', async () => {
    flag._setFlagStateForTesting({ mode: 'all' });
    await expect(sr.resolveSandboxPlan('mystery', {}, deps().d)).rejects.toThrow(/mystery/);
  });
});

describe('prepareSandboxRun', () => {
  const { profileFor } = require('../lib/agent-profiles');

  test('argv 帶本次通行證（驗得過）與閘道位址；mcp 設定換成容器版', async () => {
    const { d } = deps();
    const run = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'qa', taskId: 70 }, profile: profileFor('qa'), projectId: 7 }, d);
    expect(run.argv).toContain('AIDEV_AI_BASE=http://odoo-v2-gw:8080');
    expect(run.argv).toContain('HTTPS_PROXY=http://odoo-v2-gw:3128');
    expect(run.argv).toContain('aidev.scope=project-7');
    expect(run.argv).not.toContain('/host/only/context7.local.json');
    expect(run.argv[run.argv.indexOf('--mcp-config') + 1]).toMatch(/none\.json$/);
    expect(rt.verifyRunToken(run.childEnv.AIDEV_AI_TOKEN).ok).toBe(true);
    expect(run.childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-x');
    await run.release();
    expect(rt.verifyRunToken(run.childEnv.AIDEV_AI_TOKEN).ok).toBe(false);
  });

  test('kill → docker kill <容器名>', async () => {
    const { d, calls } = deps();
    const run = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'chat' }, profile: profileFor('chat'), projectId: 7 }, d);
    run.kill();
    expect(calls.kill).toContainEqual(['docker', 'kill', run.containerName]);
  });

  test('沒有 Claude token → 丟例外，不簽發通行證', async () => {
    const { d } = deps({ getClaudeAuthEnv: () => ({}) });
    await expect(sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'qa' }, profile: profileFor('qa'), projectId: 7 }, d)).rejects.toThrow(/token/);
    expect(rt.activeRunCount()).toBe(0);
  });

  test('呼叫端 env 帶白名單外的 key（例如整包 gitEnv）→ 丟例外並作廢通行證', async () => {
    const { d } = deps();
    await expect(sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'coding', env: { GIT_PAT: 'ghp' } }, profile: profileFor('coding'), projectId: 7 }, d)).rejects.toThrow(/GIT_PAT/);
    expect(rt.activeRunCount()).toBe(0);
  });

  test('內部健檢：建乾淨 worktree，release 時刪掉；scope 為 internal-audit', async () => {
    const { d, calls } = deps();
    const run = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'workflow_health' }, profile: profileFor('workflow_health'), projectId: null }, d);
    expect(run.argv).toContain('aidev.scope=internal-audit');
    await run.release();
    expect(calls.wtRemoved).toEqual([path.join(APP, '.claude', 'worktrees', `ro-${run.runId}`)]);
  });

  test('掛載解析失敗 → worktree 也要收掉、通行證作廢', async () => {
    const { d, calls } = deps({ resolveSandboxMounts: async () => { throw new Error('boom'); } });
    await expect(sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'fix_review' }, profile: profileFor('fix_review'), projectId: null }, d)).rejects.toThrow('boom');
    expect(calls.wtRemoved.length).toBe(1);
    expect(rt.activeRunCount()).toBe(0);
  });

  test('infra 不可用 → 丟例外（呼叫端不得退回無容器）', async () => {
    const { d } = deps({ ensureAgentInfra: async () => { throw new Error('AI 映像檔不存在'); } });
    await expect(sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'qa' }, profile: profileFor('qa'), projectId: 7 }, d)).rejects.toThrow(/映像檔/);
  });

  test('canRun 回 false → 丟例外', async () => {
    const { d } = deps({ canRun: async () => false });
    await expect(sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'qa' }, profile: profileFor('qa'), projectId: 7 }, d)).rejects.toThrow(/未獲准/);
  });
});

test('replaceArg 只換旗標後面那個值', () => {
  expect(sr.replaceArg(['-a', '1', '--mcp-config', 'old', '-b'], '--mcp-config', 'new')).toEqual(['-a', '1', '--mcp-config', 'new', '-b']);
  expect(() => sr.replaceArg(['-a'], '--mcp-config', 'x')).toThrow();
});

test('sandboxMcpConfigPath：有 context7 的關卡生成容器版設定（指令是映像內的 context7-mcp），其餘 none.json', () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpsb-'));
  const p = sr.sandboxMcpConfigPath('coding', { mcpDir: dir, apiKey: 'ctx7sk-test' });
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  expect(cfg).toEqual({ mcpServers: { context7: { command: 'context7-mcp', args: [], env: { CONTEXT7_API_KEY: 'ctx7sk-test' } } } });
  expect(sr.sandboxMcpConfigPath('chat-title', { mcpDir: dir, apiKey: 'x' })).toBe(path.join(dir, 'none.json'));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/sandbox-run.test.js`
Expected：FAIL，`Cannot find module '../pipeline/sandbox-run'`

- [ ] **Step 3：實作**

```js
// app/server/pipeline/sandbox-run.js
/**
 * sandbox-run.js — 一次 AI 執行的容器準備（子專案 0 §5）
 *   1. resolveSandboxPlan：開關有沒有涵蓋這個 agent（沒有＝null，呼叫端走原本的 spawn('claude')）
 *   2. prepareSandboxRun：canRun → infra → 通行證 → （內部健檢類）乾淨 worktree → 掛載 → docker 參數
 * 任何一步失敗都往外丟：呼叫端不得退回無容器執行（規格 §6、rules/pipeline 59）。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { profileFor, runScope } = require('../lib/agent-profiles');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TIMEOUT_MS = parseInt(process.env.CLAUDE_AGENT_TIMEOUT_MS || '2400000', 10);
const TOKEN_GRACE_MS = 10 * 60 * 1000;

function replaceArg(args, flag, value) {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) throw new Error(`參數裡找不到 ${flag}`);
  const out = [...args];
  out[i + 1] = value;
  return out;
}

function sandboxMcpConfigPath(agentType, deps = {}) {
  const mcpDir = deps.mcpDir || path.join(__dirname, 'mcp');
  const { MCP_PROFILES } = require('./claude-runner');
  if (!MCP_PROFILES[agentType]) return path.join(mcpDir, 'none.json');
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : require('../lib/context7-auth').getContext7ApiKey();
  const server = { command: 'context7-mcp', args: [] };
  if (apiKey) server.env = { CONTEXT7_API_KEY: apiKey };
  const gen = path.join(mcpDir, 'context7.sandbox.local.json');
  fs.writeFileSync(gen, JSON.stringify({ mcpServers: { context7: server } }, null, 2));
  return gen;
}

async function resolveSandboxPlan(agentType, opts = {}, deps = {}) {
  const query = deps.query || require('../db').query;
  const { sandboxAppliesTo } = require('../lib/agent-sandbox-flag');
  const profile = profileFor(agentType);
  let projectId = opts.projectId != null ? Number(opts.projectId) : null;
  if (projectId == null && profile.scope === 'project' && opts.taskId != null) {
    const { rows: [t] } = await query('SELECT project_id FROM tasks WHERE id=$1', [opts.taskId]);
    projectId = t && t.project_id != null ? Number(t.project_id) : null;
  }
  return sandboxAppliesTo(profile, projectId) ? { profile, projectId } : null;
}

async function prepareSandboxRun({ claudeArgs, opts = {}, profile, projectId }, deps = {}) {
  const tok = require('../lib/agent-run-token');
  const d = {
    ensureAgentInfra: (...a) => require('../lib/agent-infra').ensureAgentInfra(...a),
    getClaudeAuthEnv: (...a) => require('../lib/claude-auth').getClaudeAuthEnv(...a),
    getSandboxLimits: (...a) => require('../lib/agent-sandbox-flag').getSandboxLimits(...a),
    resolveSandboxMounts: (...a) => require('../lib/agent-mounts').resolveSandboxMounts(...a),
    createPlatformCleanWorktree: (...a) => require('../lib/platform-worktree').createPlatformCleanWorktree(...a),
    removePlatformCleanWorktree: (...a) => require('../lib/platform-worktree').removePlatformCleanWorktree(...a),
    sandboxMcpConfigPath,
    canRun: tok.canRun, issueRunToken: tok.issueRunToken, revokeRun: tok.revokeRun,
    mkdirSync: fs.mkdirSync, execFile,
    getuid: () => process.getuid(), getgid: () => process.getgid(),
    ...deps,
  };
  const scope = runScope(profile, projectId);
  const scopeProjectId = scope.startsWith('project-') ? projectId : null;
  if (!(await d.canRun(scope, opts.userId ?? null))) throw new Error(`此次 AI 執行未獲准（scope=${scope}）`);

  const infra = await d.ensureAgentInfra();
  const callerEnv = opts.env || {};
  const auth = { ...d.getClaudeAuthEnv() };
  if (callerEnv.CLAUDE_CODE_OAUTH_TOKEN) auth.CLAUDE_CODE_OAUTH_TOKEN = callerEnv.CLAUDE_CODE_OAUTH_TOKEN;
  if (!auth.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('容器模式需要管理員在設定頁存入 Claude token（CLAUDE_CODE_OAUTH_TOKEN）；不退回平台主機的憑證檔');
  }

  const home = path.join(APP_DIR, 'data', 'agent-home', scope);
  d.mkdirSync(home, { recursive: true, mode: 0o700 });
  const { runId, token } = d.issueRunToken({
    scope, projectId: scopeProjectId, ttlMs: (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + TOKEN_GRACE_MS,
  });

  let platformWorktree = null;
  try {
    if (profile.mount === 'platform-clean') platformWorktree = await d.createPlatformCleanWorktree(runId);
    const { mounts, workdir } = await d.resolveSandboxMounts({
      profile, projectId: scopeProjectId, taskDbId: opts.taskId ?? null, cwd: opts.cwd, chatId: opts.chatId ?? null,
      feedbackIds: opts.feedbackIds || [], home, platformWorktree, appDir: APP_DIR,
    });
    const gw = infra.gatewayHost;
    const env = {
      CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', SECURITY_GUIDANCE_DISABLE: '1',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      AIDEV_AI_BASE: `http://${gw}:8080`, AIDEV_AI_TOKEN: token,
      HTTPS_PROXY: `http://${gw}:3128`, https_proxy: `http://${gw}:3128`, NO_PROXY: gw, no_proxy: gw,
      ...callerEnv, ...auth,
    };
    const { buildAgentRunArgs } = require('../lib/agent-sandbox');
    const built = buildAgentRunArgs({
      instanceId: infra.instanceId, runId, scope, image: infra.image, network: infra.network,
      user: `${d.getuid()}:${d.getgid()}`, mounts, workdir, home, env, limits: d.getSandboxLimits(),
      command: ['claude', ...replaceArg(claudeArgs, '--mcp-config', d.sandboxMcpConfigPath(opts.agentType))],
    });
    let released = false;
    return {
      ...built, runId,
      kill: () => d.execFile('docker', ['kill', built.containerName], () => {}),
      release: async () => {
        if (released) return;
        released = true;
        d.revokeRun(runId);
        if (platformWorktree) await d.removePlatformCleanWorktree(platformWorktree).catch(e => console.error('[SANDBOX] 移除乾淨 worktree 失敗：', e.message));
      },
    };
  } catch (err) {
    d.revokeRun(runId);
    if (platformWorktree) await d.removePlatformCleanWorktree(platformWorktree).catch(() => {});
    throw err;
  }
}

module.exports = { resolveSandboxPlan, prepareSandboxRun, sandboxMcpConfigPath, replaceArg };
```

- [ ] **Step 4：`.gitignore` 加一行**（生成檔含 Context7 key）

```
app/server/pipeline/mcp/context7.sandbox.local.json
```

- [ ] **Step 5：跑測試確認通過**

Run: `cd app && npx jest server/tests/sandbox-run.test.js`
Expected：PASS

- [ ] **Step 6：Commit**

```bash
git add app/server/pipeline/sandbox-run.js app/server/tests/sandbox-run.test.js .gitignore
git commit -m "[AgentSandbox]: 一次 AI 執行要先判斷該不該進容器，準備失敗必須收回通行證與 worktree 並大聲失敗，不能退回無容器

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 2.6：`runClaude` 容器分支（停止＝`docker kill`、137＝記憶體上限、不退回無容器）

**Files:**
- Modify: `app/server/pipeline/claude-runner.js:150-370`（`runClaude` 內部重排；**對外介面與 off 時的行為不變**）
- Test: `app/server/tests/claude-runner-sandbox.test.js`

**Interfaces:**
- Consumes：`getSandboxMode()`（1.3）；`resolveSandboxPlan`、`prepareSandboxRun`（2.5）
- Produces：`runClaude(prompt, opts)` 新增行為——
  - mode `off`：與現在逐字相同（**同步** `spawn('claude')`，rules/testing 26）
  - mode 非 off 且 plan 為 null：非同步後 `spawn('claude')`（舊路徑）
  - plan 非 null：`spawn('docker', run.argv, { stdio, env: run.childEnv })`（**不帶 cwd**，工作目錄由 `--workdir` 決定）；stream-json 解析、`task_events`、socket 推播完全共用
  - 停止／逾時：先 `run.kill()`（`docker kill <容器名>`）再照舊砍 CLI；結算時一律 `run.release()`（作廢通行證、收 worktree）
  - 容器路徑 exit code `OOM_EXIT_CODE`（M9 實測，預設 137）→ reject `claudeStatus: 'oom'`，訊息寫明「最可能是超過記憶體上限 <memory>」
  - 準備失敗 → reject `claudeStatus: 'error'`，**不呼叫 `spawn('claude')`**
  - `module.exports` 多 `OOM_EXIT_CODE`

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/claude-runner-sandbox.test.js
// 意圖（規格 §5、§6）：runner 的解析邏輯不變，只是子行程換成 docker。四件事不能錯：
//  1. 開關 off 時一個字都不變（同步 spawn claude）
//  2. 容器準備失敗必須失敗，絕不偷偷改跑容器外的 claude
//  3. 停止／逾時要 docker kill：SIGKILL 送到 docker CLI 不會轉給容器，容器會繼續跑、繼續燒錢
//  4. 被記憶體上限砍掉要講清楚，不是泛用的 exited with code 137
const { EventEmitter } = require('events');
jest.mock('child_process', () => ({ spawn: jest.fn(), execFile: jest.fn() }));
jest.mock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../pipeline/sandbox-run', () => ({ resolveSandboxPlan: jest.fn(), prepareSandboxRun: jest.fn() }));

const { spawn } = require('child_process');
const sr = require('../pipeline/sandbox-run');
const flag = require('../lib/agent-sandbox-flag');
const { runClaude } = require('../pipeline/claude-runner');

function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  c.kill = jest.fn();
  return c;
}
function fakeRun() {
  return { argv: ['run', '-i', '--rm', 'aidev-agent:x', 'claude', '-p'], childEnv: { PATH: '/bin', AIDEV_AI_TOKEN: 't' },
    containerName: 'odoo-v2-run-ab', runId: 'ab', kill: jest.fn(), release: jest.fn().mockResolvedValue() };
}
const tick = () => new Promise(r => setImmediate(r));
const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } });

beforeEach(() => { spawn.mockReset(); sr.resolveSandboxPlan.mockReset(); sr.prepareSandboxRun.mockReset(); });
afterEach(() => flag._setFlagStateForTesting({ mode: 'off' }));

test('off：同步 spawn claude（呼叫當下就已 spawn），不碰 sandbox-run', () => {
  flag._setFlagStateForTesting({ mode: 'off' });
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('x', { agentType: 'chat-title' });
  expect(spawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.objectContaining({ env: expect.any(Object) }));
  expect(sr.resolveSandboxPlan).not.toHaveBeenCalled();
  c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
  return expect(p).resolves.toMatchObject({ text: 'done' });
});

test('plan 為 null → 舊路徑 spawn claude', async () => {
  flag._setFlagStateForTesting({ mode: 'internal' });
  sr.resolveSandboxPlan.mockResolvedValueOnce(null);
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('x', { agentType: 'chat-title' });
  await tick(); await tick();
  expect(spawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object));
  c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
  await expect(p).resolves.toMatchObject({ text: 'done' });
});

test('容器路徑：spawn docker、不帶 cwd、解析照舊、結束時 release', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: { scope: 'none', mount: 'none' }, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('prompt-body', { agentType: 'chat-title', cwd: '/should/not/be/used' });
  await tick(); await tick();
  expect(spawn).toHaveBeenCalledWith('docker', run.argv, expect.objectContaining({ env: run.childEnv }));
  expect(spawn.mock.calls[0][2].cwd).toBeUndefined();
  expect(c.stdin.write).toHaveBeenCalledWith('prompt-body');
  c.stdout.emit('data', `${resultLine}\n`); c.emit('close', 0);
  await expect(p).resolves.toMatchObject({ text: 'done' });
  await tick();
  expect(run.release).toHaveBeenCalledTimes(1);
});

test('準備失敗 → reject，而且從頭到尾沒有 spawn claude', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: { scope: 'none', mount: 'none' }, projectId: null });
  sr.prepareSandboxRun.mockRejectedValueOnce(new Error('AI 映像檔 aidev-agent:x 不存在'));
  await expect(runClaude('x', { agentType: 'chat-title' })).rejects.toMatchObject({ claudeStatus: 'error', message: expect.stringMatching(/映像檔/) });
  expect(spawn).not.toHaveBeenCalled();
});

test('未登記 agentType（resolveSandboxPlan 丟例外）→ reject，不 spawn', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  sr.resolveSandboxPlan.mockRejectedValueOnce(new Error('未登記的 agentType：x'));
  await expect(runClaude('x', { agentType: 'x' })).rejects.toThrow(/未登記/);
  expect(spawn).not.toHaveBeenCalled();
});

test('按停止 → docker kill（run.kill）＋ release', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  const c = child(); spawn.mockReturnValueOnce(c);
  const ctrl = new AbortController();
  const p = runClaude('x', { agentType: 'chat-title', signal: ctrl.signal });
  await tick(); await tick();
  ctrl.abort();
  await expect(p).rejects.toMatchObject({ claudeStatus: 'aborted' });
  expect(run.kill).toHaveBeenCalled();
  await tick();
  expect(run.release).toHaveBeenCalled();
});

test('逾時 → docker kill', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  spawn.mockReturnValueOnce(child());
  await expect(runClaude('x', { agentType: 'chat-title', timeoutMs: 30 })).rejects.toMatchObject({ claudeStatus: 'timeout' });
  expect(run.kill).toHaveBeenCalled();
});

test('準備期間就按停止 → 準備完成後立刻 release，不 spawn', async () => {
  flag._setFlagStateForTesting({ mode: 'all' });
  const run = fakeRun();
  let resolvePrep;
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockReturnValueOnce(new Promise(r => { resolvePrep = r; }));
  const ctrl = new AbortController();
  const p = runClaude('x', { agentType: 'chat-title', signal: ctrl.signal });
  await tick();
  ctrl.abort();
  await expect(p).rejects.toMatchObject({ claudeStatus: 'aborted' });
  resolvePrep(run);
  await tick(); await tick();
  expect(spawn).not.toHaveBeenCalled();
  expect(run.release).toHaveBeenCalled();
});

test('容器 exit 137 → oom，訊息寫明記憶體上限', async () => {
  flag._setFlagStateForTesting({ mode: 'all', limits: { memory: '4g', cpus: '2', pids: 512 } });
  const run = fakeRun();
  sr.resolveSandboxPlan.mockResolvedValueOnce({ profile: {}, projectId: null });
  sr.prepareSandboxRun.mockResolvedValueOnce(run);
  const c = child(); spawn.mockReturnValueOnce(c);
  const p = runClaude('x', { agentType: 'chat-title' });
  await tick(); await tick();
  c.emit('close', 137);
  await expect(p).rejects.toMatchObject({ claudeStatus: 'oom', message: expect.stringMatching(/記憶體上限.*4g/) });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/claude-runner-sandbox.test.js`
Expected：FAIL（off 那條可能過；容器路徑那幾條 `spawn` 被以 `'claude'` 呼叫或沒有 docker）

- [ ] **Step 3：重排 `runClaude`**

檔頭 require 區加：
```js
const { getSandboxMode, getSandboxLimits } = require('../lib/agent-sandbox-flag');
```
`KILL_GRACE_MS` 定義之後加：
```js
// 容器路徑下被 SIGKILL 的 exit code（M9 實測）。docker 以 --rm 執行，結束後查不到 OOMKilled，只能看這個碼；
// 行程自己被 SIGKILL 也是同一個碼，所以訊息寫「最可能」而不是「確定」。
const OOM_EXIT_CODE = 137;
```

`runClaude` 內部照下面的順序重排（**各段內容逐字搬移，只有標「新增」的地方是新碼**）：

1. `signal?.aborted` 早退、`args` 組裝（原第 155-174 行）——不動。
2. **新增**（接在 `args` 之後）：
```js
    let child = null;          // 目前的子行程：claude（舊路徑）或 docker CLI（容器路徑）
    let sandboxRun = null;     // 容器路徑的控制把手（lib 見 sandbox-run.js）
    let sandboxReleased = false;
    const releaseSandbox = () => {
      if (sandboxRun && !sandboxReleased) { sandboxReleased = true; Promise.resolve(sandboxRun.release()).catch(() => {}); }
    };
    // 容器路徑：SIGKILL 送到 docker CLI 不會轉給容器，一定要 docker kill（規格 §6）；CLI 本身照舊砍
    const killChild = () => {
      if (sandboxRun) sandboxRun.kill();
      if (child) killChildGracefully(child, KILL_GRACE_MS);
    };
```
   並刪掉原第 204 行 `const killChild = () => killChildGracefully(child, KILL_GRACE_MS);`。
3. 狀態變數宣告（原第 206-230 行，含 Task 2.4 加的 `plainOut`）——不動。
4. `flushEvents`（原第 231-239 行）——不動。`finish`（原第 241 行）改為在 flush 後先 release：
```js
    const finish = fn => { if (!settled) { settled = true; if (timer) clearTimeout(timer); Promise.resolve(flushEvents()).finally(() => { releaseSandbox(); fn(); }); } };
```
5. `fail`、`timer`、`emit`（原第 246-260 行）——不動。
6. `prompt_logs` 落地（原第 310-315 行）與 `signal` 監聽（原第 319-324 行）**搬到這裡**（spawn 之前：容器準備期間按停止也要能結算）。
7. **新增** `attachChild`，把原本掛在 `child` 上的四組 handler 與 stdin 寫入包進去（內容逐字搬入）：
```js
    const attachChild = (spawned) => {
      child = spawned;
      child.stdin.on?.('error', () => {});                 // 原第 201 行
      child.stdout.on('data', d => { /* 原第 262-306 行逐字 */ });
      child.stderr.on('data', d => { stderr += d.toString(); });   // 原第 308 行
      child.on('close', (code, sig) => { /* 原第 326-357 行逐字，另加下方 OOM 分支 */ });
      child.on('error', err => { /* 原第 358-368 行逐字，ENOENT 訊息見下方 */ });
      child.stdin.write(prompt);                           // 原第 316-317 行
      child.stdin.end();
    };
```
   close handler 內，Task 2.4 的 `else if (missing) { ... }` 之後、原本 `else {` 之前插入：
```js
          else if (sandboxRun && code === OOM_EXIT_CODE) {
            const mem = getSandboxLimits().memory || '（未設定）';
            reject(fail(new Error(`AI 容器被強制終止（exit ${code}），最可能是超過記憶體上限 ${mem}；已分類為環境問題、不自動重試`), 'oom'));
          }
```
   error handler 的 ENOENT 訊息改為依路徑歸因：
```js
      if (err.code === 'ENOENT') {
        err.message = sandboxRun
          ? '找不到 docker 執行檔（容器模式需要平台容器內的 docker CLI）'
          : (cwd && !fs.existsSync(cwd))
            ? `工作目錄不存在（worktree 可能尚未建立或已清除）：${cwd}`
            : '找不到 claude 執行檔（PATH 未含 claude 安裝目錄），請確認 claude CLI 可用';
      }
```
8. **新增**（Promise executor 最後）：
```js
    const legacyEnv = { ...process.env, SECURITY_GUIDANCE_DISABLE: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', ...getClaudeAuthEnv(), ...aiTokenEnv(), ...aiBaseEnv(), ...(env || {}) };
    // 舊路徑：與原本逐字相同的 spawn（原第 178-198 行的註解保留在這一行上方）
    const startLegacy = () => attachChild(spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: legacyEnv }));
    if (getSandboxMode() === 'off') { startLegacy(); return; }
    // 容器路徑（子專案 0）：開關有涵蓋就只能走容器；準備失敗一律 reject，禁止退回無容器（規格 §6、rules/pipeline 59）
    const sr = require('./sandbox-run');
    sr.resolveSandboxPlan(agentType, opts)
      .then(async plan => {
        if (settled) return;
        if (!plan) { startLegacy(); return; }
        const run = await sr.prepareSandboxRun({ claudeArgs: args, opts, profile: plan.profile, projectId: plan.projectId });
        sandboxRun = run;
        if (settled) { releaseSandbox(); return; }
        attachChild(spawn('docker', run.argv, { stdio: ['pipe', 'pipe', 'pipe'], env: run.childEnv }));
      })
      .catch(err => finish(() => reject(fail(err, 'error'))));
```
9. `module.exports` 加 `OOM_EXIT_CODE`。

- [ ] **Step 4：跑新測試與既有 runner 測試**

Run: `cd app && npx jest server/tests/claude-runner-sandbox.test.js server/tests/claude-runner.test.js server/tests/claude-runner-session.test.js`
Expected：PASS（既有 `claude-runner.test.js` 全綠＝off 行為沒變）

- [ ] **Step 5：全跑**（runner 被所有關卡的測試間接用到）

Run: `cd app && npm run test:quiet > /tmp/claude-t26.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-t26.txt; grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-t26.txt`
Expected：無新紅燈

- [ ] **Step 6：Commit**

```bash
git add app/server/pipeline/claude-runner.js app/server/tests/claude-runner-sandbox.test.js
git commit -m "[AgentSandbox]: AI 改在容器裡跑時，按停止只砍 docker CLI 容器會繼續燒錢，準備失敗也不能偷偷退回容器外執行

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.7：`oom` 分類為環境問題、不重試

**Files:**
- Modify: `app/server/pipeline/failure-classifier.js:67-69`（`classifyFailure` 開頭的 claudeStatus 特判）
- Test: `app/server/tests/failure-classifier.test.js`（追加）

**Interfaces:**
- Consumes：`claudeStatus: 'oom'`（2.6）
- Produces：`classifyFailure(text, { claudeStatus: 'oom' }) → 'env'`；`session_missing` 不特判（呼叫端已降級 fresh）

- [ ] **Step 1：追加失敗測試**（`failure-classifier.test.js` 檔尾）

```js
// 子專案 0 §6：容器被記憶體上限砍掉＝環境問題（上限要調），退回 coding 重寫只會再被砍一次（rules/pipeline 54、93）
test('claudeStatus oom → env（即使訊息裡有看起來像程式錯誤的字）', () => {
  const { classifyFailure } = require('../pipeline/failure-classifier');
  expect(classifyFailure('AI 容器被強制終止（exit 137）SyntaxError', { claudeStatus: 'oom' })).toBe('env');
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/failure-classifier.test.js`
Expected：FAIL（回 `code` 或 `unknown`）

- [ ] **Step 3：實作**（`if (opts.claudeStatus === 'auth') return 'transient';` 之後加）

```js
  // 容器超過記憶體上限被砍（子專案 0 §6）：要調上限，不是程式問題，也不該自動重試
  if (opts.claudeStatus === 'oom') return 'env';
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/failure-classifier.test.js server/tests/qa-agent.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/pipeline/failure-classifier.js app/server/tests/failure-classifier.test.js
git commit -m "[AgentSandbox]: 容器被記憶體上限砍掉會被當成程式錯誤退回開發重寫，改分類為環境問題交人工

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 2.8：平台啟動時清掉本實例殘留的 AI 容器

**為什麼**：規格 §6——平台重啟時 AI 容器會活下來（不像子行程會跟著死），繼續燒錢、繼續寫 worktree；而 cron 會重派同一關，兩個 agent 並寫同一個 worktree。**一定要同時帶 `aidev.run=1` 與 `aidev.instance=<本實例>` 兩個 label**，否則同主機另一套平台的 AI 會被一起砍。

放新模組而不是 `pipeline/startup-recovery.js`：那支檔頭明訂「本模組不掃描、不列舉、不依名稱樣式批次操作容器」，這條界線不動；這裡是依**本平台自己打上的 label** 精確列舉，另立一支並在檔頭寫清楚差異。

**Files:**
- Create: `app/server/lib/agent-orphans.js`
- Modify: `app/server/index.js`（`clearInterruptedUpgrades` 那個 try 區塊之後、`leaveMaintenance` 之前；必須在 `startCron()` 之前）
- Test: `app/server/tests/agent-orphans.test.js`

**Interfaces:**
- Consumes：`instanceId()`（2.3）
- Produces：`removeOrphanAgentContainers(deps?: { execFile, instanceId }) → Promise<{ removed: number, skipped?: string }>`（實例 id 取不到 → 不刪任何東西，回 `skipped`）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-orphans.test.js
// 意圖：重啟後殘留的 AI 容器要清，但只能清「本平台實例、本平台打過 label 的 AI 容器」。
// 同一台主機跑著約 110 個容器（開發順序 §2.4），多一個字的篩選錯誤就是砍到別人的服務。
const { removeOrphanAgentContainers } = require('../lib/agent-orphans');

function fake(psOut) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, args[0] === 'ps' ? psOut : '', ''); };
  return { execFile, calls };
}

test('同時帶 aidev.run 與本實例 label 篩選，只刪列出來的 id', async () => {
  const f = fake('aaa111\nbbb222\n');
  const r = await removeOrphanAgentContainers({ execFile: f.execFile, instanceId: 'odoo-v2' });
  expect(f.calls[0]).toEqual(['docker', 'ps', '-aq', '--filter', 'label=aidev.run=1', '--filter', 'label=aidev.instance=odoo-v2']);
  expect(f.calls[1]).toEqual(['docker', 'rm', '-f', 'aaa111', 'bbb222']);
  expect(r).toEqual({ removed: 2 });
});

test('沒有殘留 → 不呼叫 rm', async () => {
  const f = fake('\n');
  await removeOrphanAgentContainers({ execFile: f.execFile, instanceId: 'odoo-v2' });
  expect(f.calls.some(c => c[1] === 'rm')).toBe(false);
});

test('取不到實例 id → 一個都不刪（寧可留著也不要只靠 aidev.run 篩）', async () => {
  const f = fake('aaa111\n');
  const r = await removeOrphanAgentContainers({ execFile: f.execFile, instanceId: () => { throw new Error('PLATFORM_CONTAINER 未設定'); } });
  expect(f.calls).toEqual([]);
  expect(r.removed).toBe(0);
  expect(r.skipped).toMatch(/PLATFORM_CONTAINER/);
});

test('ps 輸出含非容器 id 的字 → 丟例外，不把奇怪的字串交給 rm', async () => {
  const f = fake('aaa111\n--all\n');
  await expect(removeOrphanAgentContainers({ execFile: f.execFile, instanceId: 'odoo-v2' })).rejects.toThrow();
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-orphans.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-orphans'`

- [ ] **Step 3：實作**

```js
// app/server/lib/agent-orphans.js
/**
 * agent-orphans.js — 平台啟動時清掉「本實例」殘留的 AI 容器（子專案 0 §6）
 *
 * 與 pipeline/startup-recovery.js 的界線不同：那支只對單一具名測試區容器動作、不列舉；
 * 這支依本平台自己打上的兩個 label（aidev.run=1 且 aidev.instance=<PLATFORM_CONTAINER>）精確列舉。
 * 取不到實例 id 就一個都不刪——只靠 aidev.run 篩會連同主機另一套平台正在跑的 AI 一起砍。
 * 通行證清單在記憶體，重啟後本來就全部失效；這裡只處理還活著的容器。
 */
const { execFile: realExecFile } = require('child_process');

function run(execFile, args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 60000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

async function removeOrphanAgentContainers(deps = {}) {
  const execFile = deps.execFile || realExecFile;
  let id;
  try {
    const src = deps.instanceId !== undefined ? deps.instanceId : () => require('./agent-infra').instanceId();
    id = typeof src === 'function' ? src() : src;
  } catch (err) {
    return { removed: 0, skipped: err.message };
  }
  const out = await run(execFile, ['ps', '-aq', '--filter', 'label=aidev.run=1', '--filter', `label=aidev.instance=${id}`]);
  const ids = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (ids.some(x => !/^[a-f0-9]{12,64}$/.test(x))) throw new Error(`docker ps 回傳了非容器 id 的內容：${ids.join(',')}`);
  if (!ids.length) return { removed: 0 };
  await run(execFile, ['rm', '-f', ...ids]);
  return { removed: ids.length };
}

module.exports = { removeOrphanAgentContainers };
```

- [ ] **Step 4：`index.js` 接線**（`clearInterruptedUpgrades` 的 try 區塊之後）

```js
    // 子專案 0：被重啟打斷的 AI 容器不會跟著死（不像子行程），不清的話會繼續燒錢、與 cron 重派的同一關並寫 worktree。
    // 必須在 startCron() 之前。取不到實例 id 時一個都不刪（見 lib/agent-orphans.js）。
    try {
      const o = await require('./lib/agent-orphans').removeOrphanAgentContainers();
      if (o.removed || o.skipped) console.log(`[STARTUP] AI 孤兒容器：清掉 ${o.removed}${o.skipped ? `（略過：${o.skipped}）` : ''}`);
    } catch (e) { console.error('[STARTUP] AI 孤兒容器清理:', e.message); }
```

- [ ] **Step 5：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-orphans.test.js`
Expected：PASS

- [ ] **Step 6：Commit**

```bash
git add app/server/lib/agent-orphans.js app/server/index.js app/server/tests/agent-orphans.test.js
git commit -m "[AgentSandbox]: 平台重啟時 AI 容器會活下來繼續燒錢、和重派的同一關並寫 worktree，啟動時要清掉本實例的殘留容器

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.9：呼叫端補齊專案脈絡與 agentType

**為什麼**：`projects` 模式要知道「這次屬於哪個專案」才能決定進不進容器；容器內 `/ai` 的專案檢查、掛載也靠它。有 `taskId`（`tasks.id`）的呼叫點由 `resolveSandboxPlan` 自己查（qa、analysis、coding、spec_tour、respec、reject_triage、cs、merge 系），**沒帶 taskId 的**要補 `projectId`。`admin-routes.js:76` 驗 token 那次沒有 agentType，容器模式下會被 `profileFor` 擋掉，要補 `auth_probe`。

**Files:**
- Modify: `app/server/admin-routes.js:76`
- Modify: `app/server/pipeline/chat-agent.js:163`（withResume 的 `runOpts`）
- Modify: `app/server/pipeline/chat-title.js:50-56`
- Modify: `app/server/pipeline/chat-to-task.js:61`
- Modify: `app/server/pipeline/failure-classifier.js:93`
- Modify: `app/server/pipeline/classify-rejections.js:26`
- Modify: `app/server/pipeline/wiki-drift.js:58`
- Modify: `app/server/pipeline/library-agent.js:201,304,423`
- Test: `app/server/tests/sandbox-callsites.test.js`

**Interfaces:**
- Consumes：`AGENT_PROFILES`（1.1）
- Produces：上列呼叫點的 opts 多出 `projectId`（chat 系另帶 `chatId`）；token 驗證帶 `agentType: 'auth_probe'`

- [ ] **Step 1：寫失敗測試**（靜態守衛：每個「沒有 taskId 可查」的 project／none 類呼叫點，`agentType` 那一行必須同時帶 `projectId`）

```js
// app/server/tests/sandbox-callsites.test.js
// 意圖：projects 模式只對清單內的測試專案開容器。呼叫點少帶 projectId 時，resolveSandboxPlan 判不出專案，
// 那一關會靜默留在容器外——開關以為開了、實際沒開，而且沒有任何紅燈。這支把「必須帶」鎖在原始碼上。
// 慣例：projectId 與 agentType 寫在同一行（改寫排版時請維持，否則這支會紅）。
const fs = require('fs');
const path = require('path');
const { AGENT_PROFILES } = require('../lib/agent-profiles');

const SRV = path.join(__dirname, '..');
const MUST_HAVE_PROJECT = [
  ['pipeline/chat-agent.js', 'chat', /projectId, chatId/],
  ['pipeline/chat-title.js', 'chat-title', /projectId: chat\.project_id/],
  ['pipeline/chat-to-task.js', 'chat-to-task', /projectId, chatId/],
  ['pipeline/failure-classifier.js', 'deploy_fix', /projectId: opts\.projectId/],
  ['pipeline/classify-rejections.js', 'reject_classify', /projectId: rej\.project_id/],
  ['pipeline/wiki-drift.js', 'wiki_drift_classify', /projectId: d\.project_id/],
  ['pipeline/library-agent.js', 'wiki', /projectId/],
];

test.each(MUST_HAVE_PROJECT)('%s 的 %s 呼叫帶 projectId', (file, agentType, re) => {
  const lines = fs.readFileSync(path.join(SRV, file), 'utf8').split('\n').filter(l => l.includes(`agentType: '${agentType}'`));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l).toMatch(re);
});

test('admin 驗 Claude token 的那次呼叫有登記過的 agentType', () => {
  const src = fs.readFileSync(path.join(SRV, 'admin-routes.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes("runClaude('回覆 ok'"));
  expect(line).toMatch(/agentType: 'auth_probe'/);
  expect(AGENT_PROFILES.auth_probe).toBeTruthy();
});

// 任何字面出現的 agentType 都要在 profile 表裡——新增關卡忘了登記，容器模式下整關直接失敗
test('server 內所有字面 agentType 都已登記', () => {
  const found = new Set();
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['tests', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/agentType:\s*'([^']+)'/g)) found.add(m[1]);
    }
  };
  walk(SRV);
  const missing = [...found].filter(t => !AGENT_PROFILES[t]);
  expect(missing).toEqual([]);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/sandbox-callsites.test.js`
Expected：FAIL（前 7 條與 admin 那條）

- [ ] **Step 3：逐處修改**（每處只改列出的那一行；其餘不動）

`admin-routes.js:76`：
```js
      await runClaude('回覆 ok', { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, timeoutMs: 60000, agentType: 'auth_probe' });
```
`chat-agent.js`（withResume 的 runOpts）：
```js
        runOpts: { agentType: 'chat', provider: agent.provider, effort: agent.effort, signal, projectId, chatId },
```
`chat-title.js`：查詢多取 `project_id`，runClaude opts 帶上：
```js
    const { rows: [chat] } = await query(
      'SELECT title, project_id FROM project_chats WHERE id = $1', [chatId]
    );
```
```js
      userId, agentType: 'chat-title', timeoutMs: TIMEOUT_MS, projectId: chat.project_id,
```
`chat-to-task.js:61`：
```js
    result = await runAgent(prompt, { model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'chat-to-task', projectId, chatId });
```
`failure-classifier.js:93`（行尾 `agentType: 'deploy_fix' }` 改為）：
```js
agentType: 'deploy_fix', projectId: opts.projectId });
```
`classify-rejections.js:26`（行尾 `agentType: 'reject_classify' });` 改為）：
```js
agentType: 'reject_classify', projectId: rej.project_id });
```
`wiki-drift.js:58`：
```js
      { model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'wiki_drift_classify', projectId: d.project_id }
```
`library-agent.js:201`（`refreshWikiNode(projectId, …)` 內）與 `:423`（`initProjectWiki(projectId, …)` 內）：
```js
    const r = await runAgent(agent.render({ context }), { signal, userId, model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'wiki', projectId });
```
`library-agent.js:304`（`runLibraryAgent` 內，`task` 已由 `SELECT id, task_id, analysis_yaml, project_id, title FROM tasks` 取得）：
```js
    const r = await runAgent(agent.render({ context }), { signal, taskId, userId, model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'wiki', projectId: task.project_id });
```

- [ ] **Step 4：跑測試（新守衛＋受影響模組的既有測試）**

Run: `cd app && npx jest server/tests/sandbox-callsites.test.js server/tests/chat-title.test.js server/tests/agent-runner.test.js server/tests/failure-classifier.test.js $(ls server/tests | grep -E '^(chat-agent|chat-to-task|classify-rejections|wiki-drift|library-agent)' | sed 's#^#server/tests/#')`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/admin-routes.js app/server/pipeline/chat-agent.js app/server/pipeline/chat-title.js app/server/pipeline/chat-to-task.js app/server/pipeline/failure-classifier.js app/server/pipeline/classify-rejections.js app/server/pipeline/wiki-drift.js app/server/pipeline/library-agent.js app/server/tests/sandbox-callsites.test.js
git commit -m "[AgentSandbox]: 呼叫點沒帶專案時，只對測試專案開容器的開關會讓那一關靜默留在容器外，補齊專案脈絡並加守衛

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.10：coding／spec_tour 只把 git 身分交給 AI，不交 PAT

**為什麼**：`task-agent.js:586,637` 把整包 `buildGitEnv` 傳進子行程（含 `GIT_PAT`、`GIT_ASKPASS` 指向平台檔案、`GIT_CONFIG_*`）。容器 env 白名單會對這些 key 丟例外（第 1 部 Task 1.4，刻意的）；而且 coding 的 prompt 明寫「只 commit，不 push」（`coding-project.md:48`），push 由平台自己做——AI 本來就不需要 PAT。**行為改變**：舊路徑的 coding 也不再拿到 PAT；若它自行 `git fetch`／`push` 會失敗（prompt 本來就禁止）。

**Files:**
- Modify: `app/server/lib/git-identity.js`（新增 export）
- Modify: `app/server/pipeline/task-agent.js:586`（spec_tour runOpts 的 `env`）、`:637`（coding 的 `env`）
- Test: `app/server/tests/git-identity.test.js`（追加）

**Interfaces:**
- Produces：`pickGitIdentity(gitEnv) → { GIT_AUTHOR_NAME?, GIT_AUTHOR_EMAIL?, GIT_COMMITTER_NAME?, GIT_COMMITTER_EMAIL? }`

- [ ] **Step 1：追加失敗測試**（`git-identity.test.js` 檔尾）

```js
// 子專案 0：AI 只 commit 不 push（coding-project.md:48），給它身分就夠了；PAT 與 askpass 留在平台自己的 git。
test('pickGitIdentity 只留作者／提交者身分', () => {
  const picked = gitId.pickGitIdentity({
    GIT_ASKPASS: '/x/git-askpass.sh', GIT_PAT: 'ghp_secret', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'b@c', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'b@c', GIT_TERMINAL_PROMPT: '0',
  });
  expect(picked).toEqual({ GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'b@c', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'b@c' });
  expect(gitId.pickGitIdentity({})).toEqual({});
  expect(gitId.pickGitIdentity(null)).toEqual({});
});

test('task-agent 不再把整包 gitEnv 交給 AI', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'pipeline', 'task-agent.js'), 'utf8');
  expect(src).not.toMatch(/env:\s*\{\s*\.\.\.gitEnv\s*\}/);
  expect((src.match(/env: pickGitIdentity\(gitEnv\)/g) || []).length).toBe(2);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/git-identity.test.js`
Expected：FAIL（`pickGitIdentity is not a function`）

- [ ] **Step 3：實作**

`git-identity.js`（`buildGitEnv` 之後）：
```js
// 交給 AI 子行程（含容器）的 git env：只有身分。AI 只 commit 不 push，PAT／askpass 不出平台（子專案 0 §4.2）
const IDENTITY_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
function pickGitIdentity(gitEnv) {
  const out = {};
  for (const k of IDENTITY_KEYS) if (gitEnv && gitEnv[k]) out[k] = gitEnv[k];
  return out;
}
```
`module.exports` 加 `pickGitIdentity`。

`task-agent.js`：檔頭既有 `require('../lib/git-identity')` 的解構加上 `pickGitIdentity`（若該檔是 `const { buildGitEnv } = require(...)` 就改成 `const { buildGitEnv, pickGitIdentity } = require(...)`）；兩處改為：
```js
    timeoutMs: SPEC_TOUR_TIMEOUT_MS, env: pickGitIdentity(gitEnv),
```
```js
  return runClaude(built.prompt, { cwd, taskId: task.id, userId, signal, model: built.model, agentType: 'coding', timeoutMs: CODING_TIMEOUT_MS, env: pickGitIdentity(gitEnv) });
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/git-identity.test.js $(ls server/tests | grep -E '^task-agent' | sed 's#^#server/tests/#')`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/git-identity.js app/server/pipeline/task-agent.js app/server/tests/git-identity.test.js
git commit -m "[AgentSandbox]: 開發 AI 只 commit 不 push，卻拿到整包含 PAT 的 git env，改成只給作者身分

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 2.11：考試系統的 AI 子行程改用 env 白名單（不論 Q1 裁決都要做）

**為什麼**：X2——`lib/exam/challenge.js:191`、`review.js:401`、`evidence.js:368` 直接 `spawn('claude', args, { cwd })`，**沒帶 env＝整包繼承平台行程的 `APP_SECRET`／`JWT_SECRET`／`DATABASE_URL`**；截圖由使用者上傳（`/api/exam/run` 只驗登入）。容器化與否待 Q1，但「拿不到三把鑰匙」現在就能做、不改變行為（它們認證靠 `HOME` 下的憑證檔，不靠這三個變數）。

**Files:**
- Create: `app/server/lib/agent-env.js`
- Modify: `app/server/lib/exam/challenge.js:191`、`review.js:401`、`evidence.js:368`
- Test: `app/server/tests/agent-env.test.js`

**Interfaces:**
- Produces：`LEGACY_ENV_KEYS: string[]`、`pickLegacyEnv(src: object) → object`（只留執行 CLI 需要的系統變數＋`GIT_CONFIG_*` 加固；Task 2.12 的 Codex 也用它）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-env.test.js
// 意圖：不進容器的 AI 子行程（考試、Codex）至少拿不到三把總鑰匙。白名單而不是黑名單：
// start.sh 之後又 export 了什麼（例如 ANTHROPIC_API_KEY、PLATFORM_CONTAINER）都不該默默傳下去。
const fs = require('fs');
const path = require('path');
const { pickLegacyEnv, LEGACY_ENV_KEYS } = require('../lib/agent-env');

test('只留系統變數與 git 加固；三把鑰匙與其他平台變數全部不留', () => {
  const src = {
    PATH: '/usr/bin', HOME: '/home/odoo', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Taipei', TMPDIR: '/tmp',
    APP_SECRET: 's', JWT_SECRET: 'j', DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'k', PLATFORM_CONTAINER: 'odoo-v2',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
  };
  const out = pickLegacyEnv(src);
  expect(out).toEqual({
    PATH: '/usr/bin', HOME: '/home/odoo', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Taipei', TMPDIR: '/tmp',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
  });
  expect(LEGACY_ENV_KEYS).not.toEqual(expect.arrayContaining(['APP_SECRET']));
});

test.each(['challenge.js', 'review.js', 'evidence.js'])('lib/exam/%s 的 spawn 帶 env 白名單', (f) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'exam', f), 'utf8');
  const spawnLines = src.split('\n').filter(l => l.includes("spawn('claude'"));
  expect(spawnLines.length).toBe(1);
  expect(spawnLines[0]).toMatch(/env: pickLegacyEnv\(process\.env\)/);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-env.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-env'`

- [ ] **Step 3：實作 `agent-env.js`**

```js
// app/server/lib/agent-env.js
/**
 * agent-env.js — 不進容器的 AI 子行程（考試系統、Codex）的 env 白名單（子專案 0 §4.6、計畫 X2）
 * 只留執行 CLI 需要的系統變數；GIT_CONFIG_* 保留，因為那是第 1 部 Task 1.12 的 hook 加固。
 * 同 uid 讀 data/config.json 的風險仍在（規格 §10），這裡只保證 env 裡沒有三把鑰匙。
 */
const LEGACY_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'CODEX_HOME', 'XDG_CONFIG_HOME'];
const GIT_CONFIG_RE = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

function pickLegacyEnv(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) {
    if (v == null) continue;
    if (LEGACY_ENV_KEYS.includes(k) || GIT_CONFIG_RE.test(k)) out[k] = v;
  }
  return out;
}

module.exports = { LEGACY_ENV_KEYS, pickLegacyEnv };
```

- [ ] **Step 4：三個考試檔**（各自檔頭加 require；spawn 那一行改成下面；`evidence.js`、`challenge.js` 的變數是 `cwd`，`review.js` 是 `runCwd`）

```js
const { pickLegacyEnv } = require('../agent-env');
```
`challenge.js:191`、`evidence.js:368`：
```js
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: pickLegacyEnv(process.env) });
```
`review.js:401`：
```js
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: runCwd, env: pickLegacyEnv(process.env) });
```

- [ ] **Step 5：跑測試（含既有考試測試）**

Run: `cd app && npx jest server/tests/agent-env.test.js server/tests/exam-review.test.js server/tests/exam-evidence.test.js`
Expected：PASS

- [ ] **Step 6：實機確認考試審查仍能跑**（R-A 重啟後；在第 3 部 Task 3.5 的 Step 2 一併做）：到考試頁對一張既有截圖按「重新審查」，確認有結果、`data/logs`／畫面沒有「Not logged in」。若出現認證失敗 → 表示它原本靠 env 裡的某個變數認證，把 `pickLegacyEnv` 的回傳補上 `...require('../claude-auth').getClaudeAuthEnv()` 並回報。

- [ ] **Step 7：Commit**

```bash
git add app/server/lib/agent-env.js app/server/lib/exam/challenge.js app/server/lib/exam/review.js app/server/lib/exam/evidence.js app/server/tests/agent-env.test.js
git commit -m "[AgentSandbox]: 考試系統的 AI 讀使用者上傳的截圖、卻整包繼承平台 env，一句提示詞就拿得到總鑰匙

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.12：Codex 路徑的 env 白名單（09-15 Q3：不擋客戶 agent 選 Codex）

**為什麼**：規格 §4.6——Codex 不容器化，但至少拿不到三把鑰匙（`codex-runner.js:48` 現在是 `{ ...process.env, ... }`）；~~客戶觸發的 agentType 在容器模式下設成 codex 要直接報錯~~——**09-15 使用者裁決 Q3：Codex 先限內部人員、`CODEX_ELIGIBLE` 照常可選**。依 agentType 擋會連「內部人員處理代管客戶的單」一起擋掉，而「觸發者屬於客戶公司」要等子專案 1 的公司表才判得出來，所以本 Task 不動 `agent-runner.js`，擋法移到子專案 1 的 `canRun(scope, actorUserId)`。已知剩餘風險：內部人員以 Codex 處理含客戶文字的單仍無容器保護（Codex 容器化列後續）。

**Files:**
- Modify: `app/server/pipeline/codex-runner.js:48`
- Test: `app/server/tests/codex-runner.test.js`（追加）

**Interfaces:**
- Consumes：`pickLegacyEnv`（2.11）
- Produces：`runCodex` 子行程 env 不含三把總鑰匙；`runAgent` 行為不變

- [ ] **Step 1：追加失敗測試**

`codex-runner.test.js` 檔尾：
```js
// 子專案 0 §4.6：Codex 不進容器，但子行程 env 至少不含三把總鑰匙
test('runCodex：子行程 env 不含 APP_SECRET／JWT_SECRET／DATABASE_URL', async () => {
  const saved = { a: process.env.APP_SECRET, j: process.env.JWT_SECRET, d: process.env.DATABASE_URL };
  process.env.APP_SECRET = 'leak-a'; process.env.JWT_SECRET = 'leak-j'; process.env.DATABASE_URL = 'postgres://leak';
  try {
    const { spawn } = require('child_process');
    const c = child();
    spawn.mockReturnValueOnce(c);
    const { runCodex } = require('../pipeline/codex-runner');
    const p = runCodex('x', { agentType: 'workflow_health' });
    c.emit('close', 0);
    await p.catch(() => {});
    const env = spawn.mock.calls[spawn.mock.calls.length - 1][2].env;
    expect(env.APP_SECRET).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  } finally {
    for (const [k, v] of [['APP_SECRET', saved.a], ['JWT_SECRET', saved.j], ['DATABASE_URL', saved.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/codex-runner.test.js server/tests/agent-runner.test.js`
Expected：FAIL（env 裡有 `APP_SECRET`）

- [ ] **Step 3：實作**

`codex-runner.js`：檔頭加 `const { pickLegacyEnv } = require('../lib/agent-env');`，第 48 行改為：
```js
    const childEnv = { ...pickLegacyEnv(process.env), ...aiTokenEnv(), ...aiBaseEnv(), ...(env || {}) };
```
（下面三行 `delete childEnv.OPENAI_API_KEY` 等保留：呼叫端自帶的 `env` 仍可能帶進來。）

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/codex-runner.test.js server/tests/codex-runner-args.test.js server/tests/agent-runner.test.js`（agent-runner 未改，跑它只確認沒被波及）
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/pipeline/codex-runner.js app/server/tests/codex-runner.test.js
git commit -m "[AgentSandbox]: Codex 不進容器卻整包繼承平台 env，子行程拿得到三把總鑰匙

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.13（量測）：容器內 context7 MCP 經 proxy 查得到文件

**為什麼**：X8——容器專用 MCP 設定（Task 2.5 `sandboxMcpConfigPath`）呼叫映像內的 `context7-mcp`，靠 `HTTPS_PROXY` 出去（context7-mcp 以 undici ProxyAgent 讀 `HTTPS_PROXY`，09-15 查 `dist/lib/api.js:37-64` 屬實）。要實機確認 analysis／coding／qa／chat 這些關卡在容器裡真的查得到文件，不然它們會退回亂掃碟（rules/agent-prompt 107）。

**前置**：M6 Step 1、M7 Step 1 的設施與 token（重建一次，Step 3 收掉）。

- [ ] **Step 1：生成容器版 MCP 設定到量測家目錄**

```bash
WT=/home/odoo/odoo-v2/.claude/worktrees/agent-sandbox
M13HOME="$WT/data/agent-home/m13probe"; mkdir -p "$M13HOME"
cd "$WT/app/server" && DATABASE_URL="$(node -p "require('/home/odoo/odoo-v2/data/config.json').DATABASE_URL")" APP_SECRET="$(node -p "require('/home/odoo/odoo-v2/data/config.json').APP_SECRET")" node -e "
require('./lib/context7-auth').loadContext7Key().then(() => {
  const p = require('./pipeline/sandbox-run').sandboxMcpConfigPath('coding', { mcpDir: process.argv[1] });
  console.log(p); process.exit(0);
})" "$M13HOME"
```
Expected：印出 `$M13HOME/context7.sandbox.local.json`

- [ ] **Step 2：容器內要 agent 用 context7**

```bash
CV=$(claude --version | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
echo "Use the context7 MCP tool to resolve the library id for 'express' and reply with only the library id." | \
docker run --rm -i --network aidevm6-agent-net --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp --cap-drop ALL \
  --memory 2g --memory-swap 2g --cpus 1 --pids-limit 256 \
  --mount "type=bind,source=$M13HOME,target=$M13HOME" -e "HOME=$M13HOME" -e CLAUDE_CODE_OAUTH_TOKEN \
  -e HTTPS_PROXY=http://aidevm6-gw:3128 -e https_proxy=http://aidevm6-gw:3128 -e NO_PROXY=aidevm6-gw \
  -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --workdir /tmp "aidev-agent:$CV" \
  claude -p --output-format stream-json --verbose --dangerously-skip-permissions --strict-mcp-config --mcp-config "$M13HOME/context7.sandbox.local.json" \
  > /tmp/claude-m13.out 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m13.out
grep -o '"name":"mcp__context7__[a-z-]*"' /tmp/claude-m13.out | sort | uniq -c; tail -2 /tmp/claude-m13.out
docker logs aidevm6-gw 2>&1 | grep -c '"type":"deny"'
```
Expected：出現 `mcp__context7__resolve-library-id` 的 tool_use、最後回覆含 `/expressjs/express` 之類的 id、閘道 deny 計數 0

- [ ] **Step 3：收掉**

```bash
unset CLAUDE_CODE_OAUTH_TOKEN; rm -rf "$M13HOME"
docker rm -f aidevm6-gw; docker network rm aidevm6-agent-net
```
- 查不到（tool_use 失敗或 deny 計數非 0）→ 把 deny 的目的地記下回報：可能 context7 另有網域（例如 CDN）要加進 `ALLOWED_CONNECT`，**加白名單需使用者同意**。

---
## Task 2.14：platformDB／odooGlossary／getLog 三個 skill 在容器內改打 `/ai`

**為什麼**：規格 §7——`platformDB` 的 `query.js` 靠 `DATABASE_URL` 直連、`odooGlossary` 借它查術語表，容器內兩者都不存在也不該有；X6——`getLog/SKILL.md:28,49` 寫死 `http://localhost:3939`。改完必跑 `node scripts/sync-skills.js`（rules/always 13）。

**Files:**
- Modify: `.claude/skills/platformDB/query.js`
- Modify: `.claude/skills/platformDB/SKILL.md`（「連線」段）
- Modify: `.claude/skills/odooGlossary/SKILL.md`（「怎麼查」段）
- Modify: `.claude/skills/getLog/SKILL.md:18-28,49`
- 產生：`.agents/skills/` 三份副本（由 `scripts/sync-skills.js` 產生，不手改）
- Test: `app/server/tests/platformdb-skill.test.js`

**Interfaces:**
- Consumes：`POST /ai/platform/query`（第 1 部 1.11）、`GET /ai/glossary`（1.9）
- Produces：`query.js` 的連線優先序——①有 `DATABASE_URL` env → 直連（行為不變）；②沒有 `DATABASE_URL`、有 `AIDEV_AI_BASE`＋`AIDEV_AI_TOKEN` → 打 `/ai/platform/query`；③否則讀 `data/config.json`（行為不變）。`pg` 改為 lazy require（容器內沒有 `app/node_modules`）。

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/platformdb-skill.test.js
// 意圖：健檢 AI 在容器裡照 SKILL.md 跑 query.js，沒有 DATABASE_URL、也沒有 app/node_modules，
// 必須自動改走 /ai/platform/query；有 DATABASE_URL 的互動式／舊路徑行為不變。唯讀護欄在兩條路上都要先擋。
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const QUERY_JS = path.join(__dirname, '..', '..', '..', '.claude', 'skills', 'platformDB', 'query.js');
function runQuery(args, env) {
  return new Promise(resolve => execFile(process.execPath, [QUERY_JS, ...args], { env, cwd: require('os').tmpdir() },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
}

let server, port, seen;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      seen = { url: req.url, token: req.headers['x-aidev-ai-token'], body: JSON.parse(body || '{}') };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, columns: ['n'], rows: [{ n: 42 }], row_count: 1, truncated: false }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));

test('沒有 DATABASE_URL、有 AIDEV_AI_BASE／TOKEN → 打 /ai/platform/query 並帶通行證', async () => {
  seen = null;
  const r = await runQuery(['--json', 'SELECT COUNT(*) n FROM tasks'], { PATH: process.env.PATH, AIDEV_AI_BASE: `http://127.0.0.1:${port}`, AIDEV_AI_TOKEN: 'run-tok' });
  expect(r.code).toBe(0);
  expect(seen).toEqual({ url: '/ai/platform/query', token: 'run-tok', body: { sql: 'SELECT COUNT(*) n FROM tasks' } });
  expect(JSON.parse(r.stdout)).toEqual([{ n: 42 }]);
});

test('/ai 回 ok:false → exit 1 並印出錯誤', async () => {
  const s2 = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{"ok":false,"error":"permission denied for table users"}')); });
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const r = await runQuery(['SELECT password_hash FROM users'], { PATH: process.env.PATH, AIDEV_AI_BASE: `http://127.0.0.1:${s2.address().port}`, AIDEV_AI_TOKEN: 't' });
  await new Promise(res => s2.close(res));
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/permission denied/);
});

test('非唯讀語句在送出前就擋（exit 2），不打 /ai', async () => {
  seen = null;
  const r = await runQuery(['DELETE FROM tasks'], { PATH: process.env.PATH, AIDEV_AI_BASE: `http://127.0.0.1:${port}`, AIDEV_AI_TOKEN: 't' });
  expect(r.code).toBe(2);
  expect(seen).toBeNull();
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/platformdb-skill.test.js`
Expected：FAIL（`query.js` 頂端 require pg 或讀 config 失敗）

- [ ] **Step 3：改 `query.js`**（檔頭說明補一段；`const { Pool } = require(...)` 那行刪掉；`connString` 之後新增 `viaAi`；最後的 async IIFE 改寫）

檔頭註解「連線字串優先序」段改為：
```js
 * 連線優先序：
 *   1. 環境變數 DATABASE_URL → 直連（互動式 session、舊的無容器 pipeline）
 *   2. 沒有 DATABASE_URL，但有 AIDEV_AI_BASE＋AIDEV_AI_TOKEN → POST $AIDEV_AI_BASE/ai/platform/query
 *      （AI 容器內：沒有 DATABASE_URL、沒有 app/node_modules；平台以唯讀帳號代查、遮蔽敏感欄位）
 *   3. <repo>/data/config.json 的 DATABASE_URL → 直連
```
新增函式（`connString` 之後）：
```js
function viaAi(sql) {
  const http = require('http');
  const u = new URL('/ai/platform/query', process.env.AIDEV_AI_BASE);
  const body = JSON.stringify({ sql });
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-AIDEV-AI-TOKEN': process.env.AIDEV_AI_TOKEN } }, res => {
      let raw = ''; res.on('data', c => { raw += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(raw); } catch { return reject(new Error(`HTTP ${res.statusCode}：${raw.slice(0, 300)}`)); }
        if (!j.ok) return reject(new Error(j.error || `HTTP ${res.statusCode}`));
        resolve(j.rows);
      });
    });
    req.on('timeout', () => req.destroy(new Error('查詢逾時（60s）')));
    req.on('error', reject);
    req.end(body);
  });
}
```
IIFE 改為：
```js
(async () => {
  const useAi = !process.env.DATABASE_URL && process.env.AIDEV_AI_BASE && process.env.AIDEV_AI_TOKEN;
  let pool = null;
  try {
    let rows;
    if (useAi) rows = await viaAi(sql);
    else {
      const { Pool } = require(path.join(repoRoot, 'app', 'node_modules', 'pg'));
      pool = new Pool({ connectionString: connString() });
      ({ rows } = await pool.query(sql));
    }
    if (asJson) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('(0 rows)');
    else console.table(rows);
  } catch (e) {
    console.error('查詢失敗：' + e.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
})();
```

- [ ] **Step 4：改三份 SKILL.md**

`platformDB/SKILL.md`「連線（別再重挖）」段最後加：
```markdown
- **在 AI 容器裡**（沒有 `DATABASE_URL`、有 `$AIDEV_AI_BASE`／`$AIDEV_AI_TOKEN`）：同一支 `query.js` 會自動改走 `/ai/platform/query`，由平台以唯讀帳號代查。密碼雜湊、`*_enc` 密文、session token 等欄位**讀不到**（回 `permission denied`），這是刻意的，換個欄位查即可。只有健檢 AI 有這個權限；其他 AI 會拿到 403。
```
`odooGlossary/SKILL.md`「怎麼查」段最前面加：
```markdown
**有 `$AIDEV_AI_BASE` 時（AI 執行環境）走端點**，不需要資料庫連線：

```bash
curl -s -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" "$AIDEV_AI_BASE/ai/glossary?version=19&term=Delivery%20Orders"   # 英文精確
curl -s -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" "$AIDEV_AI_BASE/ai/glossary?version=19&q=order"                  # 英文片段
curl -s -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" "$AIDEV_AI_BASE/ai/glossary?version=19&zh=%E4%BA%A4%E8%B2%A8"    # 中文片段（URL 編碼）
```
回傳依 `hit_count` 由高到低、最多 50 筆。互動式 session 沒有 `$AIDEV_AI_BASE` 時照下面借 platformDB 查。
```
`getLog/SKILL.md`：
```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox
sed -i 's#http://localhost:3939#$AIDEV_AI_BASE#g' .claude/skills/getLog/SKILL.md
grep -n 'localhost:3939\|AIDEV_AI_BASE' .claude/skills/getLog/SKILL.md
```
並在第 18 行（`export AIDEV_AI_TOKEN=...` 那行）之後補與 getSQL 相同的一行：
```markdown
> export AIDEV_AI_BASE=$(node -e "console.log('http://localhost:'+(require('./data/config.json').PORT||3939))")
```
Expected（grep）：沒有 `localhost:3939`（除了上面這行 export 內的 `localhost:`）

- [ ] **Step 5：同步副本並跑測試**

```bash
node scripts/sync-skills.js
cd app && npx jest server/tests/platformdb-skill.test.js server/tests/skills-sync.test.js
```
Expected：PASS

- [ ] **Step 6：Commit**

```bash
git add .claude/skills/platformDB/query.js .claude/skills/platformDB/SKILL.md .claude/skills/odooGlossary/SKILL.md .claude/skills/getLog/SKILL.md .agents/skills/platformDB .agents/skills/odooGlossary .agents/skills/getLog app/server/tests/platformdb-skill.test.js
git commit -m "[AgentSandbox]: 容器裡沒有 DATABASE_URL，健檢查平台 DB 與術語表的 skill 要改走 /ai，getLog 也不能寫死埠號

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.15：白名單 skill 唯讀掛進容器家目錄

**前置**：M7 的 skill 探針**有**出現（使用者層 `$HOME/.claude/skills` 在 headless 會載入）。沒出現 → M7 已要求停下來問，不做本 Task。

**為什麼**：X9——chat／cs 等沒傳 cwd 的 agent 現在以平台 repo 根為 cwd，原生載得到全部 `.claude/skills`；進容器後 workdir 換成唯讀主 clone，getSQL／getLog／wikiQuery 會消失。改成依 scope 白名單唯讀掛到 `<HOME>/.claude/skills/<name>`（順便收掉原本不該有的 pushRepo、platformDB 等，比照 `worktree-skills.js` 的白名單精神）。掛載點目錄必須由平台先建：交給 dockerd 建會是 root 擁有，容器內 1004 就寫不進 `.claude/`，session 檔存不下來。

**Files:**
- Modify: `app/server/lib/agent-mounts.js`
- Test: `app/server/tests/agent-mounts.test.js`（追加）

**Interfaces:**
- Produces：`SKILLS_BY_SCOPE: { project: ['getSQL','getLog','wikiQuery','odooGlossary','odooDev'], 'internal-audit': ['healthCheck','platformDB','wikiQuery','odooGlossary'], 'internal-fix': ['platformDev','healthCheck','odooGlossary'], none: [] }`；`resolveSandboxMounts` 多出 `{ source: <APP>/.agents/skills/<name>, target: <home>/.claude/skills/<name>, readonly: true }`，並預先 `mkdirSync(target, { recursive: true })`

- [ ] **Step 1：追加失敗測試**（`agent-mounts.test.js` 檔尾；沿用該檔的 `R`、`deps`、`base`、`appDir`）

```js
describe('白名單 skill 掛進家目錄（計畫 X9）', () => {
  const { SKILLS_BY_SCOPE } = require('../lib/agent-mounts');
  beforeAll(() => {
    for (const n of ['getSQL', 'getLog', 'wikiQuery', 'odooGlossary', 'odooDev', 'healthCheck', 'platformDB', 'platformDev', 'pushRepo']) {
      fs.mkdirSync(path.join(appDir, '.agents', 'skills', n), { recursive: true });
    }
  });
  const skillTargets = (m, home) => m.mounts.filter(x => (x.target || '').startsWith(path.join(home, '.claude', 'skills'))).map(x => path.basename(x.target)).sort();

  test('客戶 agent：只有查客戶資料用的 skill，沒有 platformDB／pushRepo', async () => {
    const ctx = base({ profile: profileFor('chat'), taskDbId: null, chatId: 5 });
    const m = await resolveSandboxMounts(ctx, deps);
    expect(skillTargets(m, ctx.home)).toEqual([...SKILLS_BY_SCOPE.project].sort());
    expect(m.mounts.filter(x => x.target && x.target.startsWith(ctx.home)).every(x => x.readonly)).toBe(true);
    // 掛載點由平台先建（避免 dockerd 建成 root 擁有、容器內寫不進 .claude）
    expect(fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'getSQL'))).toBe(true);
  });

  test('修正級內部 AI 拿不到 platformDB（R6-A）', async () => {
    const wt = path.join(appDir, '.claude', 'worktrees', 'fix-12');
    const ctx = base({ profile: profileFor('platform_fix'), projectId: null, taskDbId: null, cwd: wt, home: path.join(appDir, 'data', 'agent-home', 'internal-fix') });
    const m = await resolveSandboxMounts(ctx, deps);
    expect(skillTargets(m, ctx.home)).not.toContain('platformDB');
    expect(skillTargets(m, ctx.home)).toEqual([...SKILLS_BY_SCOPE['internal-fix']].sort());
  });

  test('none：不掛任何 skill', async () => {
    const ctx = base({ profile: profileFor('deploy_fix'), projectId: null, taskDbId: null, home: path.join(appDir, 'data', 'agent-home', 'none') });
    const m = await resolveSandboxMounts(ctx, deps);
    expect(skillTargets(m, ctx.home)).toEqual([]);
  });
});
```
（檔頭 `none（deploy_fix）` 那條原本斷言「只有三個來源」仍成立，因為 none 不掛 skill。）

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-mounts.test.js`
Expected：FAIL（`SKILLS_BY_SCOPE` undefined）

- [ ] **Step 3：實作**（`agent-mounts.js`）

`MAX_LOG_FILES` 之後加：
```js
// 依 scope 掛進容器家目錄的 skill（計畫 X9）。白名單是刻意的：平台自己的 skill 教的是平台內部操作，
// 交給客戶 agent 等於把不該有的能力交出去（同 pipeline/worktree-skills.js 的理由）。
const SKILLS_BY_SCOPE = Object.freeze({
  project: Object.freeze(['getSQL', 'getLog', 'wikiQuery', 'odooGlossary', 'odooDev']),
  'internal-audit': Object.freeze(['healthCheck', 'platformDB', 'wikiQuery', 'odooGlossary']),
  'internal-fix': Object.freeze(['platformDev', 'healthCheck', 'odooGlossary']),
  none: Object.freeze([]),
});
```
`defaults()` 回傳物件加 `mkdirSync: fs.mkdirSync,`。

`resolveSandboxMounts` 內，`let kind = profile.mount;` 那兩行之後加：
```js
  const skillScope = kind === 'none' && profile.scope === 'project' ? 'none' : profile.scope;
  for (const name of SKILLS_BY_SCOPE[skillScope] || []) {
    const src = path.join(pp.skills, name);
    if (!d.existsSync(src)) continue;
    const target = path.join(ctx.home, '.claude', 'skills', name);
    d.mkdirSync(target, { recursive: true });
    mounts.push({ source: src, target, readonly: true });
  }
```
（`chat-to-task` 是 project 類、mount none：它不需要查資料，照上式得到 `none` 不掛；`projectId` 為 null 的 project 類同樣不掛。）

`module.exports` 加 `SKILLS_BY_SCOPE`。

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-mounts.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/agent-mounts.js app/server/tests/agent-mounts.test.js
git commit -m "[AgentSandbox]: 對話與客服 AI 進容器後原本從平台根目錄載得到的查 DB／查 log skill 會消失，改成依 scope 白名單唯讀掛入

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2.16：session 檔複製工具（切換日用）

**為什麼**：規格 §6／§9 第 4 步——容器的 HOME 是 `data/agent-home/<scope>`，既有 session 在 `~/.claude/projects/<編碼後的 cwd>/`（volume `odoo-v2_claude-home`）。不複製的話，每個正在續接的任務與對話第一輪都會「session 遺失→降級 fresh」（Task 2.4 已保證不會壞，只是多花一輪）。claude 的目錄編碼 09-15 實查為「非英數字元一律換成 `-`」（例：`/home/odoo/odoo-v2/repos/odoo17-concord/.worktrees/task_service_4015` → `-home-odoo-odoo-v2-repos-odoo17-concord--worktrees-task-service-4015`）。

**09-15 實查的 session 欄位**：`tasks.{analysis,qa,cs,clarify,spec,coding}_session_id`、`project_chats.chat_session_id`（`coding_session_id` 已不用：coding 無狀態，rules/pipeline 74）。

| 來源 | 舊 cwd | 容器內 workdir | 複製方式 |
|---|---|---|---|
| analysis／qa／spec_tour／（有 worktree 的）clarify、spec-review | 任務 worktree 父目錄 | 同一路徑 | 整個 `<enc(wt)>` 目錄 |
| cs | 平台 repo 根（`APP_DIR`） | 專案根 `info.root` | 單檔 `<enc(APP_DIR)>/<sid>.jsonl` → `<enc(info.root)>/` |
| chat | 平台 repo 根 | 專案根 | 同上 |
| （沒有 worktree 的）clarify、spec-review | 平台 repo 根 | 容器家目錄 | 單檔 → `<enc(家目錄)>/` |
| 內部 AI（健檢、修正） | 平台 repo 根／`fix-*` | 每次新開的 worktree | 不複製（每次路徑都不同，本來就不續接） |

**Files:**
- Create: `app/server/lib/agent-session-migrate.js`
- Create: `tools/copy-agent-sessions.js`
- Test: `app/server/tests/agent-session-migrate.test.js`

**Interfaces:**
- Produces：
  - `encodeProjectDir(absPath) → string`
  - `planSessionCopies(deps?) → Promise<{ from, to, kind: 'dir'|'file', reason }[]>`（只列來源存在者；同一個 `to` 去重）
  - `applySessionCopies(plans, deps?) → { copied: number, skipped: number }`（目標已存在一律跳過，不覆寫）
  - CLI：`node tools/copy-agent-sessions.js`（預設只列計畫）／`--apply`

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-session-migrate.test.js
// 意圖：切換到容器那天，把還在續接的 session 放到容器 HOME 裡「容器 workdir 對應的」目錄。
// 放錯目錄＝等於沒搬（claude 依 cwd 找）；覆寫＝可能蓋掉容器裡已經續接過的新 session。
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/agent-session-migrate');

test('encodeProjectDir 與 claude 實際目錄名一致（09-15 實查樣本）', () => {
  expect(m.encodeProjectDir('/home/odoo/odoo-v2')).toBe('-home-odoo-odoo-v2');
  expect(m.encodeProjectDir('/home/odoo/odoo-v2/repos/odoo17-concord/.worktrees/task_service_4015'))
    .toBe('-home-odoo-odoo-v2-repos-odoo17-concord--worktrees-task-service-4015');
  expect(m.encodeProjectDir('/home/odoo/odoo-v2/.claude/worktrees/fix-1')).toBe('-home-odoo-odoo-v2--claude-worktrees-fix-1');
});

describe('plan／apply', () => {
  let R, claudeHome, appDir, deps;
  const w = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  beforeAll(() => {
    R = fs.mkdtempSync(path.join(os.tmpdir(), 'sessmig-'));
    claudeHome = path.join(R, 'claude');
    appDir = path.join(R, 'app');
    const root7 = path.join(appDir, 'repos', 'p7');
    const wt = path.join(root7, '.worktrees', 'task_7');
    fs.mkdirSync(wt, { recursive: true });
    const P = path.join(claudeHome, 'projects');
    w(path.join(P, m.encodeProjectDir(wt), 'qa-sess.jsonl'));
    w(path.join(P, m.encodeProjectDir(appDir), 'cs-sess.jsonl'));
    w(path.join(P, m.encodeProjectDir(appDir), 'chat-sess.jsonl'));
    w(path.join(P, m.encodeProjectDir(appDir), 'spec-sess.jsonl'));
    deps = {
      claudeHome, appDir,
      query: async (sql) => {
        if (/FROM tasks/.test(sql)) return { rows: [
          { id: 70, task_id: 'task_7', project_id: 7, analysis_session_id: null, qa_session_id: 'qa-sess', cs_session_id: 'cs-sess', clarify_session_id: null, spec_session_id: null },
          { id: 71, task_id: 'task_nowt', project_id: 7, analysis_session_id: null, qa_session_id: null, cs_session_id: null, clarify_session_id: null, spec_session_id: 'spec-sess' },
        ] };
        if (/FROM project_chats/.test(sql)) return { rows: [{ id: 5, project_id: 7, chat_session_id: 'chat-sess' }, { id: 6, project_id: 7, chat_session_id: 'gone' }] };
        throw new Error(sql);
      },
      getProjectInfo: async id => (id === 7 ? { root: root7 } : null),
      worktreeParent: (root, t) => path.join(root, '.worktrees', t),
    };
  });
  afterAll(() => fs.rmSync(R, { recursive: true, force: true }));

  test('計畫：worktree 整目錄、cs／chat 搬到專案根、無 worktree 的 spec 搬到容器家目錄；來源不存在的不列', async () => {
    const plans = await m.planSessionCopies(deps);
    const home = path.join(appDir, 'data', 'agent-home', 'project-7', '.claude', 'projects');
    const root7 = path.join(appDir, 'repos', 'p7');
    const wt = path.join(root7, '.worktrees', 'task_7');
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'dir', to: path.join(home, m.encodeProjectDir(wt)) }),
      expect.objectContaining({ kind: 'file', to: path.join(home, m.encodeProjectDir(root7), 'cs-sess.jsonl') }),
      expect.objectContaining({ kind: 'file', to: path.join(home, m.encodeProjectDir(root7), 'chat-sess.jsonl') }),
      expect.objectContaining({ kind: 'file', to: path.join(home, m.encodeProjectDir(path.join(appDir, 'data', 'agent-home', 'project-7')), 'spec-sess.jsonl') }),
    ]));
    expect(plans.some(p => p.from.includes('gone'))).toBe(false);
    expect(plans.length).toBe(4);
  });

  test('套用：複製、不覆寫既有目標；第二次全部跳過', async () => {
    const plans = await m.planSessionCopies(deps);
    const first = m.applySessionCopies(plans);
    expect(first).toEqual({ copied: 4, skipped: 0 });
    for (const p of plans) expect(fs.existsSync(p.to)).toBe(true);
    const second = m.applySessionCopies(plans);
    expect(second).toEqual({ copied: 0, skipped: 4 });
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-session-migrate.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-session-migrate'`

- [ ] **Step 3：實作**

```js
// app/server/lib/agent-session-migrate.js
/**
 * agent-session-migrate.js — 切換到 AI 容器那天，把續接中的 session 檔複製進各 scope 家目錄（子專案 0 §6、§9-4）
 * claude 依 cwd 找 session：~/.claude/projects/<cwd 非英數字元換成 -> /<sessionId>.jsonl。
 * 只複製不搬移、不覆寫：原檔留著，舊路徑（開關 off）照樣能續接；容器裡已續接過的新檔不會被蓋掉。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function encodeProjectDir(absPath) { return String(absPath).replace(/[^a-zA-Z0-9]/g, '-'); }

async function planSessionCopies(deps = {}) {
  const d = {
    query: (...a) => require('../db').query(...a),
    getProjectInfo: (...a) => require('../pipeline/task-agent').getProjectInfo(...a),
    worktreeParent: (...a) => require('../pipeline/task-agent').worktreeParent(...a),
    claudeHome: path.join(os.homedir(), '.claude'),
    appDir: path.resolve(__dirname, '..', '..', '..'),
    existsSync: fs.existsSync,
    ...deps,
  };
  const src = path.join(d.claudeHome, 'projects');
  const oldPlatformDir = path.join(src, encodeProjectDir(d.appDir));
  const infoCache = new Map();
  const info = async pid => { if (!infoCache.has(pid)) infoCache.set(pid, await d.getProjectInfo(pid)); return infoCache.get(pid); };
  const scopeHome = pid => path.join(d.appDir, 'data', 'agent-home', `project-${pid}`);
  const dest = pid => path.join(scopeHome(pid), '.claude', 'projects');
  const plans = [];
  const add = (kind, from, to, reason) => { if (d.existsSync(from) && !plans.some(p => p.to === to)) plans.push({ kind, from, to, reason }); };

  const { rows: tasks } = await d.query(
    `SELECT id, task_id, project_id, analysis_session_id, qa_session_id, cs_session_id, clarify_session_id, spec_session_id
       FROM tasks
      WHERE project_id IS NOT NULL
        AND (analysis_session_id IS NOT NULL OR qa_session_id IS NOT NULL OR cs_session_id IS NOT NULL
             OR clarify_session_id IS NOT NULL OR spec_session_id IS NOT NULL)`);
  for (const t of tasks) {
    const pi = await info(t.project_id);
    if (!pi) continue;
    const wt = d.worktreeParent(pi.root, t.task_id);
    const wtExists = d.existsSync(wt);
    if (wtExists) add('dir', path.join(src, encodeProjectDir(wt)), path.join(dest(t.project_id), encodeProjectDir(wt)), `task ${t.id} worktree`);
    if (t.cs_session_id) {
      add('file', path.join(oldPlatformDir, `${t.cs_session_id}.jsonl`), path.join(dest(t.project_id), encodeProjectDir(pi.root), `${t.cs_session_id}.jsonl`), `task ${t.id} cs`);
    }
    if (!wtExists) {
      for (const sid of [t.clarify_session_id, t.spec_session_id].filter(Boolean)) {
        add('file', path.join(oldPlatformDir, `${sid}.jsonl`), path.join(dest(t.project_id), encodeProjectDir(scopeHome(t.project_id)), `${sid}.jsonl`), `task ${t.id} clarify/spec`);
      }
    }
  }

  const { rows: chats } = await d.query(
    'SELECT id, project_id, chat_session_id FROM project_chats WHERE chat_session_id IS NOT NULL AND project_id IS NOT NULL');
  for (const c of chats) {
    const pi = await info(c.project_id);
    if (!pi) continue;
    add('file', path.join(oldPlatformDir, `${c.chat_session_id}.jsonl`), path.join(dest(c.project_id), encodeProjectDir(pi.root), `${c.chat_session_id}.jsonl`), `chat ${c.id}`);
  }
  return plans;
}

function applySessionCopies(plans, deps = {}) {
  const d = { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, cpSync: fs.cpSync, ...deps };
  let copied = 0; let skipped = 0;
  for (const p of plans) {
    if (d.existsSync(p.to)) { skipped++; continue; }
    d.mkdirSync(path.dirname(p.to), { recursive: true, mode: 0o700 });
    d.cpSync(p.from, p.to, { recursive: p.kind === 'dir', errorOnExist: true, force: false });
    copied++;
  }
  return { copied, skipped };
}

module.exports = { encodeProjectDir, planSessionCopies, applySessionCopies };
```

```js
#!/usr/bin/env node
// tools/copy-agent-sessions.js — 子專案 0 切換日：把續接中的 claude session 複製進 data/agent-home/<scope>/
// 用法：DATABASE_URL=... node tools/copy-agent-sessions.js          （只列計畫）
//       DATABASE_URL=... node tools/copy-agent-sessions.js --apply  （真的複製；不覆寫）
const m = require('../app/server/lib/agent-session-migrate');
const db = require('../app/server/db');

(async () => {
  const plans = await m.planSessionCopies();
  const byReason = {};
  for (const p of plans) { const k = p.reason.split(' ').slice(-1)[0]; byReason[k] = (byReason[k] || 0) + 1; }
  console.log(`計畫複製 ${plans.length} 項：`, byReason);
  for (const p of plans.slice(0, 10)) console.log(`  ${p.kind} ${p.from}\n    → ${p.to}`);
  if (process.argv.includes('--apply')) console.log('結果：', m.applySessionCopies(plans));
  else console.log('（未加 --apply，沒有複製任何檔案）');
  await db.getPool().end();
})().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-session-migrate.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/agent-session-migrate.js tools/copy-agent-sessions.js app/server/tests/agent-session-migrate.test.js
git commit -m "[AgentSandbox]: 容器的家目錄換了，續接中的任務與對話第一輪都會找不到 session 白跑一輪，切換日要能把 session 複製到容器對應的目錄

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 第 2 部完成檢查

- [ ] `cd app && npm run test:quiet`：與 Task 0 基線相比只多不少、無新紅燈
- [ ] `git log --oneline origin/master..HEAD | grep -c AgentSandbox` ≥ 第 1 部 12＋本部 13（2.1–2.12、2.14–2.16；2.13 與 M5–M9 是量測，不 commit）
- [ ] 量測紀錄 M5–M9、2.13 都已寫進 `docs/superpowers/plans/2026-09-15-agent-sandbox-M1-table.md`，且沒有任何一項判定「停下來」
- [ ] 本部**不需要重啟**；開關仍 `off`（碼尚未合併）
- [ ] 規格對照：§4.1（2.1）、§4.3（2.2、2.3）、§4.6（2.11、2.12）、§5（2.5、2.6）、§6（2.4、2.6、2.7、2.8）、§7（2.14、2.15）、§9-4 工具（2.16）
- [ ] 進入第 3 部：`docs/superpowers/plans/2026-09-15-agent-sandbox-part3-rollout.md`
