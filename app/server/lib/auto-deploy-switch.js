// 自動部署總開關。
//
// 刻意每次都查 DB，不快取：平台是常駐進程，值一旦被快取在模組變數，使用者關掉開關後
// 要重啟 server 才生效，症狀是「我明明關了它還在部署」——這種靜默失效最難查。
// 一次 SELECT 的成本相對於「連進客戶正式機下指令」可以忽略。
const { query } = require('../db');

async function isAutoDeployEnabled() {
  const { rows } = await query('SELECT auto_deploy_enabled FROM teams_settings WHERE id = 1');
  // 整列不存在（全新安裝、尚未存過設定）＝關閉，不是錯誤
  return !!(rows[0] && rows[0].auto_deploy_enabled);
}

// 掛在每一支部署相關端點上。前端隱藏分頁不是授權——使用者照樣打得到 API。
async function requireAutoDeploy(req, res, next) {
  try {
    if (!await isAutoDeployEnabled()) {
      return res.status(403).json({ error: '自動部署已停用（可在管理設定開啟）' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { isAutoDeployEnabled, requireAutoDeploy };
