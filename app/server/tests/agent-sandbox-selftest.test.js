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
      agentNetworkGateway: async () => '10.0.28.1',
      spawn: (cmd, argv) => { order.push('spawn'); return fakeChild([...allPass(argv.includes('audit') ? 'audit' : 'project'), 'TOKEN tok']); },
      checkTokenRevoked: async () => { order.push('check401'); return 401; },
      gatewayLogsSince: async () => '{"type":"deny","dest":"example.com:443"}',
      probePath: '/app/scripts/agent-sandbox-probe.sh',
      ...over,
    },
  };
}

test('project 探針必須回報 refs 鎖三項（漏報＝FAIL）', () => {
  expect(st.EXPECTED_CHECKS.project).toEqual(expect.arrayContaining(['write_git_release_refs', 'write_git_packed_refs', 'write_git_task_refs']));
});

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

test('探針命令替換 claude，並把探針腳本唯讀掛進去；agent 網路 gateway IP 帶成探針第 8 個位置參數', async () => {
  const seen = [];
  const { d } = deps({ spawn: (cmd, argv) => { seen.push(argv); return fakeChild(['TOKEN t']); } });
  await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  const argv = seen[0];
  const i = argv.indexOf('aidev-agent:x');
  expect(argv.slice(i + 1, i + 4)).toEqual(['bash', '/app/scripts/agent-sandbox-probe.sh', 'project']);
  // 探針的 $1..$8：mode, appDir, otherRoot, ownGitDir, ownSlug, otherSlug, hosts, agentNetGateway
  expect(argv[i + 10]).toBe('10.0.28.1');
  expect(argv).toContain('type=bind,source=/app/scripts/agent-sandbox-probe.sh,target=/app/scripts/agent-sandbox-probe.sh,readonly');
  expect(argv).not.toContain('claude');
});

test('同一個專案當「別的專案」→ 丟例外（驗不出跨專案）', async () => {
  await expect(st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 7 }, deps().d)).rejects.toThrow();
});

// X20／R6：host-port 檢查要打真正碰得到的位址（agent 網路自己的橋接 gateway），不是 127.0.0.1 那幾個構造上就不可達的假目標。
test('agent 網路 gateway 查不到 → agent_net_gateway_known FAIL，整體 ok=false，探針第 8 個位置參數是 -', async () => {
  const seen = [];
  const { d } = deps({
    agentNetworkGateway: async () => null,
    spawn: (cmd, argv) => { seen.push(argv); return fakeChild(['CHECK agent_net_gateway_known FAIL', 'TOKEN tok']); },
  });
  const r = await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  expect(r.ok).toBe(false);
  expect(r.checks).toContainEqual(expect.objectContaining({ name: 'agent_net_gateway_known', pass: false }));
  const argv = seen[0];
  const i = argv.indexOf('aidev-agent:x');
  expect(argv[i + 10]).toBe('-');
});

// IPAM 開了 IPv6 時 `docker network inspect` 的 gateway 清單會串成一行，注入的 dep 若直接把它原樣傳回
// （非本檔預設實作的問題，是「不論誰提供這個值」都要擋），/dev/tcp 對它是「解析不出主機名」而非「連不到」，
// tcp_blocked_agentgw_* 會全部假 PASS。runSelftest 必須自己驗證格式，不能只信任 dep 回傳值。
test('agentNetworkGateway 回傳非純 IPv4（IPv6 串接的垃圾值）→ 視為未知，探針第 8 個位置參數是 -', async () => {
  const seen = [];
  const { d } = deps({
    agentNetworkGateway: async () => '10.0.28.1fd00::1',
    spawn: (cmd, argv) => { seen.push(argv); return fakeChild(['CHECK agent_net_gateway_known FAIL', 'TOKEN tok']); },
  });
  await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  const argv = seen[0];
  const i = argv.indexOf('aidev-agent:x');
  expect(argv[i + 10]).toBe('-');
});

test('tcp_accepted_agentgw（8771／22，使用者已接受的暴露）回報 PASS 不影響整體 ok', async () => {
  const { d } = deps();
  const r = await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  expect(r.ok).toBe(true);
  expect(r.checks).toContainEqual(expect.objectContaining({ name: 'tcp_accepted_agentgw_8771', pass: true }));
  expect(r.checks).toContainEqual(expect.objectContaining({ name: 'tcp_accepted_agentgw_22', pass: true }));
});

test('docker run 參數裡找不到映像檔 → release 仍會呼叫、拋出明確錯誤', async () => {
  const released = [];
  const { d } = deps({
    prepareSandboxRun: async ({ profile }) => ({
      argv: ['run', '-i', '--rm', 'claude', '-p'], childEnv: {}, containerName: `c-${profile.scope}`, runId: 'r',
      kill: () => {}, release: async () => { released.push(true); },
    }),
  });
  await expect(st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d)).rejects.toThrow(/映像檔/);
  expect(released.length).toBeGreaterThan(0);
});

test('spawn 觸發 error 事件 → release 仍會呼叫、runSelftest 拋出', async () => {
  const { d, order } = deps({
    spawn: () => {
      order.push('spawn');
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin = { end: jest.fn(), on: jest.fn() };
      setImmediate(() => c.emit('error', new Error('spawn ENOENT')));
      return c;
    },
  });
  await expect(st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d)).rejects.toThrow('spawn ENOENT');
  expect(order).toContain('release');
});

test('探針輸出沒有 TOKEN 行 → token_revoked_401 FAIL，且不呼叫 checkTokenRevoked', async () => {
  const calls = [];
  const { d } = deps({ spawn: () => fakeChild(['CHECK claude_run PASS']), checkTokenRevoked: async t => { calls.push(t); return 401; } });
  const r = await st.runSelftest({ projectId: 7, taskDbId: 70, otherProjectId: 8 }, d);
  expect(calls).toEqual([]);
  expect(r.checks).toContainEqual(expect.objectContaining({ name: 'token_revoked_401', pass: false }));
});
