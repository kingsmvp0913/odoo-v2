const { query } = require('../db');
const { costSql } = require('./token-cost');

function validTaskBudgetUsd(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value)
    && value >= 0.01 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);
}

// 只依任務建立者所屬公司決定上限；重跑按鈕是誰按的、專案綁了哪幾家公司都不改歸屬。
async function remainingTaskBudget(taskDbId) {
  const { rows: [owner] } = await query(
    `SELECT t.task_id, c.is_internal, c.task_budget_usd
       FROM tasks t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN companies c ON c.id = u.company_id
      WHERE t.id = $1`, [taskDbId]
  );
  if (!owner || owner.is_internal || owner.task_budget_usd == null) return null;
  const limit = Number(owner.task_budget_usd);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('公司任務花費上限設定無效，請公司管理員重新設定');

  const { cost } = costSql();
  const { rows: [usage] } = await query(
    `SELECT COALESCE(SUM(${cost}), 0) AS spent FROM token_usage WHERE task_id = $1`,
    [owner.task_id]
  );
  const spent = Number(usage?.spent) || 0;
  if (spent >= limit) {
    const err = new Error(`這張任務已達花費上限（已花約 $${spent.toFixed(2)}／上限 $${limit.toFixed(2)}）。請公司管理員提高上限後再按繼續。`);
    err.code = 'TASK_BUDGET_EXCEEDED';
    throw err;
  }
  return limit - spent;
}

module.exports = { remainingTaskBudget, validTaskBudgetUsd };
