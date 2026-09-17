// app/server/lib/agent-sandbox-selftest.js
/**
 * agent-sandbox-selftest.js — 子專案 0 規格 §8.3 攻擊實測，在平台行程內照正式路徑開真容器。
 * 兩輪：project（coding profile＋測試任務 worktree）與 audit（workflow_health profile＋乾淨 worktree）。
 * 判讀規則：探針「沒回報」的項目一律算失敗；通行證在 release 之後才驗 401；閘道必須記到 example.com 被擋。
 * X20／R6（09-16 M6 實測）：`--internal` 網路唯一真正碰得到的宿主位址是 agent 網路自己的橋接 gateway IP，
 * 不是 127.0.0.1／host.docker.internal／docker0／LAN IP；8772/21000/5416 必須擋，8771／22 是使用者已接受
 * 的暴露（09-16 裁決：維持 --internal，靠登入鎖定緩解）只記錄不判失敗，另外用連得到閘道 proxy 的正控制組
 * 排除「/dev/tcp 判讀法本身壞了」這種假 PASS。
 * 會花極少量 token（每輪一次 claude -p＋一次 --resume）。
 */
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, spawn: realSpawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const PORTS = [8771, 8772, 22, 21000, 5416];
const AGENT_GW_BLOCKED_PORTS = [8772, 21000, 5416];
const AGENT_GW_ACCEPTED_PORTS = [8771, 22];
const COMMON = ['env_no_APP_SECRET', 'env_no_JWT_SECRET', 'env_no_DATABASE_URL', 'read_platform_config', 'read_ai_socket_dir',
  'read_other_project', 'tcp_blocked_direct_internet', 'agent_net_gateway_known', 'tcp_positive_control',
  ...AGENT_GW_BLOCKED_PORTS.map(p => `tcp_blocked_agentgw_${p}`), ...AGENT_GW_ACCEPTED_PORTS.map(p => `tcp_accepted_agentgw_${p}`),
  'proxy_anthropic', 'proxy_example_blocked', 'claude_run', 'claude_resume'];
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

function defaultAgentNetworkGateway(network) {
  return new Promise(resolve => execFile('docker', ['network', 'inspect', network, '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
    (err, out) => resolve(err ? null : String(out).trim())));
}

async function runOnce(mode, ctx, d) {
  const { profileFor } = require('./agent-profiles');
  const profile = profileFor(mode === 'project' ? 'coding' : 'workflow_health');
  const opts = mode === 'project'
    ? { agentType: 'coding', taskId: ctx.taskDbId, cwd: ctx.worktree, projectId: ctx.projectId, timeoutMs: 300000 }
    : { agentType: 'workflow_health', timeoutMs: 300000 };
  const claudeArgs = ['-p', '--strict-mcp-config', '--mcp-config', path.join(APP_DIR, 'app', 'server', 'pipeline', 'mcp', 'none.json')];
  const run = await d.prepareSandboxRun({ claudeArgs, opts, profile, projectId: mode === 'project' ? ctx.projectId : null });
  let stdout = '';
  try {
    const infra = await d.ensureAgentInfra();
    const i = run.argv.lastIndexOf(infra.image);
    if (i < 0) throw new Error(`docker run 參數裡找不到映像檔 ${infra.image}，探針無法掛入（argv：${run.argv.join(' ')}）`);
    const gw = await d.agentNetworkGateway(infra.network);
    const argv = [
      ...run.argv.slice(0, i),
      '--mount', `type=bind,source=${d.probePath},target=${d.probePath},readonly`,
      infra.image, 'bash', d.probePath, mode, APP_DIR, ctx.otherRoot, mode === 'project' ? ctx.ownGitDir : '-',
      ctx.ownSlug, ctx.otherSlug, ctx.hosts.join(' '), gw || '-',
    ];
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
    agentNetworkGateway: defaultAgentNetworkGateway,
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
