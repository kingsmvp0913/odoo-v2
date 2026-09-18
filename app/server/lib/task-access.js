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
  // row 真的帶 project_id 屬性才能信任它的值：呼叫端的欄位清單可能把 project_id 取了別名
  // （例如 'id, project_id as pid'），上面的 regex 會誤判「已包含」而不補欄位，實際回傳的
  // row 只有 pid、沒有 project_id，此時 row.project_id 是 undefined——不能因此當作「這任務
  // 沒有 project_id」而放行（fail-open 是租戶檢查最不該有的方向），要另外查一次真正的值。
  let projectId = row.project_id;
  if (!('project_id' in row)) {
    const { rows: pidRows } = await query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    projectId = pidRows[0] ? pidRows[0].project_id : null;
  }
  if (projectId && !await canSeeProject(req.actor, projectId)) return null;
  return row;
}

module.exports = { loadTaskForActor };
