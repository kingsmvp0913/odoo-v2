// scripts/lib/checks.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function commandExists(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 與 app/server/pipeline/env-agent.js 的 findChrome 邏輯相同，但獨立一份：
// scripts/ 是安裝期工具，不依賴 app/server 內部模組（避免耦合到執行期程式碼路徑）。
function findChrome() {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LocalAppData || process.env.LOCALAPPDATA || '';
    const bins = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      lad ? path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    ].filter(Boolean);
    return bins.find(b => fs.existsSync(b)) || null;
  }
  for (const b of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(b)) return b;
  }
  return null;
}

function verifyRuntimeDeps(deps = {}) {
  const commandExistsFn = deps.commandExists || commandExists;
  const findChromeFn = deps.findChrome || findChrome;
  const missing = [];

  if (!commandExistsFn('git')) {
    missing.push({ name: 'git', hint: '請安裝 Git：https://git-scm.com/downloads' });
  }
  const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  if (!commandExistsFn(pythonBin)) {
    missing.push({ name: 'python', hint: '請安裝 Python 3：https://www.python.org/downloads/（或設定 PYTHON_BIN 指向既有安裝）' });
  }
  if (!commandExistsFn('uvx')) {
    missing.push({ name: 'uv', hint: '請安裝 uv：https://astral.sh/uv/install' });
  }
  if (!findChromeFn()) {
    missing.push({ name: 'chrome', hint: '請安裝 Google Chrome：https://www.google.com/chrome/（tour E2E 需要）' });
  }

  return { ok: missing.length === 0, missing };
}

module.exports = { verifyRuntimeDeps, findChrome, commandExists };
