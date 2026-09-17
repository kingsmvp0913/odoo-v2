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
      getProjectInfo: async () => ({ root: '/p', repos: [] }),
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

// 意圖（09-15 Q4）：容器寫得到任務主 clone 的 .git，也就改得到 testing／main 指標。
// 開容器前一定要先拍下 refs（拍不到就不准跑），結束後除本任務分支外有變動就還原並回報。
describe('prepareSandboxRun：refs 快照守衛', () => {
  const { profileFor } = require('../lib/agent-profiles');
  const repos = [{ label: 'main', local_path: '/p/repo-a' }, { label: 'extra', local_path: '/p/repo-b' }];
  function guardDeps(over = {}) {
    const snaps = { '/p/repo-a': [], '/p/repo-b': [] };
    const refGuard = {
      snapshotRefs: jest.fn(async (p) => snaps[p].shift()),
      diffRefs: jest.requireActual('../lib/ref-guard').diffRefs,
      restoreRefs: jest.fn(async () => {}),
    };
    const queries = [];
    const base = deps({
      query: async (sql, params) => { queries.push([sql, params]); return { rows: [{ task_id: 'T-9', git_branch: null }] }; },
      getProjectInfo: async () => ({ root: '/p', repos }),
      refGuard,
      ...over,
    });
    return { ...base, refGuard, snaps, queries };
  }
  const M = (o) => new Map(Object.entries(o));

  test('task-worktree：開容器前逐 repo 快照；動到 testing 就還原並回說明，本任務分支（DB 未寫入時用 task/<task_id>）不算', async () => {
    const { d, refGuard, snaps } = guardDeps();
    snaps['/p/repo-a'].push(
      M({ 'refs/heads/testing': 'a1', 'refs/heads/task/T-9': 'b1' }),
      M({ 'refs/heads/testing': 'evil', 'refs/heads/task/T-9': 'b2' }),
    );
    snaps['/p/repo-b'].push(M({ 'refs/heads/testing': 'c1' }), M({ 'refs/heads/testing': 'c1' }));
    const run = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'spec_tour', taskId: 70 }, profile: profileFor('spec_tour'), projectId: 7 }, d);
    expect(refGuard.snapshotRefs).toHaveBeenCalledTimes(2);
    const msg = await run.verifyRefs();
    expect(msg).toMatch(/main: refs\/heads\/testing/);
    expect(msg).not.toMatch(/task\/T-9/);
    expect(refGuard.restoreRefs).toHaveBeenCalledTimes(1);
    expect(refGuard.restoreRefs).toHaveBeenCalledWith('/p/repo-a', [{ ref: 'refs/heads/testing', before: 'a1', after: 'evil' }]);
    // 只跑一次：再呼叫拿同一個結果，不會再拍快照、再還原
    await expect(run.verifyRefs()).resolves.toBe(msg);
    expect(refGuard.snapshotRefs).toHaveBeenCalledTimes(4);
    await run.release();
  });

  test('refs 沒被動 → verifyRefs 回 null；tasks.git_branch 有值時以它為準', async () => {
    const { d, refGuard, snaps } = guardDeps({
      query: async () => ({ rows: [{ task_id: 'T-9', git_branch: 'feature/x' }] }),
      getProjectInfo: async () => ({ root: '/p', repos: [repos[0]] }),
    });
    snaps['/p/repo-a'].push(M({ 'refs/heads/feature/x': 'a' }), M({ 'refs/heads/feature/x': 'b' }));
    const run = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'coding', taskId: 70 }, profile: profileFor('coding'), projectId: 7 }, d);
    await expect(run.verifyRefs()).resolves.toBeNull();
    expect(refGuard.restoreRefs).not.toHaveBeenCalled();
  });

  test('快照失敗 → 不准開容器（reject）且通行證作廢', async () => {
    const { d, refGuard } = guardDeps();
    refGuard.snapshotRefs.mockRejectedValueOnce(new Error('not a git repository'));
    await expect(sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'coding', taskId: 70 }, profile: profileFor('coding'), projectId: 7 }, d)).rejects.toThrow(/not a git repository/);
    expect(rt.activeRunCount()).toBe(0);
  });

  test('非 task-worktree 類（chat）、或沒有 taskId → 不快照，verifyRefs 回 null', async () => {
    const { d, refGuard } = guardDeps();
    const run = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'chat', taskId: 70 }, profile: profileFor('chat'), projectId: 7 }, d);
    await expect(run.verifyRefs()).resolves.toBeNull();
    const run2 = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'respec' }, profile: profileFor('respec'), projectId: 7 }, d);
    await expect(run2.verifyRefs()).resolves.toBeNull();
    expect(refGuard.snapshotRefs).not.toHaveBeenCalled();
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
