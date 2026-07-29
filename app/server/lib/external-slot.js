const { query } = require('../db');

// 對外子網域名額（slot）採租約制：真人要看某測試區時才借、看完或閒置就還。
// 與內部埠池（port-alloc.js）刻意分開——兩者量的是不同的東西：
//   內部埠 = 同時有幾個 Odoo 容器活著（pipeline 的 deploy/E2E 也算）
//   對外 slot = 同時有幾個人在用瀏覽器看
// 綁在一起的話，pipeline 併發跑幾十個環境就會把對外名額吃光，正是本次要消除的問題。
const DEFAULT_SLOT_COUNT = 10;

// 對外閒置門檻。比內部埠的背景回收（ENV_IDLE_TIMEOUT_MIN，預設 60）短很多：
// 對外名額稀缺（受手動 DNS/憑證成本限制），且「人離開分頁」比「環境該不該停」該更早判定。
const DEFAULT_IDLE_MIN = 20;

function slotCount() {
  return parseInt(process.env.EXTERNAL_SLOT_COUNT || String(DEFAULT_SLOT_COUNT), 10);
}

function idleMinutes() {
  return parseInt(process.env.EXTERNAL_IDLE_MIN || String(DEFAULT_IDLE_MIN), 10);
}

// 把 slot 寫進該專案的租約列。抽成可注入的一步，讓「撞 UNIQUE 要重取」這條路徑能被單測驗證
// （pg-mem 不支援 partial unique index，沿用 port-alloc.claimPort 的既有做法）。
//
// 一併把 last_active_at 推到現在：借 slot 這個動作本身就是「有人要看」的證據。不寫的話會
// 沿用上一輪容器 log 解析出的舊值，剛借出的名額可能在下一輪 sweep 就被當成閒置收回。
async function claimSlot(projectId, slot) {
  await query(
    'UPDATE odoo_envs SET external_slot=$2, last_active_at=NOW(), updated_at=NOW() WHERE project_id=$1',
    [projectId, slot]
  );
  return true;
}

// 掃一輪名額，找到就借。回 null 表示這輪全滿。
async function _tryAcquire(projectId, claim, count) {
  const { rows } = await query('SELECT external_slot FROM odoo_envs WHERE external_slot IS NOT NULL');
  const used = new Set(rows.map(r => r.external_slot));
  for (let s = 0; s < count; s++) {
    if (used.has(s)) continue;
    try {
      await claim(projectId, s);
      return s;
    } catch (err) {
      if (err.code === '23505') continue; // 併發搶同 slot：換下一個
      throw err;
    }
  }
  return null;
}

// 找一個可徵收的對外名額。條件只有「閒置夠久」一條——對外 slot 只有真人在看時才持有，
// pipeline 從不持有，故不需要像內部埠那樣排除進行中的任務。多個候選挑閒最久的。
async function findReclaimableSlot(deps = {}) {
  const idleMin = deps.idleMin ?? idleMinutes();
  const { rows } = await query(
    `SELECT project_id FROM odoo_envs
      WHERE external_slot IS NOT NULL
        AND COALESCE(last_active_at, updated_at) < NOW() - ($1 || ' minutes')::interval
      ORDER BY COALESCE(last_active_at, updated_at) ASC
      LIMIT 1`,
    [String(idleMin)]
  );
  return rows[0] || null;
}

// 借一個對外名額給該專案，回傳 slot 數字。
// 已持有者直接回原 slot——重複點「開啟測試區」若換號，使用者已經開著的分頁會指向別人的環境。
// 池滿時徵收一個對外閒置最久的讓位（只收名額，環境本身照跑，pipeline 不受影響）。
// 徵收只做一輪：做成迴圈的話尖峰時會連環踢人，體感是「我開的分頁一直被別人搶走」。
async function acquireExternalSlot(projectId, deps = {}) {
  const claim = deps.claim || claimSlot;
  const count = deps.count ?? slotCount();

  const { rows: [cur] } = await query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (cur && cur.external_slot != null) {
    await claim(projectId, cur.external_slot); // 續約：順帶刷新 last_active_at
    return cur.external_slot;
  }

  const first = await _tryAcquire(projectId, claim, count);
  if (first != null) return first;

  const victim = await findReclaimableSlot(deps);
  if (victim) {
    await releaseExternalSlot(victim.project_id);
    const second = await _tryAcquire(projectId, claim, count);
    if (second != null) return second;
  }

  throw new Error(`對外檢視名額已滿（${count} 個）且無閒置可回收，請稍後再試或請管理員擴充`);
}

// 歸還名額。明確關閉、環境停機、夜間關機、閒置回收皆須呼叫，否則池子會單向耗盡。
async function releaseExternalSlot(projectId) {
  await query('UPDATE odoo_envs SET external_slot=NULL, updated_at=NOW() WHERE project_id=$1', [projectId]);
}

module.exports = {
  acquireExternalSlot, releaseExternalSlot, findReclaimableSlot,
  slotCount, idleMinutes, DEFAULT_SLOT_COUNT, DEFAULT_IDLE_MIN,
};
