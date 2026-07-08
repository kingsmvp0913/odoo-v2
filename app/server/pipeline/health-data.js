const { query } = require('../db');

const SAMPLE = 5;                                   // 樣本上限，避免 prompt 過長
const REJECT_STAGES = new Set(['coding', 'analysis']); // 人工退回對這兩類 agent 最可行動

// 單一 agent 近 windowDays 天的精簡表現摘要（餵給健檢 agent 的原料，先在 JS 聚合壓縮避免整表塞 prompt）。
// 以 agent.stage 對 token_usage.agent_type 過濾；tasks 經 token_usage.task_id 業務 id 關聯 tasks.task_id。
async function buildAgentSummary(agent, { windowDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const stage = agent.stage;

  const { rows: [tk] } = await query(
    `SELECT COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::int  AS input_tokens,
            COALESCE(SUM(output_tokens),0)::int AS output_tokens,
            COALESCE(SUM(cache_read_tokens),0)::int AS cache_read,
            COALESCE(AVG(duration_ms),0)::int   AS avg_duration_ms,
            SUM(CASE WHEN status <> 'completed' THEN 1 ELSE 0 END)::int AS failed_calls
       FROM token_usage
      WHERE agent_type = $1 AND recorded_at >= $2`,
    [stage, cutoff]
  );
  const denom = tk.input_tokens + tk.cache_read;
  const token = {
    calls: tk.calls,
    input_tokens: tk.input_tokens,
    output_tokens: tk.output_tokens,
    avg_duration_ms: tk.avg_duration_ms,
    cache_hit_rate: denom ? Math.round((tk.cache_read / denom) * 100) / 100 : 0,
    failed_calls: tk.failed_calls
  };

  const { rows: taskRows } = await query(
    `SELECT DISTINCT t.id, t.status, t.reentry_count, t.blocker_content
       FROM tasks t
      WHERE t.task_id IN (
        SELECT DISTINCT task_id FROM token_usage
         WHERE agent_type = $1 AND recorded_at >= $2)`,
    [stage, cutoff]
  );
  const total = taskRows.length;
  const stopped = taskRows.filter(r => r.status === 'stopped').length;
  const re = taskRows.map(r => r.reentry_count || 0);
  const tasks = {
    total,
    stopped_rate: total ? Math.round((stopped / total) * 100) / 100 : 0,
    reentry: {
      min: re.length ? Math.min(...re) : 0,
      max: re.length ? Math.max(...re) : 0,
      avg: re.length ? Math.round((re.reduce((a, b) => a + b, 0) / re.length) * 100) / 100 : 0
    },
    blocker_samples: taskRows.map(r => r.blocker_content).filter(Boolean).slice(0, SAMPLE)
  };

  let rejections = null;
  if (REJECT_STAGES.has(stage)) {
    const { rows: cats } = await query(
      `SELECT ri.category, COUNT(*)::int AS n
         FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
        WHERE tr.created_at >= $1 GROUP BY ri.category`,
      [cutoff]
    );
    const { rows: samp } = await query(
      `SELECT ri.description FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
        WHERE tr.created_at >= $1 ORDER BY ri.id DESC LIMIT $2`,
      [cutoff, SAMPLE]
    );
    rejections = {
      by_category: Object.fromEntries(cats.map(c => [c.category, c.n])),
      samples: samp.map(s => s.description)
    };
  }

  return { agent: agent.name, stage, window_days: windowDays, token, tasks, rejections };
}

module.exports = { buildAgentSummary };
