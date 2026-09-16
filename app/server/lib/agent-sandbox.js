// app/server/lib/agent-sandbox.js
/**
 * agent-sandbox.js — 每次 AI 執行的 docker run 參數（子專案 0 §4.2），純函式。
 *
 * env 走白名單：沒列的 key 一律丟例外；三把總鑰匙另外點名擋。
 * 祕密值只放 childEnv、argv 只寫 `-e KEY`：argv 在 /proc/<pid>/cmdline 同 uid 看得到。
 * 掛載一律 --mount：-v 在來源不存在時會替你建一個 root 擁有的空目錄，錯誤被藏起來。
 */
const path = require('path');

const FORBIDDEN_ENV = ['APP_SECRET', 'JWT_SECRET', 'DATABASE_URL'];
const SECRET_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'AIDEV_AI_TOKEN', 'E2E_PASSWORD'];
const ENV_WHITELIST = [
  ...SECRET_ENV_KEYS,
  'AIDEV_AI_BASE', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
  'CLAUDE_CODE_PROMPT_CACHE_TTL', 'SECURITY_GUIDANCE_DISABLE', 'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
];
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function assertAbs(p, what) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || /[,\n]/.test(p)) {
    throw new Error(`${what} 必須是不含逗號的絕對路徑：${p}`);
  }
}

function gitDirMounts(repoPath, mode) {
  const gitDir = path.join(repoPath, '.git');
  if (mode !== 'rw') return [{ source: gitDir, readonly: true }];
  return [
    { source: gitDir, readonly: false },
    { source: path.join(gitDir, 'config'), readonly: true },
    { source: path.join(gitDir, 'hooks'), readonly: true },
  ];
}

function buildAgentRunArgs(run) {
  const { instanceId, runId, scope, image, network, user, mounts = [], workdir, home, env = {}, limits = {}, command } = run;
  if (!instanceId || !NAME_RE.test(instanceId)) throw new Error(`實例 id 不合法：${instanceId}`);
  if (!runId || !/^[a-f0-9]+$/.test(runId)) throw new Error(`runId 不合法：${runId}`);
  if (!image || !network || !user || !scope) throw new Error('image／network／user／scope 都必須提供');
  if (!Array.isArray(command) || !command.length) throw new Error('command 必須是非空陣列');
  if (limits.memory == null || limits.cpus == null || limits.pids == null) {
    throw new Error('容器資源上限未設定（memory／cpus／pids 三個都要設，見 PUT /api/admin/agent-sandbox）');
  }
  assertAbs(workdir, 'workdir');
  assertAbs(home, 'home');

  const containerName = `${instanceId}-run-${runId}`;
  const argv = [
    'run', '-i', '--rm',
    '--name', containerName,
    '--label', 'aidev.run=1', '--label', `aidev.instance=${instanceId}`, '--label', `aidev.scope=${scope}`,
    '--network', network,
    '--user', user,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp',
    '--memory', String(limits.memory), '--memory-swap', String(limits.memory),
    '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
  ];

  const all = [{ source: home, readonly: false }, ...mounts];
  const normalized = all.map(m => {
    assertAbs(m.source, '掛載來源');
    const target = m.target || m.source;
    assertAbs(target, '掛載目標');
    return { source: m.source, target, readonly: !!m.readonly };
  });
  // 父目錄先掛、子路徑後掛：唯讀覆蓋層才不會被父層蓋掉
  normalized.sort((a, b) => a.target.split('/').length - b.target.split('/').length);
  for (const m of normalized) {
    argv.push('--mount', `type=bind,source=${m.source},target=${m.target}${m.readonly ? ',readonly' : ''}`);
  }

  const childEnv = { PATH: process.env.PATH };
  argv.push('-e', `HOME=${home}`, '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8');
  for (const [k, v] of Object.entries(env)) {
    if (FORBIDDEN_ENV.includes(k)) throw new Error(`禁止把 ${k} 放進 AI 容器`);
    if (!ENV_WHITELIST.includes(k)) throw new Error(`env key 不在容器白名單：${k}（見 lib/agent-sandbox.js ENV_WHITELIST）`);
    if (v == null) continue;
    if (SECRET_ENV_KEYS.includes(k)) { argv.push('-e', k); childEnv[k] = String(v); }
    else argv.push('-e', `${k}=${v}`);
  }

  argv.push('--workdir', workdir, image, ...command);
  return { argv, childEnv, containerName };
}

module.exports = { ENV_WHITELIST, SECRET_ENV_KEYS, FORBIDDEN_ENV, buildAgentRunArgs, gitDirMounts };
