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
const { agentHomeDir } = require('../lib/agent-home');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TIMEOUT_MS = parseInt(process.env.CLAUDE_AGENT_TIMEOUT_MS || '2400000', 10);
const TOKEN_GRACE_MS = 10 * 60 * 1000;

// 可寫掛著任務 worktree 的「活著的容器」：realpath → 持有者數。宿主在該 worktree 跑 git 或寫回指標前
// 必須等它歸零（lib/worktree-guard.js），否則容器能在宿主處理完之後再改一次。
// 只放記憶體就夠：平台重啟時殘留容器會在啟動時被清掉（lib/agent-orphans.js，index.js 啟動流程）。
const busyWorktrees = new Map();
const WORKTREE_WAIT_MS = DEFAULT_TIMEOUT_MS + TOKEN_GRACE_MS;
const realOrResolve = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
function holdWorktree(p) { busyWorktrees.set(p, (busyWorktrees.get(p) || 0) + 1); }
function dropWorktree(p) {
  const n = (busyWorktrees.get(p) || 0) - 1;
  if (n > 0) busyWorktrees.set(p, n); else busyWorktrees.delete(p);
}
function worktreeBusy(target) {
  for (const p of busyWorktrees.keys()) {
    const rel = path.relative(p, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}
// timeoutMs=0＝不阻塞的檢查（專案鎖內用；忙就丟 WORKTREE_BUSY，由呼叫端離開鎖下一輪再試，09-17 R14）
async function waitForWorktreeIdle(worktreePath, { timeoutMs = WORKTREE_WAIT_MS, pollMs = 1000 } = {}) {
  const target = realOrResolve(worktreePath);
  const deadline = Date.now() + timeoutMs;
  while (worktreeBusy(target)) {
    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`掛著任務 worktree 的 AI 容器仍在執行（已等 ${Math.round(timeoutMs / 1000)} 秒），暫不對它執行 git：${worktreePath}`), { code: 'WORKTREE_BUSY' });
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// release 的時限（D1）：每個 docker 指令最多 60 秒（daemon 卡住時不能讓 worktree 永遠被當成使用中）；
// docker run CLI 在 release 時 60 秒內還沒退出，就由這裡 SIGKILL 它（停止路徑已先送過 SIGTERM／SIGKILL，
// 正常情況下早就退了）。確認不了容器已停 → worktree 維持使用中（寧可擋住宿主 git，也不讓宿主與還在跑
// 的容器同時改同一份檔案），背景依序隔 30 秒／1／2／3／4 分鐘重試（約 10 分鐘），確認停了就放。
const RELEASE_BOUNDS = { dockerMs: 60000, cliExitMs: 60000, retryDelaysMs: [30000, 60000, 120000, 180000, 240000] };
const NO_SUCH_CONTAINER = /No such (object|container)/i;
const unrefTimer = t => { if (t && t.unref) t.unref(); return t; };

// 跑一個 docker 子指令，一定會在時限內回來：{ err, out }。execFile 的 timeout 會殺掉卡住的 CLI；
// 外層計時器是保險——CLI 連回呼都沒有時也不會永遠等下去。
function dockerCall(execFileFn, args, ms) {
  return new Promise(resolve => {
    let done = false;
    let t = null;
    const end = (err, out) => { if (done) return; done = true; clearTimeout(t); resolve({ err, out: String(out || '') }); };
    t = unrefTimer(setTimeout(() => end(Object.assign(new Error(`docker ${args[0]} 超過 ${ms} ms 沒回應`), { killed: true })), ms + 1000));
    try {
      execFileFn('docker', args, { timeout: ms }, (err, stdout, stderr) => {
        if (err) err.message = `${err.message}\n${String(stderr || '')}`;
        end(err, stdout);
      });
    } catch (e) { end(e); }
  });
}

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
    buildClaudeAuthEnv: (...a) => require('../lib/claude-auth').buildClaudeAuthEnv(...a),
    getSandboxLimits: (...a) => require('../lib/agent-sandbox-flag').getSandboxLimits(...a),
    resolveSandboxMounts: (...a) => require('../lib/agent-mounts').resolveSandboxMounts(...a),
    importTaskObjects: (...a) => require('../lib/agent-objects').importTaskObjects(...a),
    createPlatformCleanWorktree: (...a) => require('../lib/platform-worktree').createPlatformCleanWorktree(...a),
    removePlatformCleanWorktree: (...a) => require('../lib/platform-worktree').removePlatformCleanWorktree(...a),
    sandboxMcpConfigPath,
    canRun: tok.canRun, issueRunToken: tok.issueRunToken, revokeRun: tok.revokeRun,
    resolveHomeBucket: (...a) => require('../lib/agent-home').resolveHomeBucket(...a),
    remainingTaskBudget: (...a) => require('../lib/task-budget').remainingTaskBudget(...a),
    mkdirSync: fs.mkdirSync, execFile,
    getuid: () => process.getuid(), getgid: () => process.getgid(),
    ...deps,
  };
  const scope = runScope(profile, projectId);
  const scopeProjectId = scope.startsWith('project-') ? projectId : null;
  if (!(await d.canRun(scope, opts.userId ?? null))) throw new Error(`此次 AI 執行未獲准（scope=${scope}）`);

  // 每一次任務 AI 執行都重算剩餘額度；CLI 的上限只管本次，跨關累計由 token_usage 把關。
  const remaining = opts.taskId != null ? await d.remainingTaskBudget(opts.taskId) : null;
  const cents = remaining == null ? null : Math.floor(remaining * 10000) / 10000;
  if (remaining != null && cents <= 0) {
    throw Object.assign(new Error('這張任務的剩餘花費額度不足，請公司管理員提高上限後再按繼續'), { code: 'TASK_BUDGET_EXCEEDED' });
  }
  const budgetArgs = cents == null ? claudeArgs : [...claudeArgs, '--max-budget-usd', cents.toFixed(4)];

  const infra = await d.ensureAgentInfra();
  const callerEnv = opts.env || {};
  // 階段 3：這一次的錢算誰的由 buildClaudeAuthEnv 決定——客戶公司用自己的 ANTHROPIC_API_KEY，
  // 內部／平台管理員／系統觸發用平台訂閱的 CLAUDE_CODE_OAUTH_TOKEN。它只會回**一把**。
  // 非同步只發生在這裡：claude-auth.js 檔頭寫明讀取端必須同步（runClaude 若改成 await 查 DB，
  // spawn 會晚一個 microtask，既有測試多是「呼叫後同步對 mock child 發事件」，會整片失效）。
  // prepareSandboxRun 本來就是 async 且手上有 opts.userId，所以解析放這裡不違反那條。
  // 客戶沒設 key 時這一行會丟 NO_ANTHROPIC_KEY 往外，刻意不接住：退回平台訂閱等於廠商
  // 替客戶付錢，而那不會報錯、只會在月底帳單上出現。
  const auth = { ...(await d.buildClaudeAuthEnv(opts.userId ?? null)) };
  // 呼叫端覆寫仍然保留：平台管理員存新 token 前會先拿候選 token 實跑一次驗證
  //（admin-routes.js 的 saveClaudeToken），那條路要能指定用哪一把。
  // 兩種憑證都要能被呼叫端覆寫，而且**覆寫時只留那一把**：存檔前的驗證一定要驗到候選憑證
  // 本人，否則等於沒驗。兩把並存時實際生效的是哪一把取決於官方優先序
  //（ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN），會驗到錯的那把而且不會有任何徵狀。
  if (callerEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    // 平台管理員存新的訂閱 token 前的驗證（admin-routes.js 的 saveClaudeToken）。
    auth.CLAUDE_CODE_OAUTH_TOKEN = callerEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete auth.ANTHROPIC_API_KEY;
  } else if (callerEnv.ANTHROPIC_API_KEY) {
    // 公司管理員存自家 API key 前的驗證。
    auth.ANTHROPIC_API_KEY = callerEnv.ANTHROPIC_API_KEY;
    delete auth.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (!auth.CLAUDE_CODE_OAUTH_TOKEN && !auth.ANTHROPIC_API_KEY) {
    throw new Error('容器模式需要一把 Anthropic 憑證：平台管理員在設定頁存入 Claude token，或客戶公司設定自己的 API key');
  }

  // 家目錄要同時分專案與分公司（lib/agent-home.js）：同一個專案可以綁給不只一家公司，
  // 只分專案會讓後進來的那家公司讀到前一家留在宿主目錄裡的整份逐字稿——容器 --rm，
  // 但這個目錄是掛進去的、不會跟著消失。內部公司回 null＝沿用舊路徑，續接中的 session 不受影響。
  const homeBucket = await d.resolveHomeBucket(opts.userId ?? null);
  const home = agentHomeDir(APP_DIR, scope, homeBucket);
  d.mkdirSync(home, { recursive: true, mode: 0o700 });
  const { runId, token } = d.issueRunToken({
    scope, projectId: scopeProjectId, ttlMs: (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + TOKEN_GRACE_MS,
  });

  let platformWorktree = null;
  let heldWorktree = null;
  try {
    if (profile.mount === 'platform-clean') platformWorktree = await d.createPlatformCleanWorktree(runId);
    const { mounts, workdir, env: mountEnv = {}, taskObjects = null } = await d.resolveSandboxMounts({
      profile, projectId: scopeProjectId, taskDbId: opts.taskId ?? null, cwd: opts.cwd, chatId: opts.chatId ?? null,
      feedbackIds: opts.feedbackIds || [], home, platformWorktree, appDir: APP_DIR,
    });
    if (/^task-worktree/.test(profile.mount) && mounts.some(m => !m.readonly && m.source === workdir)) {
      heldWorktree = realOrResolve(workdir);
      holdWorktree(heldWorktree);
    }
    const gw = infra.gatewayHost;
    const env = {
      CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', SECURITY_GUIDANCE_DISABLE: '1',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      AIDEV_AI_BASE: `http://${gw}:8080`, AIDEV_AI_TOKEN: token,
      HTTPS_PROXY: `http://${gw}:3128`, https_proxy: `http://${gw}:3128`, NO_PROXY: gw, no_proxy: gw,
      ...callerEnv, ...mountEnv, ...auth,
    };
    const { buildAgentRunArgs } = require('../lib/agent-sandbox');
    const built = buildAgentRunArgs({
      instanceId: infra.instanceId, runId, scope, image: infra.image, network: infra.network,
      user: `${d.getuid()}:${d.getgid()}`, mounts, workdir, home, env, limits: d.getSandboxLimits(),
      command: ['claude', ...replaceArg(budgetArgs, '--mcp-config', d.sandboxMcpConfigPath(opts.agentType))],
    });
    const bounds = { ...RELEASE_BOUNDS, ...(d.releaseBounds || {}) };
    const name = built.containerName;
    let released = false;
    let cliChild = null;
    let cliExited = null;
    // docker run CLI 是否已退出（在時限內）。沒 attach 過＝從沒 spawn，自然沒有 CLI 會去建立／啟動容器。
    const waitCliExit = () => {
      if (!cliExited) return Promise.resolve(true);
      return new Promise(resolve => {
        const t = unrefTimer(setTimeout(() => {
          try { cliChild.kill('SIGKILL'); } catch { /* 已經不在了 */ }
          resolve(false);
        }, bounds.cliExitMs));
        cliExited.then(() => { clearTimeout(t); resolve(true); });
      });
    };
    // 回 null＝確認容器不會再跑；否則回「為什麼確認不了」。
    // 為什麼 CLI 退出後 inspect 說「不存在／沒在跑」就安全：docker run 是前景附著模式，建立與啟動容器都是
    // 這個 CLI 送給 daemon 的呼叫。CLI 一旦死掉就再也送不出 start，所以此刻不存在或沒在跑的容器，之後永遠
    // 不會開始跑（被建立但沒啟動的容器沒有任何行程）。反過來，CLI 還活著時 docker 回「No such container」
    // 可能只是容器還沒建好（D1b：剛 spawn 就按停止），不能當成結束。
    const confirmStopped = async () => {
      if (!(await waitCliExit())) return `docker run CLI 在 ${bounds.cliExitMs} ms 內沒有退出（已送 SIGKILL）`;
      // 不存在／已停止都會回錯，一律忽略：結果以下面的 inspect 為準
      await dockerCall(d.execFile, ['kill', name], bounds.dockerMs);
      const ins = await dockerCall(d.execFile, ['inspect', '-f', '{{.State.Running}}', name], bounds.dockerMs);
      if (ins.err) return NO_SUCH_CONTAINER.test(ins.err.message) ? null : `docker inspect 失敗：${ins.err.message.trim()}`;
      const running = ins.out.trim();
      if (running === 'false') return null;
      if (running !== 'true') return `docker inspect 回傳無法判讀：${running}`;
      const w = await dockerCall(d.execFile, ['wait', name], bounds.dockerMs);
      if (!w.err || NO_SUCH_CONTAINER.test(w.err.message)) return null;
      return `docker wait 失敗：${w.err.message.trim()}`;
    };
    // D2：容器確定停了才把它寫進任務物件庫的東西驗證後搬進共用庫；失敗只記錄，合併前等關卡會再搬一次並擋下
    const importObjects = async () => {
      if (!taskObjects) return;
      await d.importTaskObjects({ ...taskObjects, clear: true })
        .catch(e => console.error(`[SANDBOX] 任務物件搬移失敗（${taskObjects.branch}）：${e.message}`));
    };
    const retryInBackground = i => {
      if (i >= bounds.retryDelaysMs.length) {
        console.error(`[SANDBOX] 重試用完仍無法確認容器 ${name} 已停止，worktree 維持使用中（宿主 git 會被擋住），需人工確認容器後重啟平台：${heldWorktree}`);
        return;
      }
      unrefTimer(setTimeout(async () => {
        const why = await confirmStopped();
        if (why === null) {
          await importObjects();
          dropWorktree(heldWorktree);
          console.error(`[SANDBOX] 重試確認容器 ${name} 已停止，worktree 放行：${heldWorktree}`);
        } else {
          console.error(`[SANDBOX] 第 ${i + 1} 次重試仍無法確認容器 ${name} 已停止（${why}）`);
          retryInBackground(i + 1);
        }
      }, bounds.retryDelaysMs[i]));
    };
    return {
      ...built, runId,
      kill: () => d.execFile('docker', ['kill', name], { timeout: bounds.dockerMs }, () => {}),
      // spawn 出 docker run CLI 後必須立刻呼叫：release 靠它知道 CLI 何時退出（見 confirmStopped）
      attach: child => {
        if (released) throw new Error(`容器 ${name} 已 release，不得再啟動`);
        cliChild = child;
        cliExited = new Promise(resolve => {
          if (child.exitCode != null || child.signalCode != null) resolve();
          child.once('exit', () => resolve());
          // spawn 本身失敗（沒有 pid）＝CLI 從沒跑起來
          child.once('error', () => { if (child.pid == null) resolve(); });
        });
        return child;
      },
      release: async () => {
        if (released) return;
        released = true;
        d.revokeRun(runId);
        // 容器確認不會再跑才放掉 worktree（逾時／停止時 release 會比容器先到，docker kill 是非同步）
        if (heldWorktree) {
          const why = await confirmStopped();
          if (why === null) { await importObjects(); dropWorktree(heldWorktree); }
          else {
            console.error(`[SANDBOX] 無法確認容器 ${name} 已停止（${why}），worktree 維持使用中並在背景重試：${heldWorktree}`);
            retryInBackground(0);
          }
        }
        if (platformWorktree) await d.removePlatformCleanWorktree(platformWorktree).catch(e => console.error('[SANDBOX] 移除乾淨 worktree 失敗：', e.message));
      },
    };
  } catch (err) {
    d.revokeRun(runId);
    if (heldWorktree) dropWorktree(heldWorktree);
    if (platformWorktree) await d.removePlatformCleanWorktree(platformWorktree).catch(() => {});
    throw err;
  }
}

module.exports = { resolveSandboxPlan, prepareSandboxRun, sandboxMcpConfigPath, replaceArg, waitForWorktreeIdle };
