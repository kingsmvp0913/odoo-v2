const { query } = require('../db');

// status: 'completed' | 'timeout' | 'aborted' | 'interrupted' | 'error'。
// aborted＝使用者手動暫停；interrupted＝被外部信號終止（伺服器重開／OOM kill）；兩者都不是執行失敗，
// 用量報表把它們排除在呼叫數／失敗數之外（見 claude-runner.js 外部終止分支、token-report-routes.js by_agent）。
// 失敗/中斷的執行也要記帳（usage 為零、留 status 與耗時），
// 否則最貴的情境（失敗重跑）在帳面上隱形（健檢 U12）。
// resumed：這一輪是續用上輪 session（true）還是全量重讀（false）。未傳＝該關卡沒有 resume 概念
// 或還沒接上，一律留 NULL，不可退成 false——兩者混在一起，「fresh 佔比」就再也算不準。
async function logTokenUsage(ref, userId, agentType, usage, durationMs, status = 'completed', resumed = null) {
  if (!usage && status === 'completed') return;
  const u = usage || {};
  try {
    await query(
      `INSERT INTO token_usage
         (task_id, project_id, chat_id, user_id, agent_type, model, provider,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          duration_ms, status, source, resumed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'server',$14)`,
      [
        ref.taskId    || null,
        ref.projectId || null,
        ref.chatId    || null,
        userId        || null,
        agentType,
        // model：runClaude 折進 usage.model；失敗路徑 usage 為 null 時退回 ref.model / null
        u.model       || ref.model || null,
        // provider：計價要靠它分流（lib/token-cost.js）。codex 的 model 名沒有可辨識的字串特徵，
        // 不記 provider 就會被當成 sonnet 計，而且不會報錯。未傳＝claude（本欄上線前的既有列同義）。
        u.provider    || ref.provider || null,
        u.input_tokens                || 0,
        u.output_tokens               || 0,
        u.cache_read_input_tokens     || 0,
        u.cache_creation_input_tokens || 0,
        durationMs || null,
        status,
        resumed
      ]
    );
  } catch (err) {
    console.error('[TOKEN-LOGGER]', err.message);
  }
}

// 失敗路徑專用（best-effort）：runClaude 會在 err 標注 claudeStatus 與 durationMs
function logFailedUsage(ref, userId, agentType, err) {
  return logTokenUsage(ref, userId, agentType, null, err?.durationMs || null, err?.claudeStatus || 'error');
}

module.exports = { logTokenUsage, logFailedUsage };
