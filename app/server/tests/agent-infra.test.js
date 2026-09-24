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

test('映像檔不存在 → 丟例外請管理員重啟（start.sh 會補建），不建網路也不起閘道', async () => {
  const d = fakeDocker({ image: false });
  await expect(infra.ensureAgentInfra(deps(d))).rejects.toThrow(/claude 版本已更新（2\.1\.266）[\s\S]*重啟平台/);
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
