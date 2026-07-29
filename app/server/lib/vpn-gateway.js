const { execFileSync: realExecFileSync, execFile: realExecFile } = require('child_process');
const realFs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// Docker daemon 沒起時自動啟動 Docker Desktop 的邏輯已上移到通用驅動層 docker-env，兩邊共用一份。
const { ensureDockerRunning } = require('./docker-env');

const IMAGE_BASE = 'odoo-v2-vpn-gateway';
const VPN_GATEWAY_DIR = path.resolve(__dirname, 'vpn-gateway');
// 40 秒須大於 entrypoint 等 tun0 的 30 秒上限＋撥通後路由建立的數秒，避免把「慢但會成功」的
// 撥號誤判逾時；撥號失敗的容器會在 entrypoint 的 30 秒後退出，剛好落在此窗內被就緒檢查撈到 log。
const GATEWAY_TIMEOUT_MS = 40000;
const POLL_INTERVAL_MS = 1000;

// 22000-22999：使用者要求便於在機器上控管，且避開測試區的 21000-21012。
const PORT_RANGE_START = 22000;
const PORT_RANGE_END = 22999;

// 轉發埠以「專案 × 目標(host:port)」為單位：同專案已有連線指向同一台機器就沿用它的埠。
// 這樣新增「指向既有目標」的連線不必重建容器（docker 的 -p 在建立時就固定，重建＝斷線重撥）。
function allocateForwardPort(usedPorts = [], projectTargets = [], target = null) {
  if (target) {
    const hit = projectTargets.find(
      t => t.host === target.host && Number(t.port) === Number(target.port)
    );
    if (hit) return hit.forwardPort;
  }
  const used = new Set(usedPorts);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('沒有可用的 VPN 轉發 port（22000-22999 已滿）');
}

function projectContainerName(projectId) {
  return `vpn-proj-${projectId}`;
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

// 目標指紋：依 forwardPort 排序後 join，同時當 TARGETS 環境變數與容器 label。
// 拿它比對「跑著的容器是否涵蓋現在需要的目標」，不符才重建（重建＝斷線重撥，要盡量避免）。
function targetsSpec(targets) {
  return [...targets]
    .sort((a, b) => a.forwardPort - b.forwardPort)
    .map(t => `${t.forwardPort}:${t.host}:${t.port}`)
    .join(',');
}

function runningTargetsSpec(name, execFileSync) {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{index .Config.Labels "targets"}}', name], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// 為何不沿用「轉發 port 可連上」當就緒訊號：docker 的 -p userland proxy 在容器一啟動（毫秒級）
// 就接受該 port 的 TCP 連線，即使容器內 socat 還沒 listen、tun0 還沒撥通。只看轉發 port 會誤判
// 「已就緒」→ 呼叫端過早清掉掛載進去的 .ovpn，openvpn 可能還沒開檔就撲空（"Error opening
// configuration file" → 容器立即退出）；就算僥倖沒撲空，第一個查詢也會在路由還沒建立時發出而逾時。
// 改成輪詢容器內「真的連得到目標」才算就緒，並在容器中途退出時撈 log 給出可診斷的錯誤。
// 就緒＝隧道真的連得到「任一」目標。全部都要通的話，某台目標機器關機就會擋住整個 gateway。
async function defaultWaitReachable(name, targets, timeoutMs, deps) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const execFile = deps.execFile || realExecFile;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isContainerRunning(name, execFileSync)) {
      let log = '';
      try { log = execFileSync('docker', ['logs', '--tail', '20', name], { encoding: 'utf8' }); } catch { /* 容器可能已被移除 */ }
      throw new Error(`VPN 撥號失敗，容器已結束（多為帳號密碼或設定檔錯誤）：\n${log}`.trim());
    }
    for (const t of targets) {
      if (await probeReachable(name, t.host, t.port, execFile)) return;
    }
    if (Date.now() >= deadline) {
      const list = targets.map(t => `${t.host}:${t.port}`).join('、');
      throw new Error(`VPN 連線逾時（${Math.round(timeoutMs / 1000)} 秒內未能透過隧道連到 ${list}），請確認 VPN 帳號密碼與設定檔是否正確`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// image tag 依 Dockerfile／entrypoint.sh 的內容雜湊，不再固定用 :latest：舊版只看
// 「image 存不存在」，任何已經 build 過一次的機器（含 ai-server）之後改 entrypoint.sh／
// Dockerfile，ensureImageBuilt 一律略過 build，容器內還在跑舊版 entrypoint，且完全沒有
// 錯誤訊息可看（隧道照樣撥得通，只是轉發沒起來）。改成內容雜湊當 tag 後，「image 不存在」
// 與「image 內容已過期」變成同一件事，天然會觸發重建。
// 讀檔後把 \r\n 正規化成 \n 再算雜湊：這兩個檔在 Windows 上可能是 CRLF、Linux 上是 LF，
// 若不正規化，同一份實際內容會因換行符不同、甚至同一台機器的 git autocrlf 設定不同，
// 算出不同的雜湊值——輕則多 build 一次，重則讓雜湊「內容不變 tag 就不變」的前提不成立。
function imageTag(dir = VPN_GATEWAY_DIR) {
  const hash = crypto.createHash('sha256');
  for (const file of ['Dockerfile', 'entrypoint.sh']) {
    // 讀檔失敗（路徑被改壞、檔案被誤刪）直接讓例外往外丟，不要吞掉退回舊行為——
    // 那等於這次修法沒做，回到「image 存在就跳過」的老路。
    const content = realFs.readFileSync(path.join(dir, file), 'utf8');
    hash.update(content.replace(/\r\n/g, '\n'));
  }
  return `${IMAGE_BASE}:${hash.digest('hex').slice(0, 12)}`;
}

// image 不存在時（機器從沒 build 過，或內容雜湊變了）現場 build，
// 不強求使用者記得先跑過一鍵安裝的 Docker 準備步驟。
function ensureImageBuilt(execFileSync, imageName) {
  const out = execFileSync('docker', ['images', '-q', imageName], { encoding: 'utf8' });
  if (out.trim()) return;
  execFileSync('docker', ['build', '-t', imageName, VPN_GATEWAY_DIR], { stdio: 'inherit' });
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
function startGateway(gw, deps) {
  const { execFileSync, writeFileSync, rmSync, tmpFilePath } = deps;
  // 算一次、docker run 沿用同一個值——兩處若各自呼叫 imageTag() 理論上結果相同，
  // 但只算一次能避免「其中一處讀檔時機不同導致 tag 不一致」的疑慮。
  const imageName = imageTag();
  ensureImageBuilt(execFileSync, imageName);
  // 先清遷移前留下的舊容器（vpn-conn-*）：它們會用同一組帳號掛著另一個 openvpn session
  for (const stale of gw.staleContainers || []) removeStaleContainer(stale, execFileSync);
  removeStaleContainer(gw.containerName, execFileSync);

  const spec = targetsSpec(gw.targets);
  const tmpFile = tmpFilePath(gw.containerName);
  // 前一次若因故（如舊版本的清檔案時機問題）留下同路徑的殘留物，Docker 在掛載
  // 一個「主機端不存在」的來源路徑時可能自動建成空目錄；不管殘留的是檔案還是
  // 目錄，寫入前一律先強制清掉，確保這裡一定是全新的一般檔案。
  rmSync(tmpFile, { recursive: true, force: true });
  writeFileSync(tmpFile, gw.config, { mode: 0o600 });

  const args = ['run', '-d', '--name', gw.containerName, '--cap-add=NET_ADMIN',
    // NET_ADMIN 只給「設定網路」的權限，還要把 /dev/net/tun 裝置節點掛進容器，
    // openvpn 才能開 tun0；缺這行會在撥通後倒在 "Cannot open TUN/TAP dev"，tun0 永不出現。
    '--device', '/dev/net/tun'];
  for (const t of [...gw.targets].sort((a, b) => a.forwardPort - b.forwardPort)) {
    args.push('-p', `127.0.0.1:${t.forwardPort}:${t.forwardPort}`);
  }
  args.push(
    '-v', `${tmpFile}:/config/client.ovpn:ro`,
    '-e', `VPN_USER=${gw.username || ''}`,
    '-e', `VPN_PASS=${gw.password || ''}`,
    '-e', `TARGETS=${spec}`,
    '--label', `targets=${spec}`,
    imageName,
  );
  execFileSync('docker', args, { stdio: 'pipe' });
  return tmpFile;
}

async function ensureGatewayRunning(gw, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const writeFileSync = deps.writeFileSync || realFs.writeFileSync;
  const rmSync = deps.rmSync || realFs.rmSync;
  const tmpFilePath = deps.tmpFilePath || ((name) => path.join(os.tmpdir(), `${name}.ovpn`));
  const waitReachable = deps.waitReachable || defaultWaitReachable;

  await ensureDockerRunning(deps);

  const name = gw.containerName;
  const spec = targetsSpec(gw.targets);
  if (isContainerRunning(name, execFileSync) && runningTargetsSpec(name, execFileSync) === spec) {
    return { containerName: name, targetsSpec: spec };
  }

  // tmpFile 路徑先算好（跟 startGateway 內部算法一致），這樣就算 startGateway
  // 半路丟出例外（如 docker run 失敗），外層 finally 仍知道要清哪個檔案。
  const tmpFile = tmpFilePath(name);
  try {
    startGateway(gw, { execFileSync, writeFileSync, rmSync, tmpFilePath });
    // 等「隧道真的連得到目標」才算就緒——這也保證 .ovpn 撐到 openvpn 開檔之後才被清掉。
    await waitReachable(name, gw.targets, GATEWAY_TIMEOUT_MS, { execFileSync, execFile: deps.execFile });
  } finally {
    rmSync(tmpFile, { recursive: true, force: true });
  }
  return { containerName: name, targetsSpec: spec };
}

function stopGateway(gw, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  try { execFileSync('docker', ['stop', gw.containerName], { stdio: 'ignore' }); } catch { /* 容器可能早已不存在 */ }
}

function removeGateway(gw, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  try { execFileSync('docker', ['rm', '-f', gw.containerName], { stdio: 'ignore' }); } catch { /* 容器可能早已不存在 */ }
}

module.exports = { allocateForwardPort, projectContainerName, targetHostPort, imageTag, ensureGatewayRunning, ensureDockerRunning, stopGateway, removeGateway };
