// app/server/pipeline/sandbox-run.js
/**
 * sandbox-run.js — 一次 AI 執行的容器準備（子專案 0 §5）
 *   1. resolveSandboxPlan：開關有沒有涵蓋這個 agent（沒有＝null，呼叫端走原本的 spawn('claude')）
 *   2. prepareSandboxRun：canRun → infra → 通行證 → （內部健檢類）乾淨 worktree → 掛載 → （任務 worktree 類）refs 快照 → docker 參數
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
    query: (...a) => require('../db').query(...a),
    getProjectInfo: (...a) => require('./task-agent').getProjectInfo(...a),
    refGuard: null, // 預設 ../lib/ref-guard（延後 require）
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
    // refs 快照守衛（09-15 Q4）：task-worktree 類會把主 clone 的 .git 以讀寫掛進容器，AI 因此改得到
    // testing／main 指標。開容器前先拍快照（拍不到就不准跑，走下面的 catch 作廢通行證）；
    // verifyRefs 由 runner 在容器結束時呼叫，只跑一次，重複呼叫拿同一個結果。
    // 本任務分支：tasks.git_branch 要到 spec_tour 之後才寫入（runner.js），之前以慣例 task/<task_id> 為準。
    let verifyRefs = async () => null;
    if (/^task-worktree/.test(profile.mount) && opts.taskId != null && scopeProjectId != null) {
      const guard = d.refGuard || require('../lib/ref-guard');
      const { rows: [t] } = await d.query('SELECT task_id, git_branch FROM tasks WHERE id=$1', [opts.taskId]);
      if (!t) throw new Error(`找不到任務 ${opts.taskId}，無法拍 refs 快照`);
      const allowed = new Set([`refs/heads/${t.git_branch || `task/${t.task_id}`}`]);
      const info = await d.getProjectInfo(scopeProjectId);
      const repos = (info && info.repos) || [];
      const before = await Promise.all(repos.map(r => guard.snapshotRefs(r.local_path)));
      let checked = null;
      verifyRefs = () => (checked = checked || (async () => {
        const msgs = [];
        for (let i = 0; i < repos.length; i++) {
          const v = guard.diffRefs(before[i], await guard.snapshotRefs(repos[i].local_path), allowed);
          if (v.length) { await guard.restoreRefs(repos[i].local_path, v); msgs.push(`${repos[i].label}: ${v.map(x => x.ref).join(', ')}`); }
        }
        return msgs.length ? `AI 改動了本任務分支以外的 git ref，已還原：${msgs.join('；')}` : null;
      })());
    }
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
      ...built, runId, verifyRefs,
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
