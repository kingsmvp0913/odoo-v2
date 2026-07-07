const { query } = require('../db');

async function logTokenUsage(ref, userId, agentType, usage, durationMs) {
  if (!usage) return;
  try {
    await query(
      `INSERT INTO token_usage
         (task_id, project_id, chat_id, user_id, agent_type,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          duration_ms, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'server')`,
      [
        ref.taskId    || null,
        ref.projectId || null,
        ref.chatId    || null,
        userId        || null,
        agentType,
        usage.input_tokens                || 0,
        usage.output_tokens               || 0,
        usage.cache_read_input_tokens     || 0,
        usage.cache_creation_input_tokens || 0,
        durationMs || null
      ]
    );
  } catch (err) {
    console.error('[TOKEN-LOGGER]', err.message);
  }
}

module.exports = { logTokenUsage };
