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
