const { runClaude } = require('./claude-runner');
const { promptVersion } = require('./agent-loader');

// 對話式閘門（spec_review／clarify_pending）的 session 續接。
// session 存在哪由呼叫端決定（tasks 欄位／merge_conflict_data JSONB），本檔只管護欄：
//   ① 沒 session → fresh   ② 指紋不符（agent prompt 改過）→ fresh
//   ③ retry 失敗 → 清 session 後同輪降級 fresh，讓使用者這次仍拿得到回覆
// 刻意不設「續接幾次就重來」的上限：權威內容由呼叫端每輪重送（堵住版本 drift）、
// 離開閘門即清（不跨關累積），再加次數上限只會讓中間某輪莫名變慢。見設計文件。
//
// 指紋綁 fresh＋retry 兩個 agent：resume 輪生效的規則同時來自 session 內的 fresh prompt
// 與本輪的 retry prompt，只綁一個會讓另一個改了不重來（qa-agent.js:36 的既有缺口，勿複製）。
function combinedVersion(freshAgentName, retryAgentName) {
  return `${promptVersion(freshAgentName)}.${promptVersion(retryAgentName)}`;
}

// 三個 callback（setSession／clearSession／onRetryFailed）皆可回傳 promise 或純值——
// 呼叫端測試常用 jest.fn() 回傳 undefined，直接 .catch 會因非 thenable 丟 TypeError，
// 逃出這裡的 catch 區塊，毀掉「retry 失敗必定靜默降級」的保證。一律先 Promise.resolve() 包一層。
async function withResume(opts) {
  const {
    freshAgentName, retryAgentName,
    getSession, setSession, clearSession,
    renderFresh, renderRetry, model, runOpts,
    onRetryFailed
  } = opts;

  const ver = combinedVersion(freshAgentName, retryAgentName);
  const sess = await getSession().catch(() => null);

  if (sess && sess.sessionId && sess.promptVer === ver) {
    try {
      const result = await runClaude(renderRetry(), { ...runOpts, resumeSessionId: sess.sessionId, model });
      if (result.sessionId) await Promise.resolve(setSession({ sessionId: result.sessionId, promptVer: ver })).catch(() => {});
      return result;
    } catch (err) {
      // 手動暫停：狀態原地不動、session 留著供解除後續用（比照 qa-agent.js:110）
      if (err && err.aborted) throw err;
      await Promise.resolve(clearSession()).catch(() => {});
      // 逾時不在同輪重跑：同一份輸入再跑一次極可能再逾時，只是讓使用者多等一輪
      // （session 已清，下次進來自然是 fresh；比照 qa-agent.js:114）
      if (err && err.claudeStatus === 'timeout') throw err;
      // 其餘（session 遺失／CLI 壞掉）→ 落到下面 fresh，使用者這輪仍拿得到回覆
      // 呼叫端可透過 onRetryFailed 記帳失敗的執行（比照 qa-agent.js:117-120）
      if (onRetryFailed) await Promise.resolve(onRetryFailed(err)).catch(() => {});
    }
  }

  const result = await runClaude(renderFresh(), { ...runOpts, model });
  if (result.sessionId) await Promise.resolve(setSession({ sessionId: result.sessionId, promptVer: ver })).catch(() => {});
  return result;
}

module.exports = { withResume };
