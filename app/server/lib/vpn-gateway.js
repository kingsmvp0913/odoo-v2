const { execFileSync: realExecFileSync, spawn: realSpawn } = require('child_process');
const realFs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const IMAGE_NAME = 'odoo-v2-vpn-gateway:latest';
const GATEWAY_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 1000;

const DOCKER_START_TIMEOUT_MS = 90000;
const DOCKER_POLL_INTERVAL_MS = 3000;
const DOCKER_DESKTOP_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';

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

function isDockerDaemonUp(execFileSync) {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Docker Desktop（Windows）裝好但引擎沒啟動時，背景幫使用者開起來再輪詢等待，
// 省得每次查詢都要先手動開 Docker Desktop。非 Windows（如未來的共用 Linux 主機，
// Docker 通常已是常駐服務）直接回錯，交由環境本身管理 daemon 生命週期。
async function ensureDockerRunning(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const spawn = deps.spawn || realSpawn;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const platform = deps.platform || process.platform;

  if (isDockerDaemonUp(execFileSync)) return;

  if (platform !== 'win32') {
    throw new Error('Docker 引擎未啟動，請手動啟動 Docker 服務');
  }

  try {
    const child = spawn(DOCKER_DESKTOP_EXE, [], { detached: true, stdio: 'ignore' });
    // spawn 的 ENOENT（Docker Desktop 未裝／路徑不符）是非同步 'error' 事件，try/catch 攔不到——
    // 無 handler 會變 uncaughtException 拖垮整個 server。吞掉即可，下方輪詢逾時會回報清楚錯誤。
    child.once('error', () => {});
    child.unref();
  } catch {
    // 啟動失敗就繼續輪詢，逾時後統一回報清楚錯誤
  }

  const maxAttempts = Math.ceil(DOCKER_START_TIMEOUT_MS / DOCKER_POLL_INTERVAL_MS);
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(DOCKER_POLL_INTERVAL_MS);
    if (isDockerDaemonUp(execFileSync)) return;
  }
  throw new Error('Docker 引擎啟動逾時，請手動確認 Docker Desktop');
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

// image 不存在時（機器從沒 build 過，或 Dockerfile 有更新）現場 build，
// 不強求使用者記得先跑過一鍵安裝的 Docker 準備步驟。
function ensureImageBuilt(execFileSync) {
  const out = execFileSync('docker', ['images', '-q', IMAGE_NAME], { encoding: 'utf8' });
  if (out.trim()) return;
  const dockerfileDir = path.resolve(__dirname, 'vpn-gateway');
  execFileSync('docker', ['build', '-t', IMAGE_NAME, dockerfileDir], { stdio: 'inherit' });
}

// isContainerRunning 只代表「目前沒在跑」，不代表「不存在」——容器可能是
// 建立失敗、或曾經跑過又停了的殘留物，docker run 不能用同一個名字再建一次，
// 所以重建前先清掉同名殘留容器。若殘留容器裡的 openvpn 還活著，先 docker stop
// （SIGTERM，給 openvpn 機會正常關閉並通知 VPN 伺服器斷線），而不是直接 rm -f
// （SIGKILL）：粗暴砍掉會讓伺服器端殘留一個沒有正常結束的 session，可能導致
// 下一次重連被誤判為衝突而拒絕。stop 之後再 rm -f 確保容器名稱一定被釋放。
function removeStaleContainer(name, execFileSync) {
  try { execFileSync('docker', ['stop', '-t', '5', name], { stdio: 'ignore' }); } catch { /* 可能沒在跑或不存在 */ }
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* 容器可能本來就不存在 */ }
}

// 回傳寫好的暫存 .ovpn 路徑，故意不在這裡刪除：`docker run -d` 幾乎立刻回傳，
// 但容器內的 openvpn 需要一點時間才會真正打開這個掛載進去的檔案；太早刪會讓
// 容器讀到「檔案消失」。清理時機交給呼叫端在確認容器真的起來之後才做。
function startGateway(conn, deps) {
  const { execFileSync, writeFileSync, rmSync, tmpFilePath } = deps;
  ensureImageBuilt(execFileSync);
  removeStaleContainer(conn.vpn_container_name, execFileSync);
  const { host: targetHost, port: targetPort } = targetHostPort(conn);
  const tmpFile = tmpFilePath(conn.id);
  // 前一次若因故（如舊版本的清檔案時機問題）留下同路徑的殘留物，Docker 在掛載
  // 一個「主機端不存在」的來源路徑時可能自動建成空目錄；不管殘留的是檔案還是
  // 目錄，寫入前一律先強制清掉，確保這裡一定是全新的一般檔案。
  rmSync(tmpFile, { recursive: true, force: true });
  writeFileSync(tmpFile, conn.vpn_config, { mode: 0o600 });
  execFileSync('docker', [
    'run', '-d', '--name', conn.vpn_container_name, '--cap-add=NET_ADMIN',
    // NET_ADMIN 只給「設定網路」的權限，還要把 /dev/net/tun 裝置節點掛進容器，
    // openvpn 才能開 tun0；缺這行會在撥通後倒在 "Cannot open TUN/TAP dev"，tun0 永不出現。
    '--device', '/dev/net/tun',
    '-p', `127.0.0.1:${conn.vpn_forward_port}:9999`,
    '-v', `${tmpFile}:/config/client.ovpn:ro`,
    '-e', `VPN_USER=${conn.vpn_username || ''}`,
    '-e', `VPN_PASS=${conn.vpn_password || ''}`,
    '-e', `TARGET_HOST=${targetHost}`,
    '-e', `TARGET_PORT=${targetPort}`,
    IMAGE_NAME,
  ], { stdio: 'pipe' });
  return tmpFile;
}

async function ensureGatewayRunning(conn, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const writeFileSync = deps.writeFileSync || realFs.writeFileSync;
  const rmSync = deps.rmSync || realFs.rmSync;
  const tmpFilePath = deps.tmpFilePath || ((id) => path.join(os.tmpdir(), `vpn-${id}.ovpn`));
  const waitForPort = deps.waitForPort || defaultWaitForPort;

  await ensureDockerRunning(deps);

  const name = conn.vpn_container_name || containerName(conn.id);
  if (isContainerRunning(name, execFileSync)) return { forwardPort: conn.vpn_forward_port };

  // tmpFile 路徑先算好（跟 startGateway 內部算法一致），這樣就算 startGateway
  // 半路丟出例外（如 docker run 失敗），外層 finally 仍知道要清哪個檔案。
  const tmpFile = tmpFilePath(conn.id);
  try {
    startGateway({ ...conn, vpn_container_name: name }, { execFileSync, writeFileSync, rmSync, tmpFilePath });
    await waitForPort(conn.vpn_forward_port, GATEWAY_TIMEOUT_MS);
  } finally {
    rmSync(tmpFile, { recursive: true, force: true });
  }
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

module.exports = { allocateForwardPort, containerName, ensureGatewayRunning, ensureDockerRunning, stopGateway, removeGateway };
