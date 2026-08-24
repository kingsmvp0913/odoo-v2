const { execFileSync: realExecFileSync } = require('child_process');

function ensureCodexCli(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  try {
    execFileSync('codex', ['--version'], { stdio: 'pipe' });
    return { name: 'cli', status: 'skipped' };
  } catch {
    execFileSync('npm', ['i', '-g', '@openai/codex'], { stdio: 'inherit' });
    return { name: 'cli', status: 'done' };
  }
}

module.exports = { ensureCodexCli };
