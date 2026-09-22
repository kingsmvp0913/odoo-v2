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

// 逾時丟出的 Error 由呼叫端（openEnvTab 的 catch）接住並 showToast。
// onStarting 只在「後端回 202＝要等」時呼叫一次；環境本來就跑著時完全不觸發，呼叫端才不會
// 為了一趟 200ms 的請求閃一則「建立中」。
async function pollEnvSso(projectId, onStarting) {
  const startedAt = Date.now();
  let r = await Api.get(`projects/${projectId}/env/sso`);
  if (r && r.starting && onStarting) onStarting();
  while (r && r.starting) {
    if (Date.now() - startedAt > ENV_SSO_POLL_TIMEOUT_MS) {
      throw new Error('測試區建立逾時，請到專案頁查看建立記錄');
    }
    await new Promise((resolve) => setTimeout(resolve, ENV_SSO_POLL_INTERVAL_MS));
    r = await Api.get(`projects/${projectId}/env/sso`);
  }
  return r.url;
}

// 「按下測試區」的完整動作。原本只有輪詢是共用的，外層這段（popup 開啟時機、等待提示、
// 失敗收尾）在側欄、專案卡、專案頁、任務頁各抄一份，結果漂成兩種行為：只有任務頁那份會在
// 空白分頁寫「建立中」，其餘三處按下去是一個永遠空白的分頁，看起來就是當掉。
function openEnvTab(projectId) {
  // popup-blocker：window.open 必須留在 click handler 的同步段內，await 回來才開會被當成
  // 非使用者手勢擋掉。
  const popup = window.open('about:blank', '_blank');
  let waitingToastId = null;
  const onStarting = () => {
    // 新分頁裡寫一句話：首建可達數分鐘，乾等的空白分頁會被當成當掉。
    if (popup) {
      try { popup.document.write('<p style="font-family:sans-serif;padding:2rem">測試區建立中，請稍候…</p>'); }
      catch (e) { console.debug('about:blank document.write 被瀏覽器擋下，不影響後續導向:', e && e.message); }
    }
    // 使用者多半留在原視窗（新分頁在背景），所以這裡也要有回饋，否則等於沒反應。
    // 壽命給滿輪詢上限——30 秒的黏著上限對「等建置」來說太短，會在還在建的時候先消失。
    waitingToastId = showToast('測試區建立中，請稍候…（首次建立可能需要數分鐘）', 'info', ENV_SSO_POLL_TIMEOUT_MS);
  };
  return pollEnvSso(projectId, onStarting)
    .then((url) => { if (popup) popup.location = url; else window.location.href = url; })
    .catch((e) => {
      if (popup) popup.close();
      showToast(e.message || '無法開啟測試區', 'error', 0);
    })
    .finally(() => { if (waitingToastId !== null) dismissToast(waitingToastId); });
}

if (typeof window !== 'undefined') { window.pollEnvSso = pollEnvSso; window.openEnvTab = openEnvTab; }
if (typeof module !== 'undefined') module.exports = { pollEnvSso, openEnvTab, ENV_SSO_POLL_TIMEOUT_MS, ENV_SSO_POLL_INTERVAL_MS };
