// 「開啟測試區」共用輪詢邏輯：環境被閒置回收後 GET /env/sso 會自動觸發後端建立，
// 就緒前持續回 202 { starting:true }。ProjectDetail／TaskList／TaskDetail 三個入口
// 原本各存一份幾乎逐字相同的輪詢迴圈，這裡抽成單一來源，逾時常數也才只有一份、不會
// 三個檔案各寫一個魔術數字。
//
// 上限抓 10 分鐘：pipeline/env-agent.js 的 waitForPort 對「首次建置」把健檢逾時放寬到
// 300 秒（5 分鐘）；首建前還有 docker image build，沒有上限、實務上可能再花數分鐘——
// 抓健檢逾時的 2 倍當緩衝，避免真的還在建置中卻被判定逾時。
const ENV_SSO_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const ENV_SSO_POLL_INTERVAL_MS = 5000;

// 逾時丟出的 Error 由呼叫端（各 openEnv 的 catch）接住並 showToast。
async function pollEnvSso(projectId) {
  const startedAt = Date.now();
  let r = await Api.get(`projects/${projectId}/env/sso`);
  while (r && r.starting) {
    if (Date.now() - startedAt > ENV_SSO_POLL_TIMEOUT_MS) {
      throw new Error('測試區建立逾時，請到專案頁查看建立記錄');
    }
    await new Promise((resolve) => setTimeout(resolve, ENV_SSO_POLL_INTERVAL_MS));
    r = await Api.get(`projects/${projectId}/env/sso`);
  }
  return r.url;
}

if (typeof window !== 'undefined') window.pollEnvSso = pollEnvSso;
if (typeof module !== 'undefined') module.exports = { pollEnvSso, ENV_SSO_POLL_TIMEOUT_MS, ENV_SSO_POLL_INTERVAL_MS };
