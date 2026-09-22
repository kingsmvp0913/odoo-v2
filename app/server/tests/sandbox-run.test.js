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
      // 容器已不存在時 inspect 回 false（release 的正常收尾）
      execFile: (cmd, args, ...rest) => { calls.kill.push([cmd, ...args]); const cb = rest.pop(); if (typeof cb === 'function') cb(null, args[0] === 'inspect' ? 'false\n' : ''); },
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

  // 意圖（D1）：release 要等到「docker run CLI 已退出」且「容器確認沒在跑」才放 worktree。
  //  - CLI 還活著時容器可能還沒建好：此刻 docker 回「No such container」不代表結束（D1b 競態）
  //  - CLI 死了就再也送不出 start：此時容器不存在／沒在跑＝永遠不會再跑
  //  - docker 卡住時寧可維持使用中（fail closed），但要記錄並在背景重試，不能等平台重啟
  const SHORT = { dockerMs: 20, cliExitMs: 40, retryDelaysMs: [30, 30] };
  const EventEmitter = require('events');
  const fakeCli = () => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, kill: jest.fn() });
  const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
  // docker 假實作：handlers[子指令](cb, args) 決定怎麼回；沒列到的回成功
  const fakeDocker = (handlers, log = []) => (cmd, args, opts, cb) => {
    log.push({ args, opts });
    const h = handlers[args[0]];
    if (h) h(cb, args); else cb(null, '', '');
  };
  const noSuch = cb => cb(Object.assign(new Error('Command failed\nError: No such container: x'), { code: 1 }), '', 'Error: No such container: x');
  const busy = async () => { try { await sr.waitForWorktreeIdle(wt, { timeoutMs: 0 }); return false; } catch (e) { return e.code === 'WORKTREE_BUSY'; } };

  test('CLI 還沒退出 → 不放；退出後 inspect=false 才放，每個 docker 指令都帶時限', async () => {
    const log = [];
    const { d } = wtDeps({ releaseBounds: SHORT, execFile: fakeDocker({ inspect: cb => cb(null, 'false\n', '') }, log) });
    const run = await start(d);
    const cli = fakeCli(); run.attach(cli);
    const rel = run.release();
    await tick(10);
    expect(await busy()).toBe(true);
    expect(log.length).toBe(0);                     // CLI 活著時不去問 docker
    cli.emit('exit', 0);
    await rel;
    expect(await busy()).toBe(false);
    expect(log.map(c => c.args[0])).toEqual(['kill', 'inspect']);
    expect(log.every(c => c.opts && c.opts.timeout === SHORT.dockerMs)).toBe(true);
  });

  // 意圖（D2）：容器寫的物件要等容器確定停了才搬進共用庫（還在跑就搬，搬完它還能再寫），而且要在放掉 worktree 之前——
  // 放掉之後宿主就可能對這個 worktree 跑 git，那時物件必須已經在共用庫。物件庫的 env 由掛載結果給，呼叫端蓋不掉。
  test('D2：掛載給的物件庫 env 進容器；release 在容器確認停止後、放 worktree 前搬物件（clear）；搬移失敗只記錄仍放行', async () => {
    const order = [];
    const taskObjects = { repoPaths: ['/r/main'], branch: 'task/task_7' };
    const env = { GIT_OBJECT_DIRECTORY: '/r/.agent-objects/task_7', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/r/main/.git/objects' };
    const { d } = wtDeps({
      releaseBounds: SHORT,
      resolveSandboxMounts: async () => ({ mounts: [{ source: wt, readonly: false }], workdir: wt, env, taskObjects }),
      execFile: fakeDocker({ inspect: cb => { order.push('inspect'); cb(null, 'false\n', ''); } }),
      importTaskObjects: async (o) => { order.push(['import', o, await busy()]); throw new Error('壞物件'); },
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const run = await sr.prepareSandboxRun({ claudeArgs: ARGS, opts: { agentType: 'coding', taskId: 70, env: { GIT_OBJECT_DIRECTORY: '/evil' } }, profile: profileFor('coding'), projectId: 7 }, d);
      expect(run.argv).toContain(`GIT_OBJECT_DIRECTORY=${env.GIT_OBJECT_DIRECTORY}`);
      expect(run.argv).toContain(`GIT_ALTERNATE_OBJECT_DIRECTORIES=${env.GIT_ALTERNATE_OBJECT_DIRECTORIES}`);
      expect(run.argv.join(' ')).not.toContain('/evil');
      const cli = fakeCli(); run.attach(cli); cli.emit('exit', 0);
      await run.release();
      expect(order).toEqual(['inspect', ['import', { ...taskObjects, clear: true }, true]]);
      expect(await busy()).toBe(false);
      expect(errSpy.mock.calls.some(a => /任務物件搬移失敗/.test(a[0]))).toBe(true);
    } finally { errSpy.mockRestore(); }
  });

  test('D1b：容器還沒建好（docker 全回 No such container）但 CLI 還活著 → 不放；CLI 退出後才放', async () => {
    const { d } = wtDeps({ releaseBounds: { ...SHORT, cliExitMs: 5000 }, execFile: fakeDocker({ kill: noSuch, inspect: noSuch, wait: noSuch }) });
    const run = await start(d);
    const cli = fakeCli(); run.attach(cli);
    const rel = run.release();
    await tick(60);
    expect(await busy()).toBe(true);
    cli.emit('exit', 125);
    await rel;
    expect(await busy()).toBe(false);
  });

  test('inspect=true → docker wait 回來才放', async () => {
    const waits = [];
    const { d } = wtDeps({ releaseBounds: { ...SHORT, dockerMs: 5000 }, execFile: fakeDocker({ inspect: cb => cb(null, 'true\n', ''), wait: cb => waits.push(cb) }) });
    const run = await start(d);
    const cli = fakeCli(); run.attach(cli); cli.emit('exit', 137);
    const rel = run.release();
    await tick();
    expect(waits.length).toBe(1);
    expect(await busy()).toBe(true);
    waits[0](null, '137\n', '');
    await rel;
    expect(await busy()).toBe(false);
  });

  test('docker 卡住（不回呼／逾時錯誤）→ 不放、記錄容器名；背景重試等 inspect 回 false 才放', async () => {
    let stuck = true;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = wtDeps({ releaseBounds: SHORT, execFile: fakeDocker({
      kill: cb => cb(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }), '', ''),
      inspect: cb => { if (!stuck) cb(null, 'false\n', ''); },       // 卡住＝永遠不回呼
    }) });
    const run = await start(d);
    const cli = fakeCli(); run.attach(cli); cli.emit('exit', 0);
    await run.release();                              // 本身不能跟著卡死
    expect(await busy()).toBe(true);
    expect(errSpy.mock.calls.some(a => /\[SANDBOX\]/.test(a[0]) && a[0].includes(run.containerName))).toBe(true);
    stuck = false;
    await tick(150);
    expect(await busy()).toBe(false);
    errSpy.mockRestore();
  });

  test('CLI 逾時不退出 → release 送 SIGKILL，不放；之後退出由背景重試放掉', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = wtDeps({ releaseBounds: SHORT });
    const run = await start(d);
    const cli = fakeCli(); run.attach(cli);
    await run.release();
    expect(cli.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await busy()).toBe(true);
    cli.emit('exit', null, 'SIGKILL');
    await tick(150);
    expect(await busy()).toBe(false);
    errSpy.mockRestore();
  });

  test('從未 attach（準備完就被停止、沒 spawn）→ 確認容器不在就放；release 之後不得再 attach', async () => {
    const { d } = wtDeps({ releaseBounds: SHORT, execFile: fakeDocker({ inspect: noSuch }) });
    const run = await start(d);
    await run.release();
    expect(await busy()).toBe(false);
    expect(() => run.attach(fakeCli())).toThrow();
  });

  test('release 重複呼叫只放一次（不會把另一個持有者的登記也扣掉）', async () => {
    const { d } = wtDeps({ releaseBounds: SHORT });
    const a = await start(d); const b = await start(d);
    await Promise.all([a.release(), a.release()]);
    await a.release();
    expect(await busy()).toBe(true);                 // b 還掛著
    await b.release();
    expect(await busy()).toBe(false);
  });

  test('等不到 → 丟例外（訊息寫明容器仍在執行）；timeoutMs=0 是不阻塞檢查，立刻丟 WORKTREE_BUSY', async () => {
    const { d } = wtDeps({ execFile: () => {}, releaseBounds: { dockerMs: 5, cliExitMs: 5, retryDelaysMs: [] } });
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

// 意圖（租戶隔離）：家目錄是宿主目錄掛進容器、容器 --rm 之後還在，而一個專案可以綁給
// 不只一家公司。這一組驗的是「同一個專案的兩家公司拿到不同的 HOME」，以及**授權那條路
// 完全沒被牽動**——scope 字串、通行證內容、canRun 收到的參數都必須與改動前相同。
describe('家目錄分公司（不動 scope／授權）', () => {
  const { profileFor } = require('../lib/agent-profiles');
  const HOME_OF = argv => argv.find(a => typeof a === 'string' && a.startsWith('HOME='));
  const legacyHome = scope => path.join(APP, 'data', 'agent-home', scope);
  // canRun／issueRunToken 收到什麼，逐次記下來
  const spyDeps = (over = {}) => {
    const seen = { canRun: [], token: [], mkdir: [] };
    const { d } = deps({
      canRun: async (scope, userId) => { seen.canRun.push([scope, userId]); return true; },
      issueRunToken: (arg) => { seen.token.push(arg); return rt.issueRunToken(arg); },
      mkdirSync: (p, o) => { seen.mkdir.push([p, o]); },
      ...over,
    });
    return { d, seen };
  };
  const run3 = (d, userId) => sr.prepareSandboxRun(
    { claudeArgs: ARGS, opts: { agentType: 'qa', taskId: 70, userId }, profile: profileFor('qa'), projectId: 3 }, d);

  test('內部公司的執行：HOME 與改動前逐字相同（內部的續接 session 不會斷）', async () => {
    const { d, seen } = spyDeps({ resolveHomeBucket: async () => null });
    const run = await run3(d, 7);
    expect(HOME_OF(run.argv)).toBe(`HOME=${legacyHome('project-3')}`);
    expect(seen.mkdir).toEqual([[legacyHome('project-3'), { recursive: true, mode: 0o700 }]]);
    await run.release();
  });

  test('沒有發起人的系統執行（cron／夜間改善）：落內部桶子，且不必查公司', async () => {
    let asked = 0;
    const { d } = spyDeps({ resolveHomeBucket: async (uid) => { asked++; expect(uid).toBeNull(); return null; } });
    const run = await sr.prepareSandboxRun(
      { claudeArgs: ARGS, opts: { agentType: 'fix_review' }, profile: profileFor('fix_review'), projectId: null }, d);
    expect(HOME_OF(run.argv)).toBe(`HOME=${legacyHome('internal-fix')}`);
    expect(asked).toBe(1);
    await run.release();
  });

  test('同一個專案的兩家公司 → 不同 HOME，且客戶的不在內部那包底下', async () => {
    const { d: dIn } = spyDeps({ resolveHomeBucket: async () => null });
    const { d: dCo } = spyDeps({ resolveHomeBucket: async () => 'company-2' });
    const a = await run3(dIn, 7);
    const b = await run3(dCo, 31);
    const ha = HOME_OF(a.argv).slice('HOME='.length);
    const hb = HOME_OF(b.argv).slice('HOME='.length);
    expect(hb).toBe(path.join(APP, 'data', 'agent-home', 'company-2', 'project-3'));
    expect(hb).not.toBe(ha);
    expect(path.relative(ha, hb).startsWith('..')).toBe(true);
    // 掛載清單裡也只掛得到自己那一個家目錄
    expect(b.argv.join(' ')).not.toContain(`source=${ha},`);
    await a.release(); await b.release();
  });

  test('授權那條路沒被動到：scope 字串、canRun 參數、通行證內容都與專案別無關公司', async () => {
    const { d, seen } = spyDeps({ resolveHomeBucket: async () => 'company-2' });
    const run = await run3(d, 31);
    // scope 仍是 project-<id>，沒有被塞進公司
    expect(seen.canRun).toEqual([['project-3', 31]]);
    expect(seen.token[0]).toMatchObject({ scope: 'project-3', projectId: 3 });
    expect(run.argv).toContain('aidev.scope=project-3');
    const v = rt.verifyRunToken(run.childEnv.AIDEV_AI_TOKEN);
    expect(v.ok).toBe(true);
    expect(v.run).toMatchObject({ scope: 'project-3', projectId: 3 });
    expect(v.run.endpoints).toEqual(['db', 'wiki', 'tasks', 'glossary']);
    await run.release();
  });

  test('canRun 擋下時不會先建出公司目錄', async () => {
    const { d, seen } = spyDeps({ canRun: async () => false, resolveHomeBucket: async () => 'company-2' });
    await expect(run3(d, 31)).rejects.toThrow(/未獲准/);
    expect(seen.mkdir).toEqual([]);
  });
});
