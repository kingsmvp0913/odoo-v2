/**
 * _sandbox-run-mock.js — 給測試用的 pipeline/sandbox-run 替身（**不是測試檔**，底線開頭避開 testMatch）
 *
 * 為什麼需要它：2026-09-24 拿掉舊的非容器路徑之後，runClaude 只剩一條路——先 await
 * resolveSandboxPlan／prepareSandboxRun，再 spawn('docker', ...)。真的那一份會查 DB、
 * 檢查映像檔、發通行證、建 worktree，在單元測試裡一概跑不動。
 *
 * ⚠ **這個替身不驗任何東西**。容器路徑自己的行為（憑證怎麼組、上限怎麼帶、release 怎麼確認
 * 容器停了）一律由 sandbox-run.test.js 對真品驗；用這個替身的套件驗的是 runClaude 的串流解析、
 * 逾時、中止與歸因，那些本來就與容器無關。兩邊不要互相冒充。
 *
 * spawn 會拿到 `['run', '--rm', ...claudeArgs]`：claudeArgs 原樣接在尾端，是為了讓既有那些
 * 「args 有沒有帶 --resume」的斷言繼續看得到真正的 CLI 參數（真品也是把它接在 image 之後）。
 */
function sandboxRunMock() {
  return {
    resolveSandboxPlan: jest.fn(async () => ({ profile: {}, projectId: null })),
    prepareSandboxRun: jest.fn(async ({ claudeArgs = [] }) => ({
      argv: ['run', '--rm', 'aidev-agent:test', 'claude', ...claudeArgs],
      childEnv: { PATH: process.env.PATH },
      containerName: 'test-run-1',
      runId: 'test-run-1',
      attach: child => child,
      release: () => {},
      kill: () => {},
    })),
  };
}

/**
 * 讓出幾拍給「解析計畫 → 準備容器 → spawn」那條 await 鏈跑完。
 *
 * 舊的非容器路徑是**同步** spawn，所以既有測試普遍寫成「呼叫 runClaude 之後立刻對 mock child
 * 發事件」。容器路徑不是——spawn 發生在兩個 await 之後，那些事件會發在子行程還不存在的時候，
 * 沒有人聽得到，promise 於是永遠不 settle（症狀是整支套件逾時，不是斷言失敗）。
 * 替身不做任何真 I/O，所以讓出幾個 macrotask 一定夠。
 */
const untilSpawned = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

module.exports = sandboxRunMock;
module.exports.untilSpawned = untilSpawned;
