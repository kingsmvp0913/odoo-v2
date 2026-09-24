// app/server/lib/agent-infra.js
/**
 * agent-infra.js — AI 容器需要的主機端設施（子專案 0 §4.1、§4.3）
 * 名字與 label 全帶實例 id（PLATFORM_CONTAINER）。映像檔不自動 build；網路與閘道缺了就建。
 * 成功結果快取 60 秒：每次 AI 執行都打三次 docker inspect 不值得；失敗不快取，下一次重新檢查。
 */
const path = require('path');
const { execFile: realExecFile } = require('child_process');

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const CACHE_MS = 60000;
let _cache = null;

function instanceId() {
  const id = process.env.PLATFORM_CONTAINER;
  if (!id || !NAME_RE.test(id)) {
    throw new Error('PLATFORM_CONTAINER 未設定或含非法字元：AI 容器、網路、閘道都靠它區分平台實例（見 start.sh 讀 data/config.json）');
  }
  return id;
}

function infraNames(id) { return { network: `${id}-agent-net`, gateway: `${id}-gw` }; }
function agentImageTag(version) { return `aidev-agent:${version}`; }

function run(execFile, cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || err.stderr || '') }));
      resolve(String(stdout || ''));
    });
  });
}

async function ensureAgentInfra(deps = {}) {
  const now = deps.now || Date.now;
  if (_cache && now() - _cache.at < CACHE_MS) return _cache.value;

  const execFile = deps.execFile || realExecFile;
  const id = deps.instanceId || instanceId();
  const { network, gateway } = infraNames(id);
  const appDir = deps.appDir || path.resolve(__dirname, '..', '..', '..');
  const socketPath = deps.socketPath || require('./ai-socket-server').aiSocketPath();

  const versionOut = deps.claudeVersion || await run(execFile, 'claude', ['--version']);
  const version = (String(versionOut).match(/\d+\.\d+\.\d+/) || [])[0];
  if (!version) throw new Error(`讀不到 claude 版本：${versionOut}`);
  const image = agentImageTag(version);
  try { await run(execFile, 'docker', ['image', 'inspect', image]); }
  catch {
    // 給管理員看得懂的下一步，不是 build 指令：claude 自己升版時 tag 跟著變，舊映像作廢，
    // 而 start.sh 每次啟動都會補建缺的映像（見該檔），所以「重啟」就是正解。
    throw new Error(`claude 版本已更新（${version}），請管理員重啟平台`);
  }

  try { await run(execFile, 'docker', ['network', 'inspect', network]); }
  catch { await run(execFile, 'docker', ['network', 'create', '--internal', '--label', `aidev.instance=${id}`, network]); }

  let running = false;
  try { running = (await run(execFile, 'docker', ['inspect', '-f', '{{.State.Running}}', gateway])).trim() === 'true'; }
  catch { running = false; }
  if (!running) {
    const lim = deps.gatewayLimits || require('./agent-sandbox-flag').getGatewayLimits();
    if (lim.memory == null || lim.cpus == null || lim.pids == null) {
      throw new Error('出口閘道的資源上限未設定（gateway_memory／gateway_cpus／gateway_pids，見 PUT /api/admin/agent-sandbox）');
    }
    const platformImage = (await run(execFile, 'docker', ['inspect', '-f', '{{.Config.Image}}', id])).trim();
    const gwDir = path.join(appDir, 'app', 'server', 'agent-gateway');
    const runDir = path.dirname(socketPath);
    const uid = deps.uid ?? process.getuid();
    const gid = deps.gid ?? process.getgid();
    await run(execFile, 'docker', ['rm', '-f', gateway]).catch(() => {});
    await run(execFile, 'docker', [
      'run', '-d', '--restart', 'unless-stopped', '--name', gateway,
      '--label', `aidev.instance=${id}`, '--label', 'aidev.gateway=1',
      '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', String(lim.memory), '--memory-swap', String(lim.memory), '--cpus', String(lim.cpus), '--pids-limit', String(lim.pids),
      '--network', 'bridge',
      '--mount', `type=bind,source=${gwDir},target=${gwDir},readonly`,
      '--mount', `type=bind,source=${runDir},target=${runDir},readonly`,
      '-e', `AIDEV_AI_SOCKET=${socketPath}`,
      '--entrypoint', 'node', platformImage, path.join(gwDir, 'gateway.js'),
    ]);
  }
  const nets = JSON.parse((await run(execFile, 'docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', gateway])) || '{}');
  if (!nets[network]) await run(execFile, 'docker', ['network', 'connect', network, gateway]);

  const value = { instanceId: id, image, network, gatewayHost: gateway };
  _cache = { at: now(), value };
  return value;
}

function _resetInfraCacheForTesting() { _cache = null; }

module.exports = { instanceId, infraNames, agentImageTag, ensureAgentInfra, _resetInfraCacheForTesting };
