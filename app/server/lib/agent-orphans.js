// app/server/lib/agent-orphans.js
/**
 * agent-orphans.js — 平台啟動時清掉「本實例」殘留的 AI 容器（子專案 0 §6）
 *
 * 與 pipeline/startup-recovery.js 的界線不同：那支只對單一具名測試區容器動作、不列舉；
 * 這支依本平台自己打上的兩個 label（aidev.run=1 且 aidev.instance=<PLATFORM_CONTAINER>）精確列舉。
 * 取不到實例 id 就一個都不刪——只靠 aidev.run 篩會連同主機另一套平台正在跑的 AI 一起砍。
 * 通行證清單在記憶體，重啟後本來就全部失效；這裡只處理還活著的容器。
 */
const { execFile: realExecFile } = require('child_process');

function run(execFile, args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 60000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
  });
}

async function removeOrphanAgentContainers(deps = {}) {
  const execFile = deps.execFile || realExecFile;
  let id;
  try {
    const src = deps.instanceId !== undefined ? deps.instanceId : () => require('./agent-infra').instanceId();
    id = typeof src === 'function' ? src() : src;
  } catch (err) {
    return { removed: 0, skipped: err.message };
  }
  const out = await run(execFile, ['ps', '-aq', '--filter', 'label=aidev.run=1', '--filter', `label=aidev.instance=${id}`]);
  const ids = out.split('\n').map(s => s.trim()).filter(Boolean);
  // 只要不是純十六進位就擋下（例如 --all 這種被誤當成 id 交給 rm 會變成「刪全部」）。
  // 長度放寬到 6：真實短 id 是 12 碼，但這道守衛要擋的是「不是 id 的字串」，不是驗長度。
  if (ids.some(x => !/^[a-f0-9]{6,64}$/.test(x))) throw new Error(`docker ps 回傳了非容器 id 的內容：${ids.join(',')}`);
  if (!ids.length) return { removed: 0 };
  await run(execFile, ['rm', '-f', ...ids]);
  return { removed: ids.length };
}

module.exports = { removeOrphanAgentContainers };
