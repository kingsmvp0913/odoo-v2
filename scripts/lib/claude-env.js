const { execFileSync: realExecFileSync, spawnSync: realSpawnSync } = require('child_process');

const MARKETPLACE = 'claude-plugins-official';
const MARKETPLACE_SOURCE = 'anthropics/claude-plugins-official';
const REQUIRED_PLUGINS = ['superpowers', 'hookify', 'code-review', 'context7', 'security-guidance'];

function checkCli(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' });
    return { name: 'cli', status: 'skipped' };
  } catch {
    execFileSync('npm', ['i', '-g', '@anthropic-ai/claude-code'], { stdio: 'inherit' });
    return { name: 'cli', status: 'done' };
  }
}

// claude 目前沒有非互動式的「檢查是否已登入」旗標；用需要有效 session 才會成功的
// `claude mcp list` 當探針。未登入時直接跑 `claude`（無參數）觸發內建登入流程並等使用者完成。
function ensureLogin(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const spawnSync = deps.spawnSync || realSpawnSync;
  try {
    execFileSync('claude', ['mcp', 'list'], { stdio: 'pipe' });
    return { name: 'login', status: 'skipped' };
  } catch {
    console.log('偵測到尚未登入 Claude 訂閱帳號，即將開啟互動登入畫面，完成後會自動繼續...');
    spawnSync('claude', [], { stdio: 'inherit' });
    try {
      execFileSync('claude', ['mcp', 'list'], { stdio: 'pipe' });
      return { name: 'login', status: 'done' };
    } catch {
      throw new Error('claude 登入未完成，請重新執行 node scripts/setup.js');
    }
  }
}

function ensureMcpServer(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const list = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
  if (list.includes('serena')) return { name: 'mcp-serena', status: 'skipped' };
  execFileSync('claude', [
    'mcp', 'add', '--scope', 'user', 'serena', '--',
    'uvx', '--from', 'git+https://github.com/oraios/serena', 'serena',
    'start-mcp-server', '--context', 'claude-code', '--project-from-cwd',
  ], { stdio: 'inherit' });
  return { name: 'mcp-serena', status: 'done' };
}

function ensurePlugins(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const installed = execFileSync('claude', ['plugin', 'list'], { encoding: 'utf8' });

  if (!installed.split('\n').includes(MARKETPLACE)) {
    execFileSync('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], { stdio: 'inherit' });
  }

  return REQUIRED_PLUGINS.map((name) => {
    const id = `${name}@${MARKETPLACE}`;
    if (installed.includes(id)) return { name: id, status: 'skipped' };
    execFileSync('claude', ['plugin', 'install', id], { stdio: 'inherit' });
    return { name: id, status: 'done' };
  });
}

async function ensureClaudeEnv(deps = {}) {
  const steps = [
    checkCli(deps),
    ensureLogin(deps),
    ensureMcpServer(deps),
    ...ensurePlugins(deps),
  ];
  return { steps };
}

module.exports = { checkCli, ensureLogin, ensureMcpServer, ensurePlugins, ensureClaudeEnv };
