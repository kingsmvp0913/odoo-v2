const { query } = require('../db');
const { costSql } = require('../lib/token-cost');
const fs = require('fs');
const { promptVersion, agentPath } = require('./agent-loader');

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

// 警語只留一份：per-agent 深診的 repeat_calls 與起手包的 per_stage 讀的是同一件事（次數），
// 原本只有深診掛了這句。健檢每輪真正先讀的是起手包，於是程式碼裡明文警告過的誤讀照樣重現
// （respec 的 repeat_avg 8.5 被讀成整關空轉）。兩條路徑共用同一段文字，不得各寫各的。
function multiGateNote(stage) {
  if (!MULTI_GATE_STAGES.has(stage)) return null;
  return `此 stage 涵蓋多個不同閘門的 agent（${typesFor(stage).join('／')} 之外還有同 stage 的兄弟關卡），次數含跨閘門呼叫，不等於本關重跑`;
}

// 卡住的任務：停在「該由系統／AI 推進」的狀態卻很久沒動靜。起手包原本完全沒有這個區塊，健檢只能
// 自己拼 SQL，上一輪寫成 `status LIKE '%_running' AND updated_at > 24h`——漏了 is_hidden 與
// is_paused，把兩張使用者手動封存的任務（封存按鈕會設 is_hidden=true，見 tasks-routes.js）報成
// 「靜默消失 30 天與 42 天」。runner.js 的派工查詢本來就帶 `is_paused = false AND is_hidden = false`，
// 不派它們是正確行為，不是故障。
const STUCK_HOURS = 24;
const STUCK_LIMIT = 10;

// 狀態白名單直接取 runner 派工用的同一份 RUNNABLE_STATUSES，不自己抄一份：抄本不會跟著新增的關卡
// 更新，而漏掉一關的症狀就是「那一關卡住的任務永遠不出現在起手包裡」，靜默且沒有任何測試會紅。
async function buildStuckTasks(nowMs) {
  const { RUNNABLE_STATUSES } = require('../../public/js/status-labels.js');
  const ph = RUNNABLE_STATUSES.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT id, task_id, title, status, is_hidden, is_paused, updated_at
       FROM tasks WHERE status IN (${ph}) ORDER BY id`, RUNNABLE_STATUSES);
  // 年齡與 is_hidden／is_paused 一律在 JS 濾，不寫進 SQL：pg-mem（測試用）對有索引欄位的
  // 「等值＋比較」組合會靜默回空集合（rules/testing #15），而這個區塊靜默變空，跟「真的沒有卡住
  // 的任務」在輸出上長得一模一樣——正是這次要修掉的那種假陰性。
  const stalled = rows.filter(r => nowMs - new Date(r.updated_at).getTime() >= STUCK_HOURS * 3600000);
  const active = stalled.filter(r => !r.is_hidden && !r.is_paused);
  const out = {
    threshold_hours: STUCK_HOURS,
    // 篩選條件寫進輸出：健檢看得到口徑才不會覺得需要自己再下一次 SQL
    filter: '與 runner.js 的派工查詢同源：status ∈ RUNNABLE_STATUSES 且 is_hidden = false 且 is_paused = false',
    count: active.length,
    // 被排除的張數照報，不靜默吃掉：它們確實停在執行中狀態很久，只是「不派工」是正確行為
    excluded: {
      hidden: stalled.filter(r => r.is_hidden).length,
      paused: stalled.filter(r => !r.is_hidden && r.is_paused).length
    },
    rows: active
      .map(r => ({
        id: r.id, task_id: r.task_id, title: r.title, status: r.status,
        stalled_hours: Math.round(((nowMs - new Date(r.updated_at).getTime()) / 3600000) * 10) / 10
      }))
      .sort((a, b) => b.stalled_hours - a.stalled_hours)
      .slice(0, STUCK_LIMIT)
  };
  if (out.excluded.hidden || out.excluded.paused) {
    out.excluded_note = '這些是使用者手動封存（is_hidden）或暫停（is_paused）的任務，派工查詢本來就排除它們，'
      + '不派是正確行為——不得報成「任務靜默消失」或「卡住」。';
  }
  return out;
}

// 百分位在 JS 端算，不用 SQL 的 percentile_cont：測試跑 pg-mem，聚合函式支援度不齊，
// 而本檔既有的 avg／max 也都是撈原始列在 JS 聚合，維持一致。
// nearest-rank（ceil(p×n)-1），不用 floor((n-1)×p)：後者在小樣本下會把尾巴切掉——
// n=3 的 [1,2,100] 算出的 p90 是 2，等於這個指標最想抓的那張卡很久的任務完全看不到。
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

// 任務 wall-clock：完成時刻取 `done_at`（token-report 也以它為準），缺則退回 `lastCallAt`
// ——該任務最後一次 agent 呼叫的時間（見 lastCallMap）。**不得退回 updated_at**：它的語意是
// 「最後一次被改」，任何外部批次（eService 同步、封存 cron）碰一下就會把它刷成現在，於是一張
// 窗前早就完成的舊任務會被當成「建立 → 被 touch」的超長耗時，p90 整個誇大（實測 51.1 小時）。
// 兩者皆無的任務沒有可信的完成時刻，直接排除，不猜——`done_tasks` 回的就是排除後真正進樣本的
// 張數，樣本掉到剩一兩張時讀 p90 要自己打折。
// **只算 done**：進行中的任務沒有完成時刻，混進來數字就沒有意義。
// 用 p50/p90 不用 avg：一兩張卡三天的任務會把平均整個洗掉，而那正是最該被看見的分佈尾巴。
function wallClock(rows, lastCallAt = null) {
  const hrs = [];
  for (const r of rows) {
    if (r.status !== 'done' || !r.created_at) continue;
    const at = completionAt(r, lastCallAt);
    if (!at) continue;
    const h = (new Date(at) - new Date(r.created_at)) / 3600000;
    if (h >= 0) hrs.push(h);
  }
  hrs.sort((a, b) => a - b);
  const r1 = (n) => Math.round(n * 10) / 10;
  return { done_tasks: hrs.length, p50_hours: r1(pct(hrs, 0.5)), p90_hours: r1(pct(hrs, 0.9)) };
}

// 一張任務的完成時刻，查不到就回 null（不猜）。選窗與算耗時共用同一個定義，免得兩邊各走各的。
function completionAt(row, lastCallAt) {
  if (row.done_at) return row.done_at;
  return (lastCallAt && row.task_id) ? (lastCallAt.get(row.task_id) || null) : null;
}

// 完成時刻的第二來源：每張任務最後一次 agent 呼叫的時間。
// token_usage 是 append-only 的計費列（保留 180 天，遠長於健檢視窗），外部批次碰不到它，
// 所以它不會像 updated_at 那樣被刷新。會比真正的完成時刻早一些（merge／deploy／E2E 那幾關
// 沒有 agent 呼叫），也就是只會低估、不會把耗時誇大——這正是本指標需要的方向。
async function lastCallMap(taskIds) {
  if (!taskIds.length) return new Map();
  const ph = taskIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT task_id, recorded_at FROM token_usage WHERE task_id IN (${ph})`, taskIds);
  const m = new Map();
  for (const r of rows) {
    const cur = m.get(r.task_id);
    if (!cur || new Date(r.recorded_at) > new Date(cur)) m.set(r.task_id, r.recorded_at);
  }
  return m;
}

// 狀態轉移序列。資料源刻意用 token_usage 而非 task_events：後者是整段終端串流（一輪 coding
// 數十到數百筆）、要靠字串比對抓 marker，且 cron 對 done/stopped 滿 30 天的任務會整批刪掉。
// token_usage 每次 agent 呼叫剛好一筆、帶 agent_type 與時間，依時間排序就是這張任務走過的關卡。
// ⚠ 只涵蓋「會呼叫 agent」的關：merge／deploy／E2E 那幾關沒有 agent 呼叫，不會出現在序列裡。
// 看的是形狀不是次數——`coding→qa→coding→qa` 是兩關之間震盪，`qa→qa→qa` 才是該關自己空轉，
// 這兩種在 repeat_calls 這個純數字上長得一模一樣。
function toSequence(rows) {
  const out = [];
  for (const r of rows) if (out[out.length - 1] !== r.agent_type) out.push(r.agent_type);
  return out.join('→');
}

// 這一版 prompt 是什麼時候上線的、上線後累積了多少樣本。
// 寫入放在健檢裡而不是 updateAgent()：prompt 也會被直接改檔案（人工編輯、workflow-health 的
// 建議被貼上去），只掛在 UI 那條路徑會漏記，而漏記的症狀是「窗口起點停在很久以前」——看起來
// 有一大堆樣本，其實全是舊版產生的，比沒有這個欄位更危險。
// **不篩掉舊版資料**：改完 prompt 當天 calls_since 必然是 0，硬篩就等於健檢完全瞎掉。改為原樣
// 附上，讓判準那邊決定「本版樣本太少 → 不得據此判斷本版好壞」。
async function trackPromptVersion(agentName, types) {
  let version = null;
  try { version = promptVersion(agentName); } catch { return null; }  // 測試會傳假 agent，載不到就不追
  const { rows: [last] } = await query(
    'SELECT version, first_seen_at FROM agent_prompt_versions WHERE agent_name = $1 ORDER BY id DESC LIMIT 1',
    [agentName]
  );
  let since = last && last.version === version ? last.first_seen_at : null;
  let seeded = false;
  if (!since) {
    // 這個 agent 第一次被記錄時，「本版何時上線」其實是未知的——用 NOW() 會把先前累積的樣本
    // 全部排除，於是首輪健檢每一關的 calls_since 都是 0，判準的「樣本太少不得下判斷」會全面觸發，
    // 整個健檢等於瞎掉。故種子列改用 .md 的 mtime 當估計值（agent-loader 的熱載也是看它），
    // 並標 seeded 讓判讀方知道這個時間是估的。之後真的換版時才是精準的 NOW()。
    let seedAt = null;
    if (!last) {
      seeded = true;
      try { seedAt = fs.statSync(agentPath(agentName)).mtime.toISOString(); } catch { seedAt = null; }
    }
    const { rows: [ins] } = await query(
      'INSERT INTO agent_prompt_versions (agent_name, version, first_seen_at) VALUES ($1,$2,COALESCE($3::timestamptz, NOW())) RETURNING first_seen_at',
      [agentName, version, seedAt]
    );
    since = ins.first_seen_at;
  }
  // 記帳用的是 agent_type（多數等於 stage、merge 家族用自己的名字），不是 agent 檔名——
  // 拿 agent_name 去比對會讓 analysis-project 這類永遠數到 0，而且是靜默的。
  const ph = types.map((_, i) => `$${i + 1}`).join(',');
  const { rows: [c] } = await query(
    `SELECT COUNT(*)::int AS n FROM token_usage WHERE agent_type IN (${ph}) AND recorded_at >= $${types.length + 1}`,
    [...types, since]
  );
  return { version, since, seeded, calls_since: c ? c.n : 0 };
}

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
  const { cost: COST } = costSql();
  const { rows: [tk] } = await query(
    // ⚠ calls／failed_calls 的口徑與 buildWindowSummary 的 per_stage 及正式報表三者必須一致：
    // aborted（按停止）與 interrupted（重啟／OOM）分子分母都排除。同一個檔案裡放兩份不同定義，
    // 會變成「改了一處、另一處還在報舊數字」，而兩邊都叫 failed_calls，看數字看不出是哪一份。
    `SELECT COALESCE(SUM(CASE WHEN COALESCE(status,'completed') NOT IN ('aborted','interrupted') THEN 1 ELSE 0 END),0)::int AS calls,
            COALESCE(SUM(input_tokens),0)::int  AS input_tokens,
            COALESCE(SUM(output_tokens),0)::int AS output_tokens,
            COALESCE(SUM(cache_read_tokens),0)::int AS cache_read,
            COALESCE(SUM(cache_create_tokens),0)::int AS cache_create,
            COALESCE(SUM(${COST}),0) AS cost_usd,
            COALESCE(AVG(duration_ms),0)::int   AS avg_duration_ms,
            COALESCE(SUM(CASE WHEN COALESCE(status,'completed') NOT IN ('completed','aborted','interrupted') THEN 1 ELSE 0 END),0)::int AS failed_calls
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
    ...(multiGateNote(stage) ? { note: multiGateNote(stage) } : {})
  };

  const { rows: taskRows } = await query(
    `SELECT DISTINCT t.id, t.task_id, t.status, t.reentry_count, t.blocker_content, t.created_at, t.updated_at, t.done_at
       FROM tasks t
      WHERE t.task_id IN (
        SELECT DISTINCT task_id FROM token_usage
         WHERE agent_type IN (${typePh}) AND recorded_at >= ${cutoffPh})`,
    [...types, cutoff]
  );
  const total = taskRows.length;
  const stopped = taskRows.filter(r => r.status === 'stopped').length;
  const re = taskRows.map(r => r.reentry_count || 0);
  // 只對「已完成卻沒有 done_at」的那幾張補查第二來源（客服結案這條路徑在 finding 176 之前
  // 一律不寫 done_at，既有列也沒回填）；有 done_at 的不必查。
  const lastAt = await lastCallMap([...new Set(
    taskRows.filter(r => r.status === 'done' && !r.done_at && r.task_id).map(r => r.task_id)
  )]);
  const tasks = {
    total,
    stopped_rate: total ? Math.round((stopped / total) * 100) / 100 : 0,
    reentry: {
      min: re.length ? Math.min(...re) : 0,
      max: re.length ? Math.max(...re) : 0,
      avg: re.length ? Math.round((re.reduce((a, b) => a + b, 0) / re.length) * 100) / 100 : 0
    },
    blocker_samples: taskRows.map(r => r.blocker_content).filter(Boolean).slice(0, SAMPLE).map(s => String(s).slice(0, 500)),
    wall_clock: wallClock(taskRows, lastAt)
  };

  // 抽樣本挑「在這關被呼叫最多次」的幾張：序列是要拿來看震盪的，一次就過的任務序列沒有資訊量。
  const hottest = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SAMPLE).map(([tid]) => tid);
  tasks.sequences = [];
  if (hottest.length) {
    const ph = hottest.map((_, i) => `$${i + 1}`).join(',');
    const { rows: seqRows } = await query(
      `SELECT task_id, agent_type FROM token_usage
        WHERE task_id IN (${ph}) ORDER BY task_id, recorded_at, id`,
      hottest
    );
    const byTask = new Map();
    for (const r of seqRows) {
      if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
      byTask.get(r.task_id).push(r);
    }
    tasks.sequences = [...byTask.entries()].map(([tid, rs]) => ({ task_id: tid, seq: toSequence(rs), calls: rs.length }));
  }

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

  const prompt_version = await trackPromptVersion(agent.name, types);

  return { agent: agent.name, stage, window_days: windowDays, prompt_version, token, repeat_calls, tasks, rejections, qa_rejections, wiki_drift };
}

// 單張任務的摘要（scope=task）。與 buildAgentSummary 是同一批資料的另一個投影，不是另一套分析：
// 前者跨任務聚合看某一關，後者跨關卡展開看某一張。判準（.claude/skills/healthCheck）兩邊共用。
// 參數是 tasks.id（整數主鍵）——業務 task_id 只在 (user_id, task_id) 下唯一，單獨拿會撞號。
async function buildTaskSummary(taskDbId) {
  const { rows: [t] } = await query(
    `SELECT id, task_id, title, status, reentry_count, qa_retry_count, pw_retry_count,
            deploy_retry_count, blocker_content, created_at, updated_at, done_at
       FROM tasks WHERE id = $1`,
    [taskDbId]
  );
  if (!t) return null;

  const { rows: usage } = await query(
    `SELECT agent_type, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
            duration_ms, status, recorded_at
       FROM token_usage WHERE task_id = $1 ORDER BY recorded_at, id`,
    [t.task_id]
  );

  // 每關在這張任務上花了多少：次數多＝這關反覆重跑，秒數長＝這關本身慢，兩者要分開看。
  const byStage = new Map();
  for (const u of usage) {
    const k = u.agent_type || '(未知)';
    const acc = byStage.get(k) || { calls: 0, duration_ms: 0, output_tokens: 0 };
    acc.calls += 1;
    acc.duration_ms += u.duration_ms || 0;
    acc.output_tokens += u.output_tokens || 0;
    byStage.set(k, acc);
  }

  const { rows: rej } = await query(
    `SELECT ri.category, ri.description, tr.source
       FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
      WHERE tr.task_id = $1 ORDER BY ri.id DESC LIMIT $2`,
    [t.task_id, SAMPLE]
  );

  return {
    scope: `task:${t.id}`,
    task: {
      task_id: t.task_id,
      title: t.title,
      status: t.status,
      created_at: t.created_at,
      updated_at: t.updated_at,
      done_at: t.done_at,
      // 進行中的任務沒有完成時刻，此值是「到目前為止」而非總長，判讀時不可與 done 的任務混比
      elapsed_hours: Math.round(((Date.now() - new Date(t.created_at)) / 3600000) * 10) / 10,
      reentry_count: t.reentry_count || 0,
      qa_retry_count: t.qa_retry_count || 0,
      pw_retry_count: t.pw_retry_count || 0,
      deploy_retry_count: t.deploy_retry_count || 0,
      blocker: t.blocker_content ? String(t.blocker_content).slice(0, 1000) : null
    },
    sequence: toSequence(usage),
    per_stage: Object.fromEntries([...byStage.entries()].map(([k, v]) => [k, v])),
    rejections: rej.map(r => ({ source: r.source, category: r.category, description: r.description }))
  };
}

// 增量視窗的起手包（scope=platform 的主導型健檢用）。
// 為什麼是增量而不是固定 30 天：固定視窗量到的指標多半由**已被取代的舊版提示詞**產生，判讀時
// 整批要打折（run#5 幾乎每一關的 calls_since 都是 0）。改成「上一輪健檢之後」，量到的正好是
// 「上次改動之後的表現」。
// 這份刻意只給輪廓、不給細節：審計 agent 拿到它之後會自己下 SQL 深挖（platformDB skill，唯讀），
// 尤其是「窗內看到疑似問題 → 回頭到更早的資料找同類單號」那一步——那才是湊得到「多張不同任務」
// 證據門檻的方式，短視窗自己是湊不到的。
// untilAt 只有趨勢比對會帶（30 天大健檢要另算一份「上一期」來對照）：一般健檢的視窗一律開到現在，
// 帶了上界反而會漏掉「起手包算出來到 agent 真正讀到」之間發生的事。
async function buildWindowSummary(sinceAt, untilAt = null) {
  const since = new Date(sinceAt).toISOString();
  const until = untilAt ? new Date(untilAt).toISOString() : null;
  const upTo = col => (until ? ` AND ${col} < $2` : '');
  const args = until ? [since, until] : [since];
  const { cost: COST } = costSql();

  const { rows: usage } = await query(
    `SELECT task_id, chat_id, agent_type, model, duration_ms, status, recorded_at,
            input_tokens, output_tokens, cache_read_tokens, cache_create_tokens
       FROM token_usage WHERE recorded_at >= $1${upTo('recorded_at')} ORDER BY recorded_at, id`, args
  );
  const { rows: [cost] } = await query(
    `SELECT COALESCE(SUM(${COST}),0) AS cost_usd FROM token_usage WHERE recorded_at >= $1${upTo('recorded_at')}`,
    args
  );

  // 每關：呼叫數、失敗數、平均耗時、經手幾張任務。細節（哪一張、為什麼）由 agent 自己查。
  const byStage = new Map();
  const tasksOfStage = new Map();
  const chatsOfStage = new Map();
  for (const u of usage) {
    const k = u.agent_type || '(未知)';
    const acc = byStage.get(k) || { calls: 0, failed: 0, duration_ms: 0 };
    /**
     * 口徑對齊正式報表（token-report-routes.js 的 byAgent）：aborted（使用者按停止）與
     * interrupted（進程被外部信號終止，如重啟／OOM）是刻意／外部中斷、非執行失敗，
     * **分子分母都要排除**。
     *
     * ⚠ 只改分子是半套：failed 少算、calls 照算，失敗率就從原本的高報變成低報，兩張畫面的
     * 數字依然對不起來——而這兩個值擺在一起本來就只會被讀成「這關的失敗率」。
     * ⚠ 與上面 buildTaskSummary 的 per_stage.calls 刻意不同調：那個問的是「這關在這張任務上
     * 重跑了幾次」（彈跳訊號），被中斷的那一趟確實跑過也確實花了錢，該算進去。這裡問的是
     * 失敗率的分母，兩者不是同一個問題，別為了「一致」把它們統一掉。
     */
    // ⚠ 只跳過 calls／failed／duration 三個累加，不可整輪 `continue`：下面的 tasksOfStage／
    // chatsOfStage 是 repeat_avg 的分母，正式報表的 tasks 欄也沒有排除中斷的那幾筆。
    // 整輪跳過會讓「只被中斷過」的任務從分母消失，repeat_avg 反而被推高。
    if (!['aborted', 'interrupted'].includes(u.status)) {
      acc.calls += 1;
      acc.duration_ms += u.duration_ms || 0;
      if (u.status && u.status !== 'completed') acc.failed += 1;
    }
    byStage.set(k, acc);
    if (u.task_id) {
      if (!tasksOfStage.has(k)) tasksOfStage.set(k, new Set());
      tasksOfStage.get(k).add(u.task_id);
    }
    if (u.chat_id) {
      if (!chatsOfStage.has(k)) chatsOfStage.set(k, new Set());
      chatsOfStage.get(k).add(u.chat_id);
    }
  }
  const per_stage = Object.fromEntries([...byStage.entries()].map(([k, v]) => {
    const tasks = (tasksOfStage.get(k) || new Set()).size;
    const chats = (chatsOfStage.get(k) || new Set()).size;
    // repeat_avg＝calls÷「獨立會話數」。task-bound 關用 distinct task 當分母，讀作「同一任務重跑幾次」。
    // 但 chat／chat-to-task 這類非 task-bound 關 task_id 恆 null，用 max(1,tasks) 會讓分母塌成 1、
    // repeat_avg 直接等於 calls——把 N 場獨立對話偽裝成「同一任務重跑 N 次」，正是最強失敗訊號的形狀。
    // 這些關有 chat_id 可當正確分母；tasks 為 0 時改用 distinct chat，兩者皆無（如 workflow_health）
    // 就回 null 標 N/A，不與「重跑」同形。
    const denom = tasks || chats;
    const entry = {
      calls: v.calls, failed_calls: v.failed,
      avg_duration_ms: Math.round(v.duration_ms / Math.max(1, v.calls)),
      tasks,
      repeat_avg: denom ? Math.round((v.calls / denom) * 100) / 100 : null
    };
    // 分母來自對話而非任務時明講，免得「tasks:0 卻有 repeat_avg」自己又變成另一種誤導
    if (!tasks && chats) entry.chats = chats;
    // per_stage 的 key 就是 token_usage.agent_type，多閘門的 stage（respec 的 clarify-chat／
    // spec-review／respec-patch 都記成 respec）在這裡的 repeat_avg 含跨閘門呼叫，不是本關重跑。
    // 深診路徑早就標了這句，起手包沒標＝健檢先讀到的那份反而沒有警語。
    const mgNote = multiGateNote(k);
    if (mgNote) entry.note = mgNote;
    return [k, entry];
  }));

  // 窗內有動作的任務：帶關卡序列，讓 agent 一眼看得到震盪形狀（coding→qa→coding→qa）。
  // 已完成的任務用 `done_at` 選窗，不用 updated_at——updated_at 會被「不代表任務有進度」的系統維護
  // 動作刷新（cron 的自動封存曾如此，已移除；eService 同步等外部批次仍會碰，被刷過的舊時間戳也還
  // 留在 DB），靠它選窗會把三十天前就結案的任務算成「本輪發生的事」，下方 wall_clock 的 p90 因此誇大。
  // ⚠ 這個 CASE 只是**候選篩**，不是最終判定：done 卻沒有 done_at 的任務（客服結案這條路徑在
  // finding 176 之前一律不寫 done_at，既有列也沒回填）會掉進 ELSE 分支，又拿 updated_at 當完成
  // 時刻——原本要擋的東西整批從這個缺口回來。這些列在下面用 completionAt 重新判一次，SQL 這邊
  // 留寬是因為 pg-mem 不支援相關子查詢（rules/testing #14），查不了「最後一次 agent 呼叫」。
  // 進行中的任務（尚未 done 或 done_at 為 NULL）維持 updated_at，不變。
  const WINDOW_AT = "(CASE WHEN status = 'done' AND done_at IS NOT NULL THEN done_at ELSE updated_at END)";
  const { rows: candidates } = await query(
    `SELECT id, task_id, title, status, reentry_count, blocker_content, created_at, updated_at, done_at
       FROM tasks WHERE ${WINDOW_AT} >= $1${upTo(WINDOW_AT)} ORDER BY id`, args
  );
  // done 卻沒有 done_at 的候選：改用 token_usage 的最後一次 agent 呼叫當完成時刻重判進出窗。
  // 落在窗外的（被外部批次 touch 才混進來的窗前舊任務）剔除；連一次呼叫都查不到的也剔除——
  // 沒有可信完成時刻就不該算成「本輪完成」，但要記數回報，不能靜默消失。
  const lastAt = await lastCallMap([...new Set(
    candidates.filter(t => t.status === 'done' && !t.done_at && t.task_id).map(t => t.task_id)
  )]);
  const sinceMs = new Date(since).getTime();
  const untilMs = until ? new Date(until).getTime() : Infinity;
  let noCompletionTs = 0;
  const tasks = candidates.filter(t => {
    if (t.status !== 'done' || t.done_at) return true;      // SQL 已用 done_at／updated_at 判過
    const at = completionAt(t, lastAt);
    if (!at) { noCompletionTs += 1; return false; }
    const ms = new Date(at).getTime();
    return ms >= sinceMs && ms < untilMs;
  });
  const seqOf = new Map();
  for (const u of usage) {
    if (!u.task_id) continue;
    if (!seqOf.has(u.task_id)) seqOf.set(u.task_id, []);
    seqOf.get(u.task_id).push(u);
  }
  const task_rows = tasks.map(t => ({
    id: t.id, task_id: t.task_id, title: t.title, status: t.status,
    reentry: t.reentry_count || 0,
    sequence: toSequence(seqOf.get(t.task_id) || []),
    blocker: t.blocker_content ? String(t.blocker_content).replace(/\s+/g, ' ').slice(0, 200) : null
  }));

  const { rows: rej } = await query(
    `SELECT tr.task_id, tr.source, ri.category, ri.description
       FROM rejection_items ri JOIN task_rejections tr ON tr.id = ri.rejection_id
      WHERE tr.created_at >= $1${upTo('tr.created_at')} ORDER BY ri.id`, args
  ).catch(() => ({ rows: [] }));

  const chat_quality = await buildChatQuality(args, upTo);

  return {
    window: { since, until: until || new Date().toISOString() },
    volume: {
      agent_calls: usage.length,
      tasks_touched: tasks.length,
      cost_usd: Math.round((Number(cost.cost_usd) || 0) * 100) / 100,
      wall_clock: wallClock(tasks, lastAt),
      // done 卻查不到任何可信完成時刻、因此不計入本輪的張數。不回報的話這些張會靜默從視窗消失，
      // 而「樣本變少」跟「本來就少」在數字上長得一模一樣。
      tasks_no_completion_ts: noCompletionTs
    },
    per_stage,
    // 現況快照，不隨視窗上下界移動（「現在有沒有卡住」問的就是現在；趨勢比對只取 volume／per_stage，
    // 不會把這塊當成上一期的數字用）
    stuck_tasks: await buildStuckTasks(Date.now()),
    chat_quality,
    tasks: task_rows,
    rejections: rej.map(r => ({ task_id: r.task_id, source: r.source, category: r.category, description: r.description }))
  };
}

/**
 * chat 對話品質。健檢原本對 chat 只收 token／耗時／呼叫數，全是成本面——「答得好不好」
 * 完全沒有訊號，所以使用者實際感受到的「鬼打牆、廢話太多」健檢一律報平安（2026-09-05 回報）。
 *
 * 兩個指標都刻意選「不必讀懂內容就算得出來」的：
 * - ai_chars：AI 每則回覆的平均字數（絕對值）。這是「答得囉不囉嗦」現在的量尺。
 * - self_correct：AI 在自己的回覆裡承認上一輪判斷錯。這是「鬼打牆」唯一留得下痕跡的地方
 *   ——使用者用領域知識糾正、AI 才修，等於使用者在幫它除錯。
 *
 * ⚠ `verbosity_ratio_*`（AI 回覆長度 ÷ 使用者提問長度）已於 2026-09-22 廢用，保留只為不動既有
 * 測試與歷史對照，**不得再拿來判斷 AI 是否囉嗦**：分母由使用者決定，本平台使用者多為熟手、
 * 提問常只有十幾字，分母一小比值就衝高，於是「使用者問得精簡」被記成「AI 太囉嗦」。三輪自我
 * 證偽——p50 走 15.1→17.9→1.7、max 走 44.4→138.4→47.5→19.7，動的是分母不是 chat 品質
 * （2026-09-21 使用者回報）。所以 worst 的次鍵也改用 ai_chars，不再用比值。
 *
 * ⚠ self_correct 是**啟發式關鍵字比對**，不是語意判斷：會漏（換個說法就抓不到）、也會誤判
 * （正常的「你說的對」被算進去）。它的用途是「哪幾場值得人去看」，不是精確計數——
 * 拿它當提案的唯一證據不成立，要點進那場對話確認過才算。
 *
 * ⚠ 它只該記「AI 承認自己前面弄錯」。**「誠實標示推論限度」不是缺陷，不得計入**：裸的
 * 「不完全是／不完全正確」原本被算成一次自我更正，但那句話多半是 AI 在替結論加但書，或在
 * 部分否定使用者的前提，兩者都是好行為，卻足以把該場對話推上 worst 第一名（2026-09-21
 * 使用者回報 chat 142）。要判自我更正，句子得自己帶出「錯的是我前面說的東西」。
 *
 * ⚠ 長度、截斷、關鍵字比對全部在 JS 做，SQL 只負責把列撈出來：pg-mem 連 `length()` 與
 * `LEFT()` 都沒有（實測 `function length(text) does not exist`），寫進 SQL 會變成
 * 「正式環境對、測試整組跑不起來」。關鍵字也不能用 SQL 的 LIKE——它轉 regex 沒有 dotAll，
 * `%` 跨不了換行（rules/testing #13），而這些訊息全是多行的。
 * ⚠ 不要再把比對範圍截成「回覆開頭 N 字」。原本只掃前 120 字，是因為舊樣式含裸的「上一輪」，
 * 得靠截斷擋掉「我上一輪說的那個檔案」這種長文中段的正常引述（2026-09-07 使用者回報：寫在
 * 解釋之後的更正句一律掃不到）。正解是讓每個樣式自己帶足語境（主詞＋更正動詞，或整句更正措辭），
 * 誤判就不必靠位置擋，於是整則都能掃——「解釋一大段之後才說我剛剛講錯了」才算得到。
 */
// 每一條都必須自己站得住：裸關鍵字（如單獨的「上一輪」「抓錯」）會在技術長文裡到處命中。
const SELF_CORRECT_RE = new RegExp([
  '(?:先|我|要|想|得|需要)[^。！？\\n]{0,4}更正',                       // 先更正一個關鍵認知／我要更正
  '更正一(?:下|個|點)',
  '我[^。！？\\n]{0,12}(?:講錯|說錯|寫錯|填錯|弄錯|搞錯|搞混|判斷錯|理解錯|想錯|看錯|算錯|記錯|誤判|誤會|錯了|不對)',
  '(?:我|剛剛|剛才|先前|前面|上一輪)[^。！？\\n]{0,12}(?:漏(?:查|看|掉|列|寫|講|算)|只看了|沒(?:注意|考慮|檢查|查|想)到)',
  '之前都沒',                                                          // 「沒有，之前都沒排除」
  '你[^。！？\\n]{0,8}(?:是對的|說的對|說得對|講的對|講得對|沒說錯|沒錯)',  // 你這個顧慮是對的
  '你抓到(?:重點|關鍵|問題)',
  // 「不完全是／不完全正確」刻意不收：見上方「誠實標示推論限度不是缺陷」。真的在更正自己時，
  // 同一則裡會另有帶主詞的更正句（如「不完全是，我剛才漏查了 depends」）把它記到。
  '(?:上一輪|上一則|上一次|先前|前面那)[^。！？\\n]{0,10}(?:錯|有誤|不對|不成立|要改|收回|作廢)',
  // 「推翻」是中文裡最直白的更正措辭，卻兩次加寬都沒進來（2026-09-11 使用者回報：本輪兩場
  // 明確推翻自己前一輪結論的對話，全場零命中）。兩個方向都要：更正對象寫在前（我上一輪的結論
  // 要推翻）或寫在後（這推翻了我前面的判斷）。裸的「推翻」不收——「這個設計被實測推翻過」
  // 是在講別人的事，不是自我更正。
  '(?:我|剛剛|剛才|先前|前面|上一輪|上一則|上一次|原本)[^。！？\\n]{0,12}推翻',
  '推翻[^。！？\\n]{0,10}(?:我|自己|剛剛|剛才|先前|前面|上一輪|上一則|上一次|原本|之前)',
  // 「查得不夠仔細／不夠嚴謹」家族。動詞必須緊貼「不夠」（中間只容一個「得／的」），
  // 否則「我覺得這個測試不夠嚴謹」這種評論別人的句子會被算進來。
  '(?:我|剛剛|剛才|先前|前面|上一輪|上一則|上一次)[^。！？\\n]{0,10}' +
    '(?:查|看|想|做|驗證|檢查|分析|理解|判斷)(?:得|的)?不夠(?:仔細|嚴謹|完整|深入|周全|徹底|確實)',
  '抓錯(?![誤字])'                                                     // 排除「抓錯誤訊息」「抓錯字」
].join('|'));

// 掃整則，只留一個明顯高於實際回覆長度的上限控成本（實測 chat 回覆極少超過數千字）。
const SELF_CORRECT_SCAN_CHARS = 4000;

async function buildChatQuality(args, upTo) {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT m.chat_id, c.title, m.role, m.content
         FROM project_chat_messages m JOIN project_chats c ON c.id = m.chat_id
        WHERE m.created_at >= $1${upTo('m.created_at')} ORDER BY m.id`, args));
  } catch (err) {
    // 這一塊壞掉不該讓整輪健檢報廢，但也**不能靜默回零樣本**——那會跟「窗內真的沒對話」
    // 長得一模一樣，而健檢對零樣本的處置是「照實寫」，等於把一個故障講成正常。
    return { chats: 0, error: `chat_quality 查詢失敗：${err.message}` };
  }

  const byChat = new Map();
  for (const r of rows) {
    if (!byChat.has(r.chat_id)) {
      byChat.set(r.chat_id, { chat_id: r.chat_id, title: r.title, ai: [], user: [], self_correct: 0 });
    }
    const c = byChat.get(r.chat_id);
    const text = String(r.content || '');
    if (r.role === 'ai') {
      c.ai.push(text.length);
      if (SELF_CORRECT_RE.test(text.slice(0, SELF_CORRECT_SCAN_CHARS))) c.self_correct += 1;
    } else if (r.role === 'user') {
      c.user.push(text.length);
    }
  }

  // ⚠ 不能用 wallClock 裡那個 r1：它是那個函式的區域變數，在這裡是 undefined（會 ReferenceError）
  const r1 = (n) => Math.round(n * 10) / 10;
  const avg = (a) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0);
  // 只看「真的來回過」的對話：一問一答的單輪對話沒有鬼打牆可言，混進來會把中位數洗淡
  const chats = [...byChat.values()]
    .filter(c => c.ai.length >= 2 && c.user.length)
    .map(c => ({
      chat_id: c.chat_id,
      title: (c.title || '').slice(0, 40),
      ai_turns: c.ai.length,
      ai_chars: Math.round(avg(c.ai)),
      ratio: r1(avg(c.ai) / (avg(c.user) || 1)),
      self_correct: c.self_correct
    }));
  if (!chats.length) return { chats: 0, note: '窗內沒有來回兩輪以上的對話，這個區塊不成立（不是「都很好」）' };

  const ratios = chats.map(c => c.ratio).sort((a, b) => a - b);
  const aiChars = chats.map(c => c.ai_chars).sort((a, b) => a - b);
  return {
    chats: chats.length,
    ai_turns: chats.reduce((s, c) => s + c.ai_turns, 0),
    // 現行量尺：每場「AI 回覆平均字數」的分布。p50 而非平均——一場特別長的對話會把平均拉走
    ai_chars_p50: Math.round(pct(aiChars, 0.5)),
    ai_chars_max: aiChars[aiChars.length - 1],
    verbosity_ratio_p50: r1(pct(ratios, 0.5)),
    verbosity_ratio_max: ratios[ratios.length - 1],
    // 這段是寫給讀這包資料的健檢 AI 看的：它的提示詞裡還留著舊量尺與舊基線，而兩者現在都已
    // 不成立。量尺換掉卻沒人告知消費端，比不換更糟——會拿新數字去比舊基線。
    scale_note: '⚠ 量尺已於 2026-09-22 更正，以本段為準，不要沿用提示詞裡的舊基線：'
      + '(1) verbosity_ratio_* 已廢用——分母是使用者提問長度，量到的是使用者問得長不長，'
      + '本平台提問常只有十幾字，分母一小比值就衝高（三輪 p50 15.1→17.9→1.7 是分母在動，'
      + '不是 chat 品質在動）。判斷 AI 囉不囉嗦一律改看 ai_chars_*（AI 每則回覆平均字數，'
      + '與提問長度無關）；它沒有歷史基線，本輪起自行累積，不得拿 15.1／44.4 來比。'
      + '(2) self_correct 自同日起不再把「不完全是」這類標示推論限度的措辭算成缺陷，'
      + '數字比舊基線（34 場中 10 場、18 輪）低是定義變嚴，不是品質改善，兩者不可比。',
    self_correcting_chats: chats.filter(c => c.self_correct > 0).length,
    self_correct_turns: chats.reduce((s, c) => s + c.self_correct, 0),
    // 只給最差三場：這個區塊是要讓人「知道去看哪一場」，列滿只會把訊號淹掉。
    // 次鍵是 ai_chars 不是 ratio——用比值排等於把「提問最精簡的使用者」排到最前面。
    worst: chats.sort((a, b) => (b.self_correct - a.self_correct) || (b.ai_chars - a.ai_chars)).slice(0, 3)
  };
}

module.exports = { buildAgentSummary, buildTaskSummary, buildWindowSummary };
