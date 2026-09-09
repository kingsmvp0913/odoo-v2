// 自動部署開關：每個專案自己一顆（projects.auto_deploy_enabled）。
//
// 刻意每次都查 DB，不快取：平台是常駐進程，值一旦被快取在模組變數，使用者關掉開關後
// 要重啟 server 才生效，症狀是「我明明關了它還在部署」——這種靜默失效最難查。
// 一次 SELECT 的成本相對於「連進客戶正式機下指令」可以忽略。
const { query } = require('../db');

async function isAutoDeployEnabled(projectId) {
  if (!projectId) return false;
  const { rows } = await query('SELECT auto_deploy_enabled FROM projects WHERE id = $1', [projectId]);
  // 專案不存在＝關閉，不是錯誤
  return !!(rows[0] && rows[0].auto_deploy_enabled);
}

// 掛在每一支部署相關端點上。前端隱藏分頁不是授權——使用者照樣打得到 API。
// 專案 id 一律取自路由參數（這些端點全都是 /api/projects/:id/... 形式）。
async function requireAutoDeploy(req, res, next) {
  try {
    if (!await isAutoDeployEnabled(req.params && req.params.id)) {
      return res.status(403).json({ error: '此專案未啟用自動部署（可在專案設定開啟）' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { isAutoDeployEnabled, requireAutoDeploy };
