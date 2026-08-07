const { query } = require('../db');

// 對外子網域名額（slot）採租約制：真人要看某測試區時才借、看完或閒置就還。
// 與內部埠池（port-alloc.js）刻意分開——兩者量的是不同的東西：
//   內部埠 = 同時有幾個 Odoo 容器活著（pipeline 的 deploy/E2E 也算）
//   對外 slot = 同時有幾個人在用瀏覽器看
// 綁在一起的話，pipeline 併發跑幾十個環境就會把對外名額吃光，正是本次要消除的問題。
const DEFAULT_SLOT_COUNT = 10;

// 對外閒置門檻。0 = 停用背景回收（2026-08-07 預設值，與 ENV_IDLE_TIMEOUT_MIN 同一套政策）。
// 原本 20 分鐘是「對外名額稀缺就該早點收」的推論，但名額有 10 個、專案只有 8 個，稀缺並未發生；
// 代價卻是使用者開著測試區分頁去開個會，回來網址就失效——這是真人實際感受到的「一直中斷」之一。
// 真的搶不到名額時 acquireExternalSlot 會走 findReclaimableSlot 當場徵收最閒的那個（那才是「有人
// 在等」的當下），沒搶手時則留到 nightlyShutdown 一併歸還（其 UPDATE 已含 external_slot=NULL）。
const DEFAULT_IDLE_MIN = 0;

function slotCount() {
  return parseInt(process.env.EXTERNAL_SLOT_COUNT || String(DEFAULT_SLOT_COUNT), 10);
}

function idleMinutes() {
  return parseInt(process.env.EXTERNAL_IDLE_MIN || String(DEFAULT_IDLE_MIN), 10);
}

// 池滿徵收門檻，與背景回收（idleMinutes）刻意分開：背景回收可以整個停用，徵收不行。
// 兩者共用同一個值的話，把背景回收設成 0（停用）會讓 findReclaimableSlot 的條件退化成
// 「閒置 > 0 分鐘」＝幾乎恆真，池滿時就會把正在操作的人踢掉——停用主動回收反而更常中斷。
// 讀 ENV_IDLE_TIMEOUT_PRESSURE_MIN 與內部埠的 port-reclaim 同步：「有人在等資源時，閒置
// 多久算可讓位」是同一個問題，不該有兩個答案。
const DEFAULT_PRESSURE_IDLE_MIN = 15;

function pressureIdleMinutes() {
  return parseInt(process.env.ENV_IDLE_TIMEOUT_PRESSURE_MIN || String(DEFAULT_PRESSURE_IDLE_MIN), 10);
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
// 用的是徵收門檻（pressureIdleMinutes）而非背景回收門檻：這裡是「池子真的滿了、有人在等」
// 的當下，與背景無差別掃描是兩件事。
async function findReclaimableSlot(deps = {}) {
  const idleMin = deps.idleMin ?? pressureIdleMinutes();
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
  slotCount, idleMinutes, pressureIdleMinutes,
  DEFAULT_SLOT_COUNT, DEFAULT_IDLE_MIN, DEFAULT_PRESSURE_IDLE_MIN,
};
