const { execFileSync: realExecFileSync } = require('child_process');
const realFs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const IMAGE_NAME = 'odoo-v2-vpn-gateway:latest';
const GATEWAY_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 1000;

const PORT_RANGE_START = 11000;
const PORT_RANGE_END = 11999;

function allocateForwardPort(usedPorts = []) {
  const used = new Set(usedPorts);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('沒有可用的 VPN 轉發 port（11000-11999 已滿）');
}

function containerName(connId) {
  return `vpn-conn-${connId}`;
}

function targetHostPort(conn) {
  if (conn.connect_mode === 'direct') return { host: conn.db_host, port: conn.db_port || 5432 };
  return { host: conn.ssh_host, port: conn.ssh_port || 22 };
}

function isContainerRunning(name, execFileSync) {
  try {
    const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8' });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

function defaultWaitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.end(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`VPN 連線逾時（${Math.round(timeoutMs / 1000)} 秒內轉發 port 未就緒），請確認 VPN 帳號密碼與設定檔是否正確`));
        } else {
          setTimeout(attempt, POLL_INTERVAL_MS);
        }
      });
    })();
  });
}

function startGateway(conn, deps) {
  const { execFileSync, writeFileSync, rmSync, tmpFilePath } = deps;
  const { host: targetHost, port: targetPort } = targetHostPort(conn);
  const tmpFile = tmpFilePath(conn.id);
  writeFileSync(tmpFile, conn.vpn_config, { mode: 0o600 });
  try {
    execFileSync('docker', [
      'run', '-d', '--name', conn.vpn_container_name, '--cap-add=NET_ADMIN',
      '-p', `127.0.0.1:${conn.vpn_forward_port}:9999`,
      '-v', `${tmpFile}:/config/client.ovpn:ro`,
      '-e', `VPN_USER=${conn.vpn_username || ''}`,
      '-e', `VPN_PASS=${conn.vpn_password || ''}`,
      '-e', `TARGET_HOST=${targetHost}`,
      '-e', `TARGET_PORT=${targetPort}`,
      IMAGE_NAME,
    ], { stdio: 'pipe' });
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

async function ensureGatewayRunning(conn, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const writeFileSync = deps.writeFileSync || realFs.writeFileSync;
  const rmSync = deps.rmSync || realFs.rmSync;
  const tmpFilePath = deps.tmpFilePath || ((id) => path.join(os.tmpdir(), `vpn-${id}.ovpn`));
  const waitForPort = deps.waitForPort || defaultWaitForPort;

  const name = conn.vpn_container_name || containerName(conn.id);
  if (isContainerRunning(name, execFileSync)) return { forwardPort: conn.vpn_forward_port };

  startGateway({ ...conn, vpn_container_name: name }, { execFileSync, writeFileSync, rmSync, tmpFilePath });
  await waitForPort(conn.vpn_forward_port, GATEWAY_TIMEOUT_MS);
  return { forwardPort: conn.vpn_forward_port };
}

function stopGateway(conn, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const name = conn.vpn_container_name || containerName(conn.id);
  try { execFileSync('docker', ['stop', name], { stdio: 'ignore' }); } catch { /* 容器可能早已不存在 */ }
}

function removeGateway(conn, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const name = conn.vpn_container_name || containerName(conn.id);
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* 容器可能早已不存在 */ }
}

module.exports = { allocateForwardPort, containerName, ensureGatewayRunning, stopGateway, removeGateway };
