const { execFileSync: realExecFileSync, execFile: realExecFile } = require('child_process');
const realFs = require('fs');
const os = require('os');
const path = require('path');
// Docker daemon 沒起時自動啟動 Docker Desktop 的邏輯已上移到通用驅動層 docker-env，兩邊共用一份。
const { ensureDockerRunning } = require('./docker-env');

const IMAGE_NAME = 'odoo-v2-vpn-gateway:latest';
// 40 秒須大於 entrypoint 等 tun0 的 30 秒上限＋撥通後路由建立的數秒，避免把「慢但會成功」的
// 撥號誤判逾時；撥號失敗的容器會在 entrypoint 的 30 秒後退出，剛好落在此窗內被就緒檢查撈到 log。
const GATEWAY_TIMEOUT_MS = 40000;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 在容器內用 nc 對目標開一個 TCP 連線探測可達性。成功（exit 0）代表 tun0 已建立、VPN 路由
// 已能送達目標——這才是真正就緒。用非同步 execFile，撥號輪詢期間不阻塞 Node 事件迴圈。
function probeReachable(name, host, port, execFile) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', name, 'nc', '-z', '-w', '2', host, String(port)], (err) => resolve(!err));
  });
}

// 為何不沿用「轉發 port 可連上」當就緒訊號：docker 的 -p userland proxy 在容器一啟動（毫秒級）
// 就接受該 port 的 TCP 連線，即使容器內 socat 還沒 listen、tun0 還沒撥通。只看轉發 port 會誤判
// 「已就緒」→ 呼叫端過早清掉掛載進去的 .ovpn，openvpn 可能還沒開檔就撲空（"Error opening
// configuration file" → 容器立即退出）；就算僥倖沒撲空，第一個查詢也會在路由還沒建立時發出而逾時。
// 改成輪詢容器內「真的連得到目標」才算就緒，並在容器中途退出時撈 log 給出可診斷的錯誤。
async function defaultWaitReachable(name, host, port, timeoutMs, deps) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const execFile = deps.execFile || realExecFile;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isContainerRunning(name, execFileSync)) {
      let log = '';
      try { log = execFileSync('docker', ['logs', '--tail', '20', name], { encoding: 'utf8' }); } catch { /* 容器可能已被移除 */ }
      throw new Error(`VPN 撥號失敗，容器已結束（多為帳號密碼或設定檔錯誤）：\n${log}`.trim());
    }
    if (await probeReachable(name, host, port, execFile)) return;
    if (Date.now() >= deadline) {
      throw new Error(`VPN 連線逾時（${Math.round(timeoutMs / 1000)} 秒內未能透過隧道連到 ${host}:${port}），請確認 VPN 帳號密碼與設定檔是否正確`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
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
  const waitReachable = deps.waitReachable || defaultWaitReachable;

  await ensureDockerRunning(deps);

  const name = conn.vpn_container_name || containerName(conn.id);
  if (isContainerRunning(name, execFileSync)) return { forwardPort: conn.vpn_forward_port };

  // tmpFile 路徑先算好（跟 startGateway 內部算法一致），這樣就算 startGateway
  // 半路丟出例外（如 docker run 失敗），外層 finally 仍知道要清哪個檔案。
  const tmpFile = tmpFilePath(conn.id);
  const { host: targetHost, port: targetPort } = targetHostPort(conn);
  try {
    startGateway({ ...conn, vpn_container_name: name }, { execFileSync, writeFileSync, rmSync, tmpFilePath });
    // 等「隧道真的連得到目標」才算就緒——這也保證 .ovpn 撐到 openvpn 開檔之後才被清掉。
    await waitReachable(name, targetHost, targetPort, GATEWAY_TIMEOUT_MS, { execFileSync, execFile: deps.execFile });
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
