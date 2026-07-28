const { query } = require('../db');
const { runEnvSetup, waitForPort } = require('./env-agent');
const { envBindHost } = require('../port-alloc');

// 確保測試環境運行中；未運行則嘗試建立/啟動（fast-start：有 .ready 幾秒內起來），仍失敗回傳 false。
// deploy 與 E2E 兩階段共用：環境可能在階段間被砍（app 重啟／process crash），
// E2E 前先自動起環境而非直接報錯（單一真相來源，避免兩份邏輯漂移）。
async function ensureEnvRunning(projectId) {
  const { rows: [env] } = await query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [projectId]);
  // 標 running 也要實測埠活著才放行：process 可能先健康、之後才崩（crash／夜間 shutdown 漏砍），
  // DB 卻仍停在 running。盲信會把死掉的 URL 交給 E2E → 連不上被兜底成永遠好不了的 env blocker。
  // host 必須傳：容器 -p 只綁 envBindHost（每埠獨立 127.0.0.x，或正式環境的 docker0 閘道），
  // 用預設 127.0.0.1 探測會永遠失敗，導致每次都白跑一次完整 runEnvSetup。
  if (env?.status === 'running' && env.port && await waitForPort(env.port, 5000, 500, envBindHost(env.port))) return true;
  await runEnvSetup(projectId);
  const { rows: [env2] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [projectId]);
  return env2?.status === 'running';
}

module.exports = { ensureEnvRunning };
