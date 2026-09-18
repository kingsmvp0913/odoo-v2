const { query } = require('../db');
const { canSeeProject } = require('./tenant-access');

// 回傳指定任務列，僅當請求者是該任務 owner 或 admin，且（若任務屬於某專案）看得到那個專案。
// columns 預設 '*'；呼叫端若指定欄位清單，務必包含 user_id（觸發 pipeline 用）。
//
// 租戶邊界為什麼加在這裡（規格 §5.2）：這支是 pipeline-routes 與 tasks-routes
// 全部關卡端點的共同入口，接在這裡等於整條 pipeline 一次有了邊界。
// 專案條件刻意不塞進 SQL——tasks.project_id 可以是 NULL（非專案任務），
// 塞進 JOIN 會讓那些任務全部查不到。
async function loadTaskForActor(taskId, req, columns = '*') {
  // 多撈 project_id 才判斷得了；呼叫端常常只挑幾欄(例 'id, status')。
  // 已經帶了就不要再加——重複欄位在真 PG 合法但 pg-mem 會出狀況。
  const hasProjectId = /(^|[\s,])project_id([\s,]|$)/.test(columns);
  const cols = columns === '*' || hasProjectId ? columns : `${columns}, project_id`;
  const { rows } = await query(
    `SELECT ${cols} FROM tasks WHERE id = $1 AND (user_id = $2 OR $3 = true)`,
    [taskId, req.userId, !!req.isAdmin]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.project_id && !await canSeeProject(req.actor, row.project_id)) return null;
  return row;
}

module.exports = { loadTaskForActor };
