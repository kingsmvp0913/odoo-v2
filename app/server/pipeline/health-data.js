const { query } = require('../db');
const { costSql } = require('../lib/token-cost');

const SAMPLE = 5;                                   // 樣本上限，避免 prompt 過長
const REJECT_STAGES = new Set(['coding', 'analysis']); // 人工退回對這兩類 agent 最可行動

// token_usage.agent_type 多數等於 agent 的 stage，但 merge 家族的兩支是用自己的名字記帳
// （見 merge-explain／merge-clarify 的 logTokenUsage），只比對 stage 會讓它們的用量與失敗
// 完全沒人統計——健檢看它們永遠是「零呼叫」，也就永遠不會被檢討。
const STAGE_AGENT_TYPES = { merge: ['merge', 'merge-clarify', 'merge-explain'] };
const typesFor = (stage) => STAGE_AGENT_TYPES[stage] || [stage];

// 一個 stage 底下其實是好幾個不同閘門的 agent 時，「同一張任務被呼叫 N 次」就不等於「這一關重跑
// N 次」——respec 的 clarify-chat／spec-review／respec-patch 是三個不同的閘門，各跑一次就記成 3。
// 不標註的話健檢會把它讀成空轉。
const MULTI_GATE_STAGES = new Set(['respec']);

// 單一 agent 近 windowDays 天的精簡表現摘要（餵給健檢 agent 的原料，先在 JS 聚合壓縮避免整表塞 prompt）。
// 以 agent.stage 對 token_usage.agent_type 過濾；tasks 經 token_usage.task_id 業務 id 關聯 tasks.task_id。
async function buildAgentSummary(agent, { windowDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const stage = agent.stage;
  // 動態 IN 而非 ANY(陣列)：pg-mem 對有索引的欄位跑 ANY 會靜默回 0 列（見 wiki-routes 的同一註解）
  const types = typesFor(stage);
  const typePh = types.map((_, i) => `$${i + 1}`).join(',');
  const cutoffPh = `$${types.length + 1}`;

  // 成本用與 token-report 同一套加權（output=5×、cache_read=0.1×、cache_create=1.25× input），
  // 單價依 model 取（未知/空一律以 sonnet 計）。健檢原本完全看不到成本，於是 30 天最大單項支出
  // 的 agent 被判「表現正常」——成本是本平台最該被觀測的訊號，不能不在視野內。
  const { weighted: WEIGHTED, rate: RATE } = costSql();
  const { rows: [tk] } = await query(
    `SELECT COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::int  AS input_tokens,
            COALESCE(SUM(output_tokens),0)::int AS output_tokens,
            COALESCE(SUM(cache_read_tokens),0)::int AS cache_read,
            COALESCE(SUM(cache_create_tokens),0)::int AS cache_create,
            COALESCE(SUM(${RATE} * ${WEIGHTED} / 1000000.0),0) AS cost_usd,
            COALESCE(AVG(duration_ms),0)::int   AS avg_duration_ms,
            COALESCE(SUM(CASE WHEN status <> 'completed' THEN 1 ELSE 0 END),0)::int AS failed_calls
       FROM token_usage
      WHERE agent_type IN (${typePh}) AND recorded_at >= ${cutoffPh}`,
    [...types, cutoff]
  );
  // 分母必須含 cache_create：它是 1.25× 單價、cache_read 是 0.1×，漏掉最貴的那一項會讓這個比率
  // 結構上不可能低——實測 chat 顯示 0.99（看似完美），實際上重寫快取吃掉了近半成本。
  const denom = tk.input_tokens + tk.cache_read + tk.cache_create;
  const token = {
    calls: tk.calls,
    input_tokens: tk.input_tokens,
    output_tokens: tk.output_tokens,
    cache_read: tk.cache_read,
    cache_create: tk.cache_create,
    cost_usd: Math.round(Number(tk.cost_usd) * 100) / 100,
    avg_duration_ms: tk.avg_duration_ms,
    cache_hit_rate: denom ? Math.round((tk.cache_read / denom) * 100) / 100 : 0,
    failed_calls: tk.failed_calls
  };

  // 每張任務在此關被呼叫幾次：本平台最真實的失敗訊號。失敗多半不是崩潰（那些都記 completed），
  // 而是「跑完了但沒用」——空轉一輪、產出與上輪相同、下游照樣失敗。用 token_usage 的列數推算，
  // 不讀 tasks 的 *_retry_count／reentry_count：那些會在分診放行時被歸零，是「本次嘗試」的計數器。
  // 刻意不寫 `AND task_id IS NOT NULL`，也不用 SQL GROUP BY，改撈原始列在 JS 聚合：
  // token_usage.task_id 有索引，而 pg-mem（測試用）對有索引欄位的 `IS NOT NULL AND <比較>`
  // 會靜默回空集合（見 .claude/rules/testing.md 規則 15）——隔離跑該測試通過、全套跑同一支
  // 拿到 0，是最難察覺的那種假失敗。NULL 在 JS 端濾掉，語意完全等價。
  const { rows: repeatRows } = await query(
    `SELECT task_id FROM token_usage WHERE agent_type IN (${typePh}) AND recorded_at >= ${cutoffPh}`,
    [...types, cutoff]
  );
  const counts = new Map();
  for (const r of repeatRows) {
    if (!r.task_id) continue;
    counts.set(r.task_id, (counts.get(r.task_id) || 0) + 1);
  }
  const ns = [...counts.values()];
  const repeat_calls = {
    tasks_with_calls: ns.length,
    max: ns.length ? Math.max(...ns) : 0,
    avg: ns.length ? Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 100) / 100 : 0,
    tasks_over_2: ns.filter(n => n > 2).length,
    // 同一個 stage 底下有多個不同閘門的 agent 時，次數不等於「這一關重跑」，要講明白
    ...(MULTI_GATE_STAGES.has(stage)
      ? { note: `此 stage 涵蓋多個不同閘門的 agent（${types.join('／')} 之外還有同 stage 的兄弟關卡），次數含跨閘門呼叫，不等於本關重跑` }
      : {})
  };

  const { rows: taskRows } = await query(
    `SELECT DISTINCT t.id, t.status, t.reentry_count, t.blocker_content
       FROM tasks t
      WHERE t.task_id IN (
        SELECT DISTINCT task_id FROM token_usage
         WHERE agent_type IN (${typePh}) AND recorded_at >= ${cutoffPh})`,
    [...types, cutoff]
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
    blocker_samples: taskRows.map(r => r.blocker_content).filter(Boolean).slice(0, SAMPLE).map(s => String(s).slice(0, 500))
  };

  let rejections = null;
  if (REJECT_STAGES.has(stage)) {
    const { rows: cats } = await query(
      `SELECT ri.category, COUNT(*)::int AS n
         FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
        WHERE tr.created_at >= $1 AND tr.source = 'human' GROUP BY ri.category`,
      [cutoff]
    );
    const { rows: samp } = await query(
      `SELECT ri.description FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
        WHERE tr.created_at >= $1 AND tr.source = 'human' ORDER BY ri.id DESC LIMIT $2`,
      [cutoff, SAMPLE]
    );
    rejections = {
      by_category: Object.fromEntries(cats.map(c => [c.category, c.n])),
      samples: samp.map(s => s.description)
    };
  }

  // QA 自動退回的根因（依 agent 過濾其相關類）＋平台層 env_flaky 計數
  let qa_rejections = null;
  const QA_RELEVANT = { coding: 'impl_miss', analysis: 'spec_unclear' };
  const relevant = QA_RELEVANT[stage];
  if (relevant) {
    const { rows: [q] } = await query(
      `SELECT
         SUM(CASE WHEN ri.category = $2 THEN 1 ELSE 0 END)::int          AS relevant_n,
         SUM(CASE WHEN ri.category = 'env_flaky' THEN 1 ELSE 0 END)::int AS env_n
       FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
      WHERE tr.created_at >= $1 AND tr.source = 'qa'`,
      [cutoff, relevant]
    );
    q.relevant_n = q.relevant_n || 0;
    q.env_n = q.env_n || 0;
    qa_rejections = { relevant_category: relevant, count: q.relevant_n, env_flaky_count: q.env_n };
  }

  // wiki 文件漂移：對 chat／cs 兩關才有意義（它們是漂移回報來源），比照 rejections 依 category 彙整＋抽樣本
  let wiki_drift = null;
  const DRIFT_SOURCE = { chat: 'chat', cs: 'cs' };
  const driftSrc = DRIFT_SOURCE[stage];
  if (driftSrc) {
    const { rows: cats } = await query(
      `SELECT COALESCE(category,'未分類') AS category, COUNT(*)::int AS n
         FROM wiki_drift WHERE source=$1 AND created_at >= $2 GROUP BY category`,
      [driftSrc, cutoff]
    );
    const { rows: samp } = await query(
      `SELECT slug, reason FROM wiki_drift
        WHERE source=$1 AND created_at >= $2 ORDER BY id DESC LIMIT $3`,
      [driftSrc, cutoff, SAMPLE]
    );
    wiki_drift = {
      by_category: Object.fromEntries(cats.map(c => [c.category, c.n])),
      samples: samp.map(s => (s.slug ? `${s.slug}：` : '') + s.reason)
    };
  }

  return { agent: agent.name, stage, window_days: windowDays, token, repeat_calls, tasks, rejections, qa_rejections, wiki_drift };
}

module.exports = { buildAgentSummary };
