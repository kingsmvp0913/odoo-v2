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

// 意圖（09-17 R12）：宿主在任務 worktree 跑 git／寫回指標之前，必須等掛著它（可寫）的容器真的結束，
// 否則容器可以在宿主驗完、寫完之後再改一次（TOCTOU）。
describe('waitForWorktreeIdle：任務 worktree 的獨占', () => {
  const fs = require('fs');
  const os = require('os');
  const { profileFor } = require('../lib/agent-profiles');
  let wtRoot, wt;
  beforeEach(() => {
    wtRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-idle-')));
    wt = path.join(wtRoot, 'task_7'); fs.mkdirSync(path.join(wt, 'main'), { recursive: true });
  });
  afterEach(() => fs.rmSync(wtRoot, { recursive: true, force: true }));
  const wtDeps = (over = {}) => deps({ resolveSandboxMounts: async () => ({ mounts: [{ source: wt, readonly: false }], workdir: wt }), ...over });
  const start = (d, agentType = 'coding') => sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType, taskId: 70 }, profile: profileFor(agentType), projectId: 7 }, d);

  test('容器掛著時等待；release（docker wait 回來）之後才放行', async () => {
    const waits = [];
    const { d } = wtDeps({ execFile: (cmd, args, cb) => { if (args[0] === 'wait') waits.push(cb); else if (cb) cb(null); } });
    const run = await start(d);
    let idle = false;
    const p = sr.waitForWorktreeIdle(path.join(wt, 'main'), { timeoutMs: 5000, pollMs: 5 }).then(() => { idle = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(idle).toBe(false);
    const rel = run.release();
    await new Promise(r => setTimeout(r, 30));
    expect(idle).toBe(false);             // 容器還沒真的結束（docker wait 未回）
    expect(waits.length).toBe(1);
    waits[0](null); await rel; await p;
    expect(idle).toBe(true);
  });

  test('等不到 → 丟例外（訊息寫明容器仍在執行）；timeoutMs=0 是不阻塞檢查，立刻丟 WORKTREE_BUSY', async () => {
    const { d } = wtDeps({ execFile: () => {} });
    const run = await start(d);
    await expect(sr.waitForWorktreeIdle(wt, { timeoutMs: 30, pollMs: 5 })).rejects.toThrow(/容器仍在/);
    const t0 = Date.now();
    await expect(sr.waitForWorktreeIdle(wt, { timeoutMs: 0, pollMs: 5000 })).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });
    expect(Date.now() - t0).toBeLessThan(1000);
    run.release();
  });

  test('沒有容器掛著 → 立即放行；準備失敗時不留登記', async () => {
    await expect(sr.waitForWorktreeIdle(wt, { timeoutMs: 10 })).resolves.toBeUndefined();
    const { d } = wtDeps({ getSandboxLimits: () => { throw new Error('limits boom'); } });
    await expect(start(d)).rejects.toThrow('limits boom');
    await expect(sr.waitForWorktreeIdle(wt, { timeoutMs: 10 })).resolves.toBeUndefined();
  });

  test('非任務 worktree 類（chat 掛唯讀專案根）不登記', async () => {
    const { d } = deps({ resolveSandboxMounts: async () => ({ mounts: [{ source: wt, readonly: true }], workdir: wt }), execFile: () => {} });
    await start(d, 'chat');
    await expect(sr.waitForWorktreeIdle(wt, { timeoutMs: 10 })).resolves.toBeUndefined();
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
