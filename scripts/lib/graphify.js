// scripts/lib/graphify.js
// 補裝 pipeline 自動索引所需的 Python 相依。app/server/pipeline/graphify-runner.js 在每個 repo
// clone 完成時會用宿主 python 跑 graphify_index.py，該腳本 import graphify（pip 套件 graphifyy）＋
// networkx。一鍵安裝原本只驗 python 存在、沒裝這兩者 → 全新機 repo 一建就 ModuleNotFoundError，
// 只寫進 project_repos.graphify_status='error' 靜默失敗。此步驟在安裝期補上；import 不到就 fail loud。
const { execFileSync: realExecFileSync } = require('child_process');

const PACKAGES = ['graphifyy', 'networkx'];
const PROBE = 'import graphify, networkx';

// 與 checks.js:43 一致：Windows 慣用 python、Linux 常只有 python3，尊重 PYTHON_BIN 覆寫。
function pythonBin() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

function canImport(execFileSync, py) {
  try {
    execFileSync(py, ['-c', PROBE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureGraphify(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const py = (deps.pythonBin || pythonBin)();

  if (canImport(execFileSync, py)) return { name: 'graphify', status: 'skipped' };

  // 先照標準 pip 裝；Ubuntu 24.04+ 的 PEP 668（externally-managed）會擋，
  // 退 --user --break-system-packages 重試（平台已棄 venv、走宿主 python）。
  try {
    execFileSync(py, ['-m', 'pip', 'install', '--upgrade', ...PACKAGES], { stdio: 'inherit' });
  } catch {
    execFileSync(py, ['-m', 'pip', 'install', '--upgrade', '--user', '--break-system-packages', ...PACKAGES], { stdio: 'inherit' });
  }

  if (!canImport(execFileSync, py)) {
    throw new Error(`graphify 相依安裝後仍無法 import（${py} -c "${PROBE}" 失敗）；請確認 ${py} 的 pip 可用並手動安裝：${PACKAGES.join(' ')}`);
  }
  return { name: 'graphify', status: 'done' };
}

module.exports = { ensureGraphify, pythonBin };
