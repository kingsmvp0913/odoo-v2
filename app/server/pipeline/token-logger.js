const { query } = require('../db');

// status: 'completed' | 'timeout' | 'aborted' | 'error'。
// 失敗/中斷的執行也要記帳（usage 為零、留 status 與耗時），
// 否則最貴的情境（失敗重跑）在帳面上隱形（健檢 U12）。
async function logTokenUsage(ref, userId, agentType, usage, durationMs, status = 'completed') {
  if (!usage && status === 'completed') return;
  const u = usage || {};
  try {
    await query(
      `INSERT INTO token_usage
         (task_id, project_id, chat_id, user_id, agent_type, model,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          duration_ms, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'server')`,
      [
        ref.taskId    || null,
        ref.projectId || null,
        ref.chatId    || null,
        userId        || null,
        agentType,
        // model：runClaude 折進 usage.model；失敗路徑 usage 為 null 時退回 ref.model / null
        u.model       || ref.model || null,
        u.input_tokens                || 0,
        u.output_tokens               || 0,
        u.cache_read_input_tokens     || 0,
        u.cache_creation_input_tokens || 0,
        durationMs || null,
        status
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
