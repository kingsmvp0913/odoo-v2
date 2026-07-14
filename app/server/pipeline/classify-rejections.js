const { query } = require('../db');
const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');

const CATEGORIES = new Set(['實作錯誤', '規格誤解', '需求變更', 'UI體驗', '效能', '其他']);
const BATCH = parseInt(process.env.REJECT_CLASSIFY_BATCH || '3', 10);

// cron 慢慢整理（工作流程健檢子專案 1）：每 tick 撈一小批 status='new' 的退回，跑分類 agent
// 把 raw 原因拆成多個 rejection_items。解析失敗標 error（留痕、不無限重試燒 token）。
// best-effort：單筆錯誤不影響其他退回，函式錯誤不影響其他 cron 工作。無 new 即早退、成本近零。
async function classifyPendingRejections() {
  const { rows } = await query(
    "SELECT id, task_id, project_id, user_id, reason FROM task_rejections WHERE status='new' ORDER BY id LIMIT $1",
    [BATCH]
  );
  for (const rej of rows) await classifyOne(rej);
  return rows.length;
}

async function classifyOne(rej) {
  const agent = loadAgent('reject-classifier');
  let items = null;
  try {
    const { text, usage, durationMs } = await runClaude(agent.render({ reason: rej.reason }), { model: agent.model, agentType: 'reject_classify' });
    await logTokenUsage({ taskId: rej.task_id, projectId: rej.project_id }, rej.user_id, 'reject_classify', usage, durationMs);
    const parsed = await parseAgentResult(text, { parse: JSON.parse, ref: { taskId: rej.task_id, projectId: rej.project_id }, userId: rej.user_id });
    // 空陣列是合法結果（agent 判定無可拆項目）→ 視為已分類（零項目），不落 error
    if (Array.isArray(parsed)) items = parsed;
  } catch (err) {
    await logFailedUsage({ taskId: rej.task_id, projectId: rej.project_id }, rej.user_id, 'reject_classify', err);
  }
  if (!items) {
    await query("UPDATE task_rejections SET status='error' WHERE id=$1", [rej.id]).catch(() => {});
    return;
  }
  for (const it of items) {
    const description = String((it && it.description) || '').trim();
    if (!description) continue;
    const category = CATEGORIES.has(it && it.category) ? it.category : '其他';
    await query(
      "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,$2,$3)",
      [rej.id, description, category]
    ).catch(() => {});
  }
  await query("UPDATE task_rejections SET status='classified' WHERE id=$1", [rej.id]);
}

module.exports = { classifyPendingRejections };
