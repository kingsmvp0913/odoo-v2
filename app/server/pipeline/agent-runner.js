// claudeStatus 是歷史欄名，實際語意是所有 CLI 共用的執行狀態，故不改名。
const { runClaude, abortError, stopReason } = require('./claude-runner');
const { runCodex } = require('./codex-runner');

function runAgent(prompt, opts = {}) {
  const provider = opts.provider || 'claude';
  if (provider === 'claude') return runClaude(prompt, opts);
  if (provider === 'codex') return runCodex(prompt, opts);
  const err = new Error(`不支援的 provider：${provider}`);
  err.status = 400;
  throw err;
}

module.exports = { runAgent, abortError, stopReason };
