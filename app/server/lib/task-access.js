const { query } = require('../db');

// 回傳指定任務列，僅當請求者是該任務 owner 或 admin；否則 null。
// columns 預設 '*'；呼叫端若指定欄位清單，務必包含 user_id（觸發 pipeline 用）。
async function loadTaskForActor(taskId, req, columns = '*') {
  const { rows } = await query(
    `SELECT ${columns} FROM tasks WHERE id = $1 AND (user_id = $2 OR $3 = true)`,
    [taskId, req.userId, !!req.isAdmin]
  );
  return rows[0] || null;
}

module.exports = { loadTaskForActor };
