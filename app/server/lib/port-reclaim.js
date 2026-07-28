const { query } = require('../db');

// 有人在等埠時，閒置多久就該讓位。比背景回收門檻（ENV_IDLE_TIMEOUT_MIN，預設 60）短：
// 沒人等就別打擾使用者，有人等才積極徵收。
const PRESSURE_MIN = parseInt(process.env.ENV_IDLE_TIMEOUT_PRESSURE_MIN || '15', 10);

// 找一個可徵收的測試區（池滿時讓位用）。三個條件缺一不可：
//   1. status='running'（idle 的本來就沒佔埠）
//   2. 閒置 ≥ PRESSURE_MIN（last_active_at 為 NULL 時退回 updated_at＝最後一次狀態變動）
//   3. 該專案沒有進行中的 pipeline 任務——正在跑的 deploy/E2E 被腰斬會被誤歸因為程式問題
// 多個候選時挑閒最久的。回 null 表示無可徵收，呼叫端據此決定排隊或報錯。
async function findReclaimable(deps = {}) {
  const pressureMin = deps.pressureMin ?? PRESSURE_MIN;
  const { rows } = await query(
    `SELECT e.project_id
       FROM odoo_envs e
      WHERE e.status='running'
        AND e.port IS NOT NULL
        AND COALESCE(e.last_active_at, e.updated_at) < NOW() - ($1 || ' minutes')::interval
        AND e.project_id NOT IN (
          SELECT t.project_id FROM tasks t
           WHERE t.status IN ('deploy_testing','playwright_running')
             AND t.is_paused = false AND t.is_hidden = false
             -- 未綁專案的任務其 project_id 為 NULL；NOT IN 的清單只要含 NULL，
             -- 整個條件就恆為 UNKNOWN、一筆都選不出來＝徵收靜默失效，故必須先濾掉。
             AND t.project_id IS NOT NULL
        )
      ORDER BY COALESCE(e.last_active_at, e.updated_at) ASC
      LIMIT 1`,
    [String(pressureMin)]
  );
  return rows[0] || null;
}

module.exports = { findReclaimable, PRESSURE_MIN };
