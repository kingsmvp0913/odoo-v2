// scripts/lib/docker.js
const { execFileSync: realExecFileSync } = require('child_process');
const path = require('path');

const IMAGE_NAME = 'odoo-v2-vpn-gateway:latest';

function verifyDocker(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return { ok: true };
  } catch {
    return { ok: false, hint: '請安裝並啟動 Docker（Desktop 或 Engine）：https://www.docker.com/products/docker-desktop/' };
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
