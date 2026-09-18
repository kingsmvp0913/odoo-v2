// scripts/lib/docker.js
const { execFileSync: realExecFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// tag 規則跟執行期同一份：兩邊各寫一次，升版時對不上就是「映像不存在」，而那只會在下一次 AI 呼叫才爆
const { agentImageTag } = require('../../app/server/lib/agent-infra');

const IMAGE_NAME = 'odoo-v2-vpn-gateway:latest';
const AGENT_DIR = path.resolve(__dirname, '..', '..', 'docker', 'agent');
const CONTEXT7_PKG = path.resolve(__dirname, '..', '..', 'app', 'node_modules', '@upstash', 'context7-mcp', 'package.json');

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

// AI 沙盒映像。tag 綁 claude 版本，而 claude 是 npm i -g 裝 latest（scripts/lib/claude-env.js）——
// 升一次版舊 tag 就再也不會被用到，執行期只丟「映像不存在」然後每一次 AI 呼叫都失敗。
// 所以安裝與每次重跑 setup 都要來這裡確認一次；已存在就跳過，不存在才建（第一次要抓數百 MB）。
// 得排在 npm install 與 claude 安裝之後：兩個 build-arg 分別來自 node_modules 與 claude --version。
function ensureAgentImage(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const dockerfileDir = deps.dockerfileDir || AGENT_DIR;
  const versionOut = execFileSync('claude', ['--version'], { encoding: 'utf8' });
  const claudeVersion = (String(versionOut).match(/\d+\.\d+\.\d+/) || [])[0];
  if (!claudeVersion) throw new Error(`讀不到 claude 版本：${versionOut}`);
  const image = agentImageTag(claudeVersion);
  if (execFileSync('docker', ['images', '-q', image], { encoding: 'utf8' }).trim()) return { built: false, image };
  const context7Version = JSON.parse(readFileSync(deps.context7Pkg || CONTEXT7_PKG, 'utf8')).version;
  execFileSync('docker', [
    'build', '-f', path.join(dockerfileDir, 'Dockerfile'),
    '--build-arg', `CLAUDE_CODE_VERSION=${claudeVersion}`,
    '--build-arg', `CONTEXT7_MCP_VERSION=${context7Version}`,
    '-t', image, dockerfileDir,
  ], { stdio: 'inherit' });
  return { built: true, image };
}

module.exports = { verifyDocker, ensureGatewayImage, ensureAgentImage };
