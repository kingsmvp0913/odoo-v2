// claudeStatus 是歷史欄名，實際語意是所有 CLI 共用的執行狀態，故不改名。
const { runClaude, abortError, stopReason } = require('./claude-runner');
const { runCodex } = require('./codex-runner');

// ⚠ 原本不是 async；為了在這裡 await 租戶檢查改成 async，已 grep 確認全部呼叫端都有 await。
async function runAgent(prompt, opts = {}) {
  const provider = opts.provider || 'claude';
  if (provider === 'claude') return runClaude(prompt, opts);
  if (provider === 'codex') {
    // Codex 自帶的沙箱在平台容器裡起不來，所以它沒有容器保護——客戶觸發的 AI 走 Codex
    // 等於整個隔離被繞過（規格 §7、子專案 0 Q3 裁決）。只放行內部人員。
    if (!await require('../lib/tenant-access').isUserCompanyInternal(opts.userId ?? null)) {
      throw new Error('客戶公司的 AI 只能用 Claude');
    }
    return runCodex(prompt, opts);
  }
  const err = new Error(`不支援的 provider：${provider}`);
  err.status = 400;
  throw err;
}

module.exports = { runAgent, abortError, stopReason };
