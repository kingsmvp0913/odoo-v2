// scripts/lib/docker.js
const { execFileSync: realExecFileSync } = require('child_process');
const path = require('path');

const IMAGE_NAME = 'odoo-v2-vpn-gateway:latest';

function verifyDocker(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  try {
    execFileSync('docker', ['info'], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    // 區分三種失敗，各給對的提示（別把「沒權限」誤報成「沒裝」）：
    if (err && err.code === 'ENOENT') {
      return { ok: false, hint: '請安裝並啟動 Docker（Desktop 或 Engine）：https://www.docker.com/products/docker-desktop/' };
    }
    const stderr = ((err && err.stderr) || '').toString();
    if (/permission denied/i.test(stderr)) {
      return { ok: false, hint: 'Docker 已安裝但當前使用者無權存取 daemon：請執行 `sudo usermod -aG docker $USER` 後登出再登入（docker 群組需重登才生效）。' };
    }
    return { ok: false, hint: 'Docker 已安裝但 daemon 連不上：請確認 Docker 服務已啟動（Docker Desktop 或 `sudo systemctl start docker`）。' };
  }
}

function ensureGatewayImage(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const dockerfileDir = deps.dockerfileDir || path.resolve(__dirname, '..', '..', 'app', 'server', 'lib', 'vpn-gateway');
  const out = execFileSync('docker', ['images', '-q', IMAGE_NAME], { encoding: 'utf8' });
  if (out.trim()) return { built: false };
  execFileSync('docker', ['build', '-t', IMAGE_NAME, dockerfileDir], { stdio: 'inherit' });
  return { built: true };
}

module.exports = { verifyDocker, ensureGatewayImage };
