const { query } = require('../db');
const { refreshWikiNode } = require('./library-agent');
const { projectLabel } = require('../lib/project-ref');

// 獨立 runner：把已分類的「wiki 頁與程式碼漂移」回報，套用成「從程式碼重生該頁」的安全更新。
// 刻意獨立於 wiki-drift.js（回報／分類）與 cron（排程）：這裡只做「動作面」——決定哪些頁要重生、去重、標記。
// 更新來源是程式碼（refreshWikiNode 重推），不是對話 prose，故正典可信度不受 chat/cs 即時推論影響。
// 由 cron 一小時呼叫一次；也可獨立被 admin／手動觸發。

const DEDUP_DAYS = parseInt(process.env.WIKI_DRIFT_APPLY_DEDUP_DAYS || '7', 10);

// 撈已分類、尚未套用、且指到具體頁的漂移；同一頁只重生一次，且最近 DEDUP_DAYS 內已因漂移重生過就不再重生
//（＝重複的錯誤不重更新 wiki）。回實際觸發重生的頁數。best-effort：單頁失敗不卡佇列，標記已處理免無限重試。
async function applyPendingWikiDrift() {
  const { rows } = await query(
    "SELECT id, project_id, slug, user_id FROM wiki_drift " +
    "WHERE status='classified' AND applied_at IS NULL AND slug IS NOT NULL AND slug <> '' ORDER BY id"
  );
  if (!rows.length) return 0;

  // 同一 (project, slug) 收斂成一組：一輪內多筆重複回報只重生一次
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.project_id}\u0000${r.slug}`;
    if (!groups.has(key)) groups.set(key, { project_id: r.project_id, slug: r.slug, user_id: r.user_id });
  }

  const cutoff = new Date(Date.now() - DEDUP_DAYS * 86400000).toISOString();
  let refreshed = 0;
  for (const g of groups.values()) {
    // 跨輪去重：這一頁最近 DEDUP_DAYS 內已因漂移重生過 → 不重複更新，只把這批標成已處理
    const { rows: [recent] } = await query(
      "SELECT id FROM wiki_drift WHERE project_id=$1 AND slug=$2 AND applied_at IS NOT NULL AND applied_at > $3 LIMIT 1",
      [g.project_id, g.slug, cutoff]
    );
    if (!recent) {
      try {
        await refreshWikiNode(g.project_id, g.slug, g.user_id || null);
        refreshed++;
      } catch (err) {
        // 頁不存在(404)／不可重生(400)／生成失敗(500)：不卡佇列，標記已處理並留痕，不無限重試
        console.error(`[WIKI-DRIFT-RUNNER] 自動重生失敗 專案「${await projectLabel(g.project_id)}」 slug ${g.slug}:`, err.message);
      }
    }
    // 標記這一頁本輪所有待處理回報為已套用（等同上面選到的那一組，免陣列參數）
    await query(
      "UPDATE wiki_drift SET applied_at=NOW() WHERE project_id=$1 AND slug=$2 AND status='classified' AND applied_at IS NULL",
      [g.project_id, g.slug]
    );
  }
  return refreshed;
}

module.exports = { applyPendingWikiDrift };
