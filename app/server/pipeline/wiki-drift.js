const { query } = require('../db');
const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');

// 「wiki 頁與程式碼漂移」回報。chat／cs 為回答而讀了程式碼、發現某 wiki 頁描述與程式碼矛盾（頁錯、碼對）時，
// 於回覆末端附選用的 <wiki-drift> 側通道；這裡負責 (1) 抽出並驗證、(2) 入佇列（status='new'）、
// (3) cron 慢慢跑分類 agent 補 category。全部只「回報」——正典文件的修正走 ⟳ 重生／人工，不在此自動改。
// 設計刻意仿 classify-rejections：入列輕、分類在背景，供健檢像讀 rejection_items 一樣分組彙整。

const CATEGORIES = new Set(['缺漏', '過時', '錯誤', '用詞', '其他']);
const BATCH = parseInt(process.env.WIKI_DRIFT_CLASSIFY_BATCH || '3', 10);

// 從 agent 輸出取出選用的 <wiki-drift> 側通道。回 { entry, cleaned }：entry 為 { slug, reason } 或 null
// （reason 必填、slug 可空）；cleaned 為移除該區塊後的文字。缺／解析失敗＝沒回報，靜默略過。
function extractDriftBlock(text) {
  const { inner, cleaned } = extractTaggedBlock(text, 'wiki-drift');
  let entry = null;
  if (inner != null) {
    try {
      const o = JSON.parse(inner);
      const reason = String((o && o.reason) || '').trim();
      if (reason) entry = { slug: o.slug ? String(o.slug).trim() : null, reason };
    } catch { /* 側通道壞掉不影響主回覆 */ }
  }
  return { entry, cleaned };
}

// 入佇列一筆漂移回報。呼叫端須自行 try/catch，入列失敗不得中斷對話回覆。回 id 或 null（缺專案／缺 reason）。
async function enqueueWikiDrift({ projectId, taskId, userId, source, slug, reason }) {
  if (!projectId || !reason) return null;
  const { rows: [row] } = await query(
    `INSERT INTO wiki_drift (project_id, task_id, user_id, source, slug, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [projectId, taskId || null, userId || null, source || 'chat', slug || null, reason]
  );
  return row.id;
}

// cron 每 tick 撈一小批 status='new' 跑分類 agent 補 category。解析失敗標 error（留痕、不無限重試燒 token）。
// best-effort：單筆錯誤不影響其他筆，函式錯誤不影響其他 cron 工作。無 new 即早退、成本近零。
async function classifyPendingWikiDrift() {
  const { rows } = await query(
    "SELECT id, task_id, project_id, user_id, slug, reason FROM wiki_drift WHERE status='new' ORDER BY id LIMIT $1",
    [BATCH]
  );
  for (const d of rows) await classifyOne(d);
  return rows.length;
}

async function classifyOne(d) {
  const agent = loadAgent('wiki-drift-classifier');
  let category = null;
  try {
    const { text, usage, durationMs } = await runClaude(
      agent.render({ slug: d.slug || '（未指定）', reason: d.reason }),
      { model: agent.model, agentType: 'wiki_drift_classify' }
    );
    await logTokenUsage({ taskId: d.task_id, projectId: d.project_id }, d.user_id, 'wiki_drift_classify', usage, durationMs);
    const parsed = await parseAgentResult(text, { parse: JSON.parse, ref: { taskId: d.task_id, projectId: d.project_id }, userId: d.user_id });
    if (parsed && typeof parsed.category === 'string') category = parsed.category;
  } catch (err) {
    await logFailedUsage({ taskId: d.task_id, projectId: d.project_id }, d.user_id, 'wiki_drift_classify', err);
  }
  if (!category) {
    await query("UPDATE wiki_drift SET status='error' WHERE id=$1", [d.id]).catch(() => {});
    return;
  }
  if (!CATEGORIES.has(category)) category = '其他';
  await query("UPDATE wiki_drift SET category=$2, status='classified' WHERE id=$1", [d.id, category]);
}

module.exports = { extractDriftBlock, enqueueWikiDrift, classifyPendingWikiDrift };
