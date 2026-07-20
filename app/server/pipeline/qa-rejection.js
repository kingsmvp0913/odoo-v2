/**
 * qa-rejection.js — QA 自動退回的根因解析與落地。
 * parseQaIssues：把 QA 結果的 issues 正規化為帶根因 category 的分項（向下相容純字串）。
 * recordQaRejection：把一次 QA 退回寫進 task_rejections(source='qa') + rejection_items。
 */
const { query } = require('../db');

const QA_CATEGORIES = new Set(['spec_unclear', 'impl_miss', 'env_flaky']);
const DEFAULT_CATEGORY = 'impl_miss';

// 回 { items:[{desc,category}], list:[desc], summary } 或 null（無任何細節）
function parseQaIssues(result) {
  const rawList = Array.isArray(result?.issues) ? result.issues : [];
  const items = rawList.map(it => {
    if (it && typeof it === 'object') {
      const desc = String(it.desc ?? '').trim();
      const category = QA_CATEGORIES.has(it.category) ? it.category : DEFAULT_CATEGORY;
      return desc ? { desc, category } : null;
    }
    const desc = String(it ?? '').trim();
    return desc ? { desc, category: DEFAULT_CATEGORY } : null;
  }).filter(Boolean);
  const summary = String(result?.summary ?? '').trim();
  return (items.length || summary) ? { items, list: items.map(i => i.desc), summary } : null;
}

async function recordQaRejection(task, items, summary) {
  if (!Array.isArray(items) || items.length === 0) return;
  const { rows: [tr] } = await query(
    `INSERT INTO task_rejections (task_id, project_id, user_id, reason, status, source)
     VALUES ($1, $2, $3, $4, 'classified', 'qa') RETURNING id`,
    [task.task_id, task.project_id ?? null, task.user_id ?? null, String(summary || '').slice(0, 2000)]
  );
  for (const it of items) {
    await query(
      'INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1, $2, $3)',
      [tr.id, it.desc, it.category]
    );
  }
}

module.exports = { parseQaIssues, recordQaRejection, QA_CATEGORIES, DEFAULT_CATEGORY };
