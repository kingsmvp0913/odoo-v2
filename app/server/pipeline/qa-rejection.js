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

module.exports = { parseQaIssues, QA_CATEGORIES, DEFAULT_CATEGORY };
