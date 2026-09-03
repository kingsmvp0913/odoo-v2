/**
 * maintenance.js — 夜間批次期間暫停同步與派工
 *
 * ⚠ 用「到期時間」而不是布林旗標。批次中途拋錯、平台被 kill、或重啟時機不對，
 * 布林值會卡在 true 而**派工從此安靜地停擺**——而安靜的失敗最難發現
 * （此 repo 踩過：夜班空轉 98 輪無人察覺）。三道保險：
 *   1. 進場寫到期時間，過期自動失效
 *   2. 批次的 finally 一定清
 *   3. index.js 啟動清一次（比照既有的 clearInterruptedUpgrades）
 */
const { query } = require('../db');

const DEFAULT_MS = parseInt(process.env.NIGHTLY_FIX_MAINTENANCE_MS || '14400000', 10);

async function enterMaintenance(ms = DEFAULT_MS) {
  await query(
    `INSERT INTO teams_settings (id, maintenance_until) VALUES (1, NOW() + ($1 || ' milliseconds')::interval)
       ON CONFLICT (id) DO UPDATE SET maintenance_until = NOW() + ($1 || ' milliseconds')::interval`,
    [String(ms)]);
}

async function leaveMaintenance() {
  await query('UPDATE teams_settings SET maintenance_until = NULL WHERE id = 1');
}

async function isMaintenance() {
  try {
    // 別名不可用 `on`：pg-mem 的 SQL parser 把它當保留字（JOIN ... ON），會直接拋 parse error。
    const { rows } = await query(
      'SELECT maintenance_until > NOW() AS is_active FROM teams_settings WHERE id = 1');
    return !!(rows[0] && rows[0].is_active);
  } catch { return false; }   // 查不到就當沒在維護：寧可多派工，也不要因為查詢失敗而全站停擺
}

module.exports = { enterMaintenance, leaveMaintenance, isMaintenance };
