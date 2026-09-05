const { execFile } = require('child_process');
const { query } = require('../db');
const { MACHINE_RETIRE_PREFIX } = require('./retire-prefix');
const { AUTO_LAYERS, HEALTH_SEVERITIES, inAutoFixScope, normalizeLayer } = require('./auto-fix-scope');
const { enterMaintenance, leaveMaintenance, isMaintenance } = require('./maintenance');
const { triageOne, mergeCandidates } = require('./feedback-triage');
const { reviewFix } = require('./fix-review');
const { runFix, adoptFix, applyFix, selfContainerName } = require('./finding-fix');

/**
 * nightly-fix.js — 夜間批次編排器：意見回饋通道的核心。
 *
 * 進維護視窗 → 等在飛任務排空 → 撈候選（意見回饋 approved ＋ 健檢提案 approved）→ triage →
 * 統整 → 逐條走完整條鏈（runFix → fix-review → adopt → applyFix 只合併）→ 標 done →
 * 全部跑完才重啟一次。
 *
 * ⚠ 這是「平台自己改自己」的最後一段自動化。它最可能的失敗方式不是炸掉，而是**安靜地什麼都
 * 沒做**——保險絲誤擋、候選撈不到、每條都失敗，畫面上全都長得跟「今晚本來就沒事做」一模一樣
 * （此 repo 踩過：夜班空轉 98 輪無人察覺）。所以每一道擋下候選的決定都要留 log。
 */

const NIGHTLY_FIX_MAX = parseInt(process.env.NIGHTLY_FIX_MAX || '5', 10);
const NIGHTLY_FIX_MAX_RETRY = parseInt(process.env.NIGHTLY_FIX_MAX_RETRY || '1', 10);
const NIGHTLY_FIX_DEADLINE_HOUR = parseInt(process.env.NIGHTLY_FIX_DEADLINE_HOUR || '2', 10);
const NIGHTLY_FIX_TOKEN_BUDGET = parseInt(process.env.NIGHTLY_FIX_TOKEN_BUDGET || '12000000', 10);
const NIGHTLY_FIX_DRAIN_MAX_MS = parseInt(process.env.NIGHTLY_FIX_DRAIN_MAX_MS || '1800000', 10);
const DRAIN_POLL_MS = parseInt(process.env.NIGHTLY_FIX_DRAIN_POLL_MS || '60000', 10);
// 單一批次的跑道上限。截止時刻是「下一個台北 02:00」，對 23:00 起跑的排程＝3 小時；但**手動**
// 在白天觸發時，同一個算法會給出 16 小時（10:00 起跑）甚至 24 小時（剛好 02:00 起跑）的跑道，
// 保險絲等於不存在。與維護視窗的自動到期同量級（4 小時），對自動排程完全無感。
const NIGHTLY_FIX_MAX_RUNWAY_MS = parseInt(process.env.NIGHTLY_FIX_MAX_RUNWAY_MS || '14400000', 10);
// 同一條連續失敗幾次就退回人工（見 noteFailedAttempt／retireToHuman）
const NIGHTLY_FIX_MAX_ATTEMPTS = parseInt(process.env.NIGHTLY_FIX_MAX_ATTEMPTS || '3', 10);
const TIME_ZONE = 'Asia/Taipei';
// 本批次自建的 health_check_runs 用 window_days=0 表示「不是回看某個視窗的健檢，是這一晚的修正批次」。
const BATCH_WINDOW_DAYS = 0;
// 批次列的辨識機制：health_check_runs.cadence 沿用既有欄位（daily／weekly／monthly 已在用），
// 不新增欄位。⚠ 這個值要與 health-check-runner.js 的 resumeInterruptedRuns／auditWindowStart
// 保持字面一致——那兩處刻意不 require 本檔（避免與 health-check-runner.js 形成循環依賴，
// 見 retire-prefix.js 的檔頭說明），只能各自寫死同一個字串常數。
const BATCH_CADENCE = 'nightly-fix';

// 可自動修的 layer；健檢候選的嚴重度門檻（AUTO_LAYERS／HEALTH_SEVERITIES 定義於 auto-fix-scope.js，
// health-check-runner.js 的 insertFinding 共用同一份判準——見該檔 2-I2 的說明）。
// 意見回饋不套嚴重度——人親自核准過就是把關。

let _clockForTesting = null;
function _setClockForTesting(clock) { _clockForTesting = clock; }
function now() { return _clockForTesting ? _clockForTesting() : new Date(); }

// 比照 cron.js 的 taipeiDateParts
function taipeiDateParts(d) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  // 24 是 en-US 對午夜的表示法，正規化成 0
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour) % 24 };
}

/**
 * 本批次的絕對截止時刻＝「起點之後的下一個台北 02:00」與「起點 + 跑道上限」取早的那個。
 *
 * ⚠ 不可改回「拿當下的小時跟 2 比大小」。批次是接在 23:00 健檢後面啟動的，`23 >= 2` 恆為真，
 * 迴圈第一輪就 break ＝整條通道每晚靜默 no-op、零 log（實測過的失敗，不是假想）。
 * 算成絕對時刻後，23:00 起跑得到 3 小時、00:30 起跑得到 1.5 小時，語意才是「跑到凌晨兩點為止」。
 *
 * 跑道上限則是補住另一頭：手動在白天觸發時「下一個 02:00」可以遠到 16～24 小時之後，
 * 保險絲形同虛設。兩者取早的，自動排程（3 小時）不受影響。
 */
function deadlineFor(startedAt) {
  const { year, month, day, hour } = taipeiDateParts(startedAt);
  // 起點已過當日 02:00 就指向隔天的 02:00；日期用 UTC 建再加天數，跨月跨年交給 Date 自己處理
  const target = new Date(Date.UTC(year, month - 1, day + (hour >= NIGHTLY_FIX_DEADLINE_HOUR ? 1 : 0)));
  const atHour = new Date(`${target.toISOString().slice(0, 10)}T${String(NIGHTLY_FIX_DEADLINE_HOUR).padStart(2, '0')}:00:00+08:00`);
  return new Date(Math.min(atHour.getTime(), startedAt.getTime() + NIGHTLY_FIX_MAX_RUNWAY_MS));
}

// getInflightInfo 延到函式內才 require：載入期就拉進 runner 會有循環依賴
// （runner.js 之後串接本模組——Task 7.3）。
function inflightCount() {
  const { getInflightInfo } = require('./runner');
  return getInflightInfo().length;
}

async function waitForDrain() {
  const deadline = now().getTime() + NIGHTLY_FIX_DRAIN_MAX_MS;
  while (inflightCount() > 0) {
    if (now().getTime() >= deadline) return false;
    await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
  }
  return true;
}

// 本批次累計 token（input+output+cache_read+cache_create），從批次開始時間往後算。
async function tokensSince(sinceAt) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens), 0)::bigint AS total
       FROM token_usage WHERE recorded_at >= $1`,
    [sinceAt]
  );
  return Number(rows[0]?.total || 0);
}

/**
 * 兩道保險絲。回傳擋下的原因（`deadline`／`token-budget`）或 null。
 *
 * ⚠ 一律在「開跑之前」問，不是跑到一半砍掉——半途中斷會留下髒 worktree 與半套 diff。
 * triage／merge 本身就要燒 token，所以進迴圈之前也要先問一次（50 筆 approved 意見會先燒
 * 50 次 triage 才輪到第一次檢查預算）。
 */
async function fuseTripped(deadlineAt, batchStartedAt) {
  if (now() >= deadlineAt) return 'deadline';
  if (await tokensSince(batchStartedAt) >= NIGHTLY_FIX_TOKEN_BUDGET) return 'token-budget';
  return null;
}

// 健檢提案候選：approved 的 proposal，套 severity 門檻與可自動修的 layer（layer 已知，可在此就篩）。
async function fetchHealthCandidates() {
  const { rows: hc } = await query(
    `SELECT id, agent_label AS title, diagnosis AS detail, layer, severity,
            rationale AS action, risk_if_wrong, target_metric, metric_baseline, evidence, created_at
       FROM health_check_findings
      WHERE status = 'approved' AND kind = 'proposal'
        -- 已經在意見回饋管理開過單的提案不再單獨當候選：那一筆 feedback 才是它的管理面
        -- （見 health-check-runner.js 的 openFeedbackForFinding）。兩邊都撈的話同一條會被
        -- 當成兩個候選跑兩遍——重付一次 triage、重跑兩次全套測試、還可能各自合併一次。
        -- ⚠ 用 NOT IN 而非 NOT EXISTS：pg-mem 解析不了帶參數的相關子查詢（rules/testing.md #14）。
        -- 子查詢的 IS NOT NULL 不可省——真 PG 裡 NOT IN 的清單只要含一個 NULL，整個條件恆為
        -- UNKNOWN，這個 WHERE 會靜默地把所有候選都篩掉，而且測試不會紅。
        AND id NOT IN (SELECT finding_id FROM feedback WHERE finding_id IS NOT NULL)
      ORDER BY created_at ASC`
  );
  const kept = [];
  for (const h of hc) {
    if (inAutoFixScope(h.layer, h.severity)) { kept.push({ source: 'finding', row: h }); continue; }
    // 超出自動範圍卻停在 approved：畫面會掛「⏱ 自動執行」的 pill，這裡卻每晚默默把它濾掉——
    // 「被承諾會跑」「不會跑」「不算待處理（open_count 只算 pending）」三件事同時成立，狀態在說謊。
    // 來源是 7.1 那條一次性 UPDATE：它只看 status 與 kind、不看 severity／layer，所以把 low 的
    // 提案也一起轉正了（實測 id 73，severity=low）。insertFinding 那半已經依 inAutoFixScope 落
    // pending，但它管不到既有列。這裡寫回 pending 讓它自我修復，順便留下人看得懂的理由——
    // 規格 §257 本來就要求「篩掉的標『超出自動範圍，需人工處理』留在管理頁」。
    console.log('[NIGHTLY-FIX] 提案 #%s 超出自動修正範圍（layer=%s severity=%s），退回人工',
      h.id, h.layer, h.severity);
    await retireToHuman(false, h.id,
      `超出自動範圍，需人工處理（layer=${h.layer || '未填'}、severity=${h.severity || '未填'}；`
      + '自動修正只收 code／prompt／observability 且嚴重度 medium 以上）')
      .catch(e => console.error('[NIGHTLY-FIX] 提案退回人工失敗：', e.message));
  }
  return kept;
}

// 意見回饋候選：status='approved' 的全部撈出來。
// ⚠ 這裡**不能**套 layer 條件：layer 要等 triageOne 跑完才會寫進 triage_layer，此刻還是 NULL，
// 先套等於把所有新核准的意見全部濾掉（整條通道對意見回饋永遠 no-op）。
async function fetchApprovedFeedback() {
  const { rows: fb } = await query(
    `SELECT id, content, user_id, created_at FROM feedback WHERE status = 'approved' ORDER BY created_at ASC`
  );
  return fb.map(f => ({ source: 'feedback', row: f }));
}

// 意見回饋跑 triageOne：把使用者原文翻成具體修改需求，順便定出 layer。
// 回 understandable:false 的剔除（triageOne 內部已把 status 退回 'new'）；翻出來的 layer 不在
// 可自動修範圍（例如 env）→ **立即退場**，不是留在原地不動：同一份原文 triage 不會突然變 code，
// 這是確定性結果，不需要像「修不出來」那樣給三次額度重試——不退場的話這條意見會每晚重付一次
// triage 的 token，永遠卡在「已核准」，使用者與管理員都看不出「自動修正範圍不含這一類」。
async function triageFeedback(items) {
  const kept = [];
  for (const it of items) {
    await setStage([it], '翻譯需求中');
    const { understandable, transient } = await triageOne(it.row.id);
    await setStage([it], null);
    // transient＝triage 自己沒跑起來（CLI 掛掉／額度），不是這條意見的錯：status 維持 approved
    // 讓下一晚重試，只在飢餓防線上記一次。連續失敗達門檻才由 noteFailedAttempt 退回人工——
    // 不記帳的話，一支永遠跑不起來的 triage 會每晚白燒一次額度且無人察覺。
    if (transient) {
      await noteFailedAttempt({ members: [it] }, 'triage 執行失敗（CLI 未跑起來，非意見本身的問題）')
        .catch(e => console.error('[NIGHTLY-FIX] triage 失敗記帳時又出錯：', e.message));
      continue;
    }
    if (!understandable) continue;
    const { rows: [refreshed] } = await query(
      `SELECT id, triage_title AS title, triage_detail AS detail, triage_layer AS layer,
              triage_action AS action, verify_route, user_id, created_at
         FROM feedback WHERE id=$1`, [it.row.id]);
    if (!refreshed) continue;
    if (!AUTO_LAYERS.has(refreshed.layer)) {
      const layerLabel = refreshed.layer || '未分類';
      console.log('[NIGHTLY-FIX] 意見 #%d 的 layer=%s 不在可自動修範圍，立即退場',
        it.row.id, layerLabel);
      await retireToHuman(true, refreshed.id,
        `翻出來的 layer=${layerLabel}，自動修正範圍只含 code／prompt／observability，請人工處理`);
      continue;
    }
    kept.push({ source: 'feedback', row: refreshed });
  }
  return kept;
}

// 兩批候選合併＋排序：severity 高的先，其次 created_at 舊的先。意見回饋沒有 severity，
// 排在 severity 已知的健檢提案之後、依 created_at 排序——只影響「先跑哪一組」，不影響入不入選。
function sortCandidates(feedbackItems, healthItems) {
  const sevRank = { error: 0, high: 1, medium: 2 };
  const rank = (it) => it.source === 'finding' ? (sevRank[it.row.severity] ?? 3) : 3;
  return [...feedbackItems, ...healthItems].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return new Date(a.row.created_at) - new Date(b.row.created_at);
  });
}

/**
 * 送給 merge agent 的候選一律用**批次內序號 1..N**，不是資料表的主鍵。
 *
 * ⚠ `feedback` 與 `health_check_findings` 各自 SERIAL，撞號是常態（不是邊緣case）。裸 id 進去、
 * 裸 id 回來之後，`feedback:7` 與 `finding:7` 再也分不開：一組純意見的修改會被認成某筆健檢提案，
 * runFix 從 DB 讀到健檢提案的內文、fix-review 卻拿到意見的 title/detail ⇒ **改錯東西，且零訊號**。
 * 序號天生不撞，而 agent 那邊看到的仍是裸數字，契約不變。
 */
function indexCandidates(candidates) {
  const indexed = candidates.map((it, i) => ({ ordinal: i + 1, ...it }));
  return { indexed, byOrdinal: new Map(indexed.map(it => [it.ordinal, it])) };
}

function toCandidateItem(it) {
  return {
    id: it.ordinal, source: it.source,
    title: it.row.title || '(無標題)', detail: it.row.detail || ''
  };
}

/**
 * merge agent 回來的組 → 可執行的組。三件事：
 *   1. member_ids 只留認得的序號（agent 可能回不存在的號碼）
 *   2. layer 重新套 AUTO_LAYERS——merge 的 schema 允許回 env／unclear，回了照樣進 runFix 會白燒
 *      一輪；agent 沒填時沿用組內第一個成員的 layer（成員在入選時都已通過同一道篩選）
 *   3. verify_route 為空時 fallback 到組內意見成員的值——merge 的 prompt 寫「推不出來留空」，
 *      實務上它幾乎必然留空，而 needsScreenshot 只看這個欄位 ⇒ 截圖審查對最需要它的來源
 *      （使用者親眼看到畫面不對而提的意見）永遠不會啟動
 *   4. **跨組去重**：merge agent 若把同一個候選序號放進兩個 group（prompt 沒禁止、agent 偶爾
 *      會犯），該成員一晚會在兩組各記一次 fix_attempts（見 noteFailedAttempt），等於 +2，
 *      兩晚就達到 NIGHTLY_FIX_MAX_ATTEMPTS 退場——比真正只失敗兩次的候選更快被踢出去，且原因
 *      跟事實不符。後出現的組把已被更早的組拿走的序號剔掉；剔到空組就整組丟掉並留 log。
 */
function normalizeGroups(groups, byOrdinal) {
  const usable = [];
  const claimed = new Set();
  for (const g of groups) {
    const rawIds = (Array.isArray(g.member_ids) ? g.member_ids : []).map(Number);
    // 跨組去重前先算掉哪些序號是因為「被更早的組拿走」才消失，不是「本來就對不上」——
    // 兩種原因的正確查法完全不同，不留這行 log 的話「沒有對得上的成員序號」會把人導去查錯方向
    // （它們對得上，只是被更早的組拿走了）。
    const dropped = rawIds.filter(id => byOrdinal.has(id) && claimed.has(id));
    if (dropped.length) {
      console.log('[NIGHTLY-FIX] 統整結果「%s」的成員序號 %s 已被更早的組拿走，跨組去重剔除',
        g.title || '(無標題)', dropped.join(','));
    }
    const memberIds = rawIds.filter(id => byOrdinal.has(id) && !claimed.has(id));
    if (!memberIds.length) {
      if (dropped.length) {
        console.log('[NIGHTLY-FIX] 統整結果「%s」去重後成員序號淨空，跳過', g.title || '(無標題)');
      } else {
        console.log('[NIGHTLY-FIX] 統整結果「%s」沒有對得上的成員序號，跳過', g.title || '(無標題)');
      }
      continue;
    }
    memberIds.forEach(id => claimed.add(id));
    const members = memberIds.map(id => byOrdinal.get(id));
    // ⚠ agent **明講**的 layer 一律照認：它說 env／unclear 就是判斷「這條自動改不動」，
    // 此時不可拿成員的 layer 去蓋掉它（那等於把它的結論改寫成我們想要的答案）。
    // 只有它沒填時才沿用成員的 layer（成員在入選時都已通過同一道 AUTO_LAYERS 篩選）。
    const declared = String(g.layer || '').trim().toLowerCase();
    const layer = declared
      ? (AUTO_LAYERS.has(declared) ? declared : null)
      : members.map(m => normalizeLayer(m.row.layer)).find(l => AUTO_LAYERS.has(l));
    if (!layer) {
      console.log('[NIGHTLY-FIX] 統整結果「%s」的 layer=%s 不在可自動修範圍，跳過',
        g.title || '(無標題)', g.layer || '未填');
      continue;
    }
    const route = String(g.verify_route || '').trim()
      || (members.find(m => m.source === 'feedback' && m.row.verify_route)?.row.verify_route || '');
    usable.push({
      memberIds, members, layer,
      title: g.title || '(無標題)',
      detail: g.detail || '',
      action: g.action || '',
      verify_route: route,
    });
  }
  return usable;
}

// 一組只有單一健檢提案成員（沒有意見回饋、沒有被合併）：健檢來源本來就有 finding，不重建，
// 直接沿用既有 id。重建會讓健檢頁多出一條看起來一樣、脈絡卻是全新的重複列。
function soleFindingId(members) {
  if (members.length !== 1 || members[0].source !== 'finding') return null;
  return members[0].row.id;
}

// evidence：意見回饋成員的「誰在何時回報」。夜間無人監督，這是事後唯一看得出這條修改
// 從何而來的線索。
async function feedbackEvidence(members) {
  const notes = [];
  for (const it of members) {
    if (it.source !== 'feedback') continue;
    const { rows: [u] } = await query('SELECT display_name, username FROM users WHERE id=$1', [it.row.user_id]);
    const who = (u && (u.display_name || u.username)) || '匿名';
    notes.push(`使用者 ${who} 於 ${new Date(it.row.created_at).toISOString()} 回報`);
  }
  return notes.length ? notes.join('\n') : null;
}

// 多個健檢提案成員合併成一組時，target_metric／metric_baseline／risk_if_wrong 這三個欄位取
// 「第一個有值的健檢來源成員」——比照 verify_route 的 fallback 策略：指標與風險描述的是
// 「這一類問題」而非逐條意見量身定制，多條合併時沒有比「沿用最早那條」更好的自動合併規則，
// 硬串接多筆反而會讓 fix-review 讀到一段誰也不對應的雜訊。
function firstHealthField(members, field) {
  const hit = members.find(m => m.source === 'finding' && m.row[field]);
  return hit ? hit.row[field] : null;
}

async function materializeGroup(group, runId) {
  const reuseId = soleFindingId(group.members);
  const base = {
    title: group.title, detail: group.detail, action: group.action,
    layer: group.layer, verify_route: group.verify_route,
    risk_if_wrong: reuseId != null ? (group.members[0].row.risk_if_wrong || null) : firstHealthField(group.members, 'risk_if_wrong'),
    target_metric: reuseId != null ? (group.members[0].row.target_metric || null) : firstHealthField(group.members, 'target_metric'),
    metric_baseline: reuseId != null ? (group.members[0].row.metric_baseline || null) : firstHealthField(group.members, 'metric_baseline'),
    members: group.members,
  };
  if (reuseId != null) return { findingId: reuseId, reused: true, ...base };

  const hasFeedback = group.members.some(m => m.source === 'feedback');
  const evidence = await feedbackEvidence(group.members) || firstHealthField(group.members, 'evidence');

  /**
   * ⚠ 這一列是「批次的施工紀錄」，不是等人裁決的提案，所以明確帶 status='done'：
   *   - 走 DEFAULT（現在是 pending、Phase 7.1 之後是 approved）會讓它變成**隔晚的候選**，
   *     與「成功後才標 done」疊起來就是自我餵食迴圈：每晚產生新提案、每晚再修一次。
   *   - 真正的處置結果由 applied_at 區分：有值＝碼已合併；沒值＝這一晚試過但沒成功。
   * health_check_findings 沒有 verify_route 欄位（那是 feedback 表才有的），只在記憶體內傳給
   * reviewFix 判斷要不要截圖。
   */
  const { rows: [row] } = await query(
    `INSERT INTO health_check_findings
       (run_id, agent_name, agent_label, diagnosis, severity, rationale, kind, layer, evidence,
        target_metric, metric_baseline, risk_if_wrong, status)
     VALUES ($1,$2,$3,$4,'medium',$5,'proposal',$6,$7,$8,$9,$10,'done')
     RETURNING id`,
    [runId, hasFeedback ? 'feedback' : 'health-auditor',
     base.title, base.detail, base.action || null, base.layer, evidence,
     base.target_metric, base.metric_baseline, base.risk_if_wrong]
  );
  return { findingId: row.id, reused: false, ...base };
}

/** cand.members（記憶體物件，帶整列 row）壓成落得了 DB 的最小識別：`[{ source, id }]` */
function memberRefs(cand) {
  return (cand.members || []).map(it => ({ source: it.source, id: it.row.id }));
}

/**
 * memberRefs 的反向：把 finding_fixes.members 還原成 markGroupDone／noteDeferred 吃的形狀。
 * ⚠ 要收得下字串：JSONB 欄位在 pg 會回物件，pg-mem 有時回原始字串，只認陣列會在測試裡靜默變空。
 */
function membersFromRefs(refs) {
  let list = refs;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  return (Array.isArray(list) ? list : []).map(r => ({ source: r.source, row: { id: r.id } }));
}

async function createFixRow(findingId, startedBy, cand) {
  const { rows: [row] } = await query(
    `INSERT INTO finding_fixes (finding_id, status, created_by, members)
     VALUES ($1,'running',$2,$3) RETURNING id`,
    [findingId, startedBy || null, cand ? JSON.stringify(memberRefs(cand)) : null]
  );
  return row.id;
}

/**
 * 成功合併之後把來源標掉。**沒有這一步，同一批 approved 每晚會重做一次**：重新 triage、重建
 * finding、重跑兩次全套測試，而使用者端永遠停在「已核准」（`task-1.3-brief.md`：done 由夜間批次寫）。
 *
 * ⚠ 不能指望 applyFix 代勞：它在 inflight 非空時提早 return（夜間批次正是傳非空值來「只合併不
 * 重啟」），跳過了它自己標 done 的那段。
 */
async function markGroupDone(cand, userId) {
  for (const it of cand.members) {
    if (it.source === 'feedback') {
      /**
       * ⚠ 改寫 finding_id 之前要先把它原本指的那條提案標掉。
       *
       * 健檢提案會由 openFeedbackForFinding 開一筆 feedback 並用 finding_id 連回來源，而
       * fetchHealthCandidates 排除「已開單提案」靠的就是這個欄位（`id NOT IN (SELECT finding_id
       * FROM feedback ...)`）。這裡把它改指到本次的施工紀錄，等於把來源提案從那張排除清單裡放掉
       * ——它還停在 approved，下一批就會把**已經合併好的同一條**當成新候選再修一次。
       * 實測 2026-09-05：提案 81／91 合併完之後就重新出現在候選清單裡。
       */
      const { rows: [prev] } = await query('SELECT finding_id FROM feedback WHERE id=$1', [it.row.id]);
      if (prev && prev.finding_id && prev.finding_id !== cand.findingId) {
        await query(
          `UPDATE health_check_findings
              SET status='done', decided_by=$2, decided_at=NOW(), applied_at=COALESCE(applied_at, NOW())
            WHERE id=$1`, [prev.finding_id, userId || null]);
      }
      await query(
        `UPDATE feedback SET status='done', finding_id=$2 WHERE id=$1`, [it.row.id, cand.findingId]);
    } else {
      await query(
        `UPDATE health_check_findings
            SET status='done', decided_by=$2, decided_at=NOW(), applied_at=COALESCE(applied_at, NOW())
          WHERE id=$1`, [it.row.id, userId || null]);
    }
  }
  // 批次自建的那一列（合併組）也要記 applied_at，才分得出「試過沒成」與「已套用」
  await query(
    `UPDATE health_check_findings SET applied_at = COALESCE(applied_at, NOW()) WHERE id=$1`,
    [cand.findingId]);
}

/**
 * 退場＝把狀態換回「等人」那一格並歸零計數，不是靜靜地從候選裡消失：
 *   - 意見回饋 → `status='new'` ＋ `triage_note` 寫原因（與 triageOne 判不出來時同一個慣例，
 *     管理頁本來就會顯示這個欄位）
 *   - 健檢提案 → `status='pending'`（回到等人裁決）＋ `verdict_note` 寫原因
 *   兩張表都要**清掉 `decided_by`／`decided_at`**——人工核准都會寫這兩欄
 *   （健檢提案見 `admin-routes.js`；意見回饋見 `feedback-routes.js:85`），機器退場若不清掉，
 *   畫面上會留著使用者自己核准時的裁決時間與（將被覆寫的）理由，看起來像是他自己把核准的東西
 *   又改回待處理。note 前綴另外標出「這是機器寫的」，供對應管理頁的 pill 判斷。
 * 計數歸零是為了「人再核准一次就再給一輪完整額度」，不必另外開一支重設路徑。
 */
async function retireToHuman(isFeedback, id, note) {
  const tagged = MACHINE_RETIRE_PREFIX + note;
  if (isFeedback) {
    // 意見回饋也有 decided_by／decided_at／verdict_note（人工核准會寫，見 feedback-routes.js:85），
    // 跟健檢提案同一個坑：機器退場不清掉的話，畫面上會留著使用者自己核准時的裁決時間與理由，
    // 看起來像是他自己把核准的東西又改回待處理。
    await query(
      `UPDATE feedback SET status='new', triage_note=$2, fix_attempts=0,
              decided_by=NULL, decided_at=NULL WHERE id=$1`, [id, tagged]);
  } else {
    await query(
      `UPDATE health_check_findings
          SET status='pending', verdict_note=$2, fix_attempts=0, decided_by=NULL, decided_at=NULL
        WHERE id=$1`,
      [id, tagged]);
  }
}

/**
 * 「這一筆現在做到哪一步」——純顯示，任何判斷都不准讀它。
 *
 * 沒有這個的話，畫面上只有最上面一條「批次執行中」的橫幅：使用者知道有東西在跑，但不知道在跑
 * 哪一筆，而一輪動輒數十分鐘。stage 傳 null＝這一筆做完了（或跑掉了），把動畫收掉。
 * ⚠ 寫失敗一律吞掉：顯示用的欄位不值得讓整條修正鏈中斷。
 */
async function setStage(members, stage) {
  for (const it of members || []) {
    await query(
      it.source === 'feedback'
        ? 'UPDATE feedback SET batch_stage=$2 WHERE id=$1'
        : 'UPDATE health_check_findings SET batch_stage=$2 WHERE id=$1',
      [it.row.id, stage]
    ).catch(e => console.error('[NIGHTLY-FIX] 寫 batch_stage 失敗：', e.message));
  }
}

/** 落進 last_attempt_note 的字串。長度設限：這欄會整串送進管理頁的列，不是給人讀 stack 的地方。 */
function attemptNote(reason) {
  return String(reason || '未提供原因').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * 「修好了、審過了，只是這一刻合併不進去」——不是這條修正的錯，不記失敗次數。
 *
 * applyFix 會拋的四種原因（主 clone 有未提交的變更、與 origin 分岔、push 失敗、查不到容器名）
 * 全是**平台當下的狀態**，不是這份 diff 的品質問題：重跑一次 platform-fix 不會讓主 clone 變乾淨。
 * 記成失敗的話，只要有人連著三晚在批次跑的時候編輯主 clone，使用者核准的意見就會被「連續失敗
 * 三次」退回人工——而三次都不是它的問題。實際發生過（2026-09-05，提案 #106）。
 *
 * 修正列留在 adopted：分支上的 commit 是好的，下一批開跑時 resumeAdoptedFixes 直接重試合併，
 * 不重跑 agent、不重跑測試。
 */
async function noteDeferred(cand, reason) {
  const note = attemptNote(`已修好並通過審核，但這次合併不進去，下批會自動重試：${reason}`);
  for (const it of cand.members) {
    await query(
      it.source === 'feedback'
        ? 'UPDATE feedback SET last_attempt_note=$2 WHERE id=$1'
        : 'UPDATE health_check_findings SET last_attempt_note=$2 WHERE id=$1',
      [it.row.id, note]);
  }
}

/**
 * 這一晚沒能合併 → 每個來源成員的連續失敗次數 +1，達門檻就退回人工。
 *
 * 「成功才標 done」的反面是：一條**永遠**合併不了的意見（review 一直 reject、主 clone 一直髒、
 * applyFix 一直拋）會每晚重跑一次完整流程——重付一次 triage、重跑兩次 runFix（含兩次全套測試）
 * ——並且**永久佔掉 NIGHTLY_FIX_MAX 的一格**，把後來提的意見擠在後面永遠輪不到。
 * 無上限的成本＋安靜的飢餓，兩件事都不能留。
 */
async function noteFailedAttempt(cand, reason) {
  // ⚠ 不可命名為 note：迴圈裡（達門檻退場那段）已經有一個 `const note`，同名會讓這裡的參照
  // 落進那個 block 的 TDZ，整個函式在執行期炸「Cannot access 'note' before initialization」，
  // 而呼叫端是 `.catch(console.error)` ⇒ 失敗次數靜默不再累加、飢餓防線整條失效。
  const attemptText = attemptNote(reason);
  for (const it of cand.members) {
    const isFeedback = it.source === 'feedback';
    const { rows: [r] } = isFeedback
      ? await query(
        `UPDATE feedback SET fix_attempts = COALESCE(fix_attempts,0) + 1, last_attempt_note=$2
          WHERE id=$1 RETURNING fix_attempts`,
        [it.row.id, attemptText])
      : await query(
        `UPDATE health_check_findings SET fix_attempts = COALESCE(fix_attempts,0) + 1, last_attempt_note=$2
          WHERE id=$1 RETURNING fix_attempts`,
        [it.row.id, attemptText]);
    const attempts = (r && r.fix_attempts) || 0;
    if (attempts < NIGHTLY_FIX_MAX_ATTEMPTS) continue;

    const note = `自動修正連續失敗 ${attempts} 次，已退回人工處理。最後一次原因：${reason || '未提供'}`;
    await retireToHuman(isFeedback, it.row.id, note);
    console.log('[NIGHTLY-FIX] %s #%d 已退回人工（連續失敗 %d 次）：%s',
      isFeedback ? '意見' : '提案', it.row.id, attempts, reason || '未提供');
  }
}

/**
 * 逐條走完整條鏈：runFix → (通過測試才) fix-review → reject 退回改一次 → adopt →
 * applyFix(只合併，僅在有 pushUserId 時)。
 *
 * pushUserId 為 null（teams_settings.cli_push_user_id 未設定）：停在 adopted，不呼叫 applyFix
 * ——不得寫死 user id，也不得代為決定用誰的身分推。
 */
async function runOneCandidate(cand, { pushUserId, startedBy }) {
  let fixId = await createFixRow(cand.findingId, startedBy, cand);
  await setStage(cand.members, '改碼與跑測試中');
  await runFix(fixId, { findingId: cand.findingId, startedBy });

  let attempt = 0;
  for (;;) {
    const { rows: [fix] } = await query('SELECT status, reject_reason FROM finding_fixes WHERE id=$1', [fixId]);
    if (!fix || fix.status !== 'ready') {
      const status = (fix && fix.status) || '（查無此列）';
      // no_change 是合法且刻意的結果（platform-fix 判斷「不該做」）——不是測試沒過，
      // 「修正未通過測試」這句話在這裡是事實錯誤。它也是確定性的：同一份原文重跑仍會判
      // no_change，不需要像真的失敗那樣給三次額度重試，白燒兩次 platform-fix。
      if (fix && fix.status === 'no_change') {
        console.log('[NIGHTLY-FIX] 提案 #%d 的修正判定 no_change（platform-fix 認為不該做），立即退場', cand.findingId);
        return { merged: false, retire: true, reason: 'platform-fix 判斷不需要修改（no_change）' };
      }
      console.log('[NIGHTLY-FIX] 提案 #%d 的修正狀態為 %s，不進審核', cand.findingId, status);
      return { merged: false, reason: `修正未通過測試（狀態 ${status}）${fix && fix.reject_reason ? '：' + fix.reject_reason : ''}` };
    }

    await setStage(cand.members, '審核中');
    const verdict = await reviewFix(fixId, cand);
    // review_notes：fix-review 的推理過程，approve／reject 兩條路徑都要寫——這是無人監督閘門
    // 唯一的人類事後稽核材料（見跨單元契約 1；管理頁顯示由單元 3 負責）。
    await query(`UPDATE finding_fixes SET review_notes=$2 WHERE id=$1`, [fixId, verdict.notes || null]);
    if (verdict.verdict === 'approve') {
      if (!pushUserId) {
        await adoptFix(fixId, startedBy);
        console.error('[NIGHTLY-FIX] 未設定 CLI 推送身分（teams_settings.cli_push_user_id 為空），'
          + `提案 #${cand.findingId} 停在 adopted，不合併不重啟`);
        return { merged: false, adopted: true, fixId };
      }
      await setStage(cand.members, '合併中');
      await adoptFix(fixId, pushUserId);
      try {
        // ⚠ inflight 傳非空值 ⇒ 只合併不重啟（最後才單獨重啟一次）
        await applyFix(fixId, pushUserId, ['nightly-fix']);
      } catch (err) {
        // ⚠ 這個 catch 不能省成外層的統一 catch：外層會 noteFailedAttempt，而 applyFix 拋的
        // 是「平台此刻的狀態」不是這份 diff 的問題（見 noteDeferred）。修正列留在 adopted，
        // 由下一批的 resumeAdoptedFixes 直接重試合併。
        console.error('[NIGHTLY-FIX] 提案 #%d 已採用但這次合併不進去，留待下批重試：%s',
          cand.findingId, err.message);
        return { merged: false, deferred: true, fixId, reason: err.message };
      }
      return { merged: true, fixId };
    }

    // reviewFix 只回 verdict、不落地。狀態也要一起改掉：只寫 reject_reason 會讓這筆停在 ready，
    // 管理頁看起來像「還可以採用」。
    await query(
      `UPDATE finding_fixes SET status='rejected', reject_reason=$2, finished_at=NOW() WHERE id=$1`,
      [fixId, verdict.reason || '審查未通過']);
    console.log('[NIGHTLY-FIX] 提案 #%d 第 %d 次審核未通過：%s',
      cand.findingId, attempt + 1, verdict.reason || '（未附理由）');

    attempt += 1;
    if (attempt > NIGHTLY_FIX_MAX_RETRY) {
      return { merged: false, reason: `審核連續 ${attempt} 次未通過：${verdict.reason || '未附理由'}` };
    }

    // 退回改一次：開新的一筆 finding_fixes 重跑（不覆寫舊列——finding_fixes 本來就是為
    // 「一條提案可試修多次」設計的，覆寫會讓「上一次試了什麼、為什麼失敗」消失）。
    fixId = await createFixRow(cand.findingId, startedBy, cand);
    await setStage(cand.members, '改碼與跑測試中（審核退回，重改一次）');
    await runFix(fixId, { findingId: cand.findingId, startedBy });
  }
}

/**
 * 開跑前先把上一批「改好了但沒合併進去」的撿回來重試 -> 這一輪合併成功的筆數。
 *
 * 這是 deferred 的另一半：停在 adopted 的修正，分支上的 commit 已經寫好、測試過、審核過了，
 * 缺的只是主 clone 當下不能合併。沒有這段的話它會永遠孤在分支上（實測 2026-09-05 提案 #106），
 * 而來源意見仍是 approved ⇒ 隔晚整條從頭重做：重付 triage、重跑兩次全套測試、重跑一次 fix-review，
 * 換到的還是同一份 diff。這裡只做「合併＋標來源」，一個 agent 都不叫。
 *
 * ⚠ 刻意放在保險絲（fuseTripped）之前：保險絲擋的是 token 花費，這段不燒 token。
 * ⚠ 舊資料的 members 可能是 NULL（本欄上線前建的列）：碼照樣合併——它已經審過了，把好碼留在
 *    分支上沒有任何好處——但標不了來源，要大聲印出來讓人知道那幾筆得手動結案。
 */
async function resumeAdoptedFixes({ pushUserId, startedBy }) {
  if (!pushUserId) return 0;
  const { rows } = await query(
    `SELECT id, finding_id, members FROM finding_fixes WHERE status='adopted' ORDER BY id`);
  let merged = 0;
  for (const fix of rows) {
    try {
      await applyFix(fix.id, pushUserId, ['nightly-fix']);
      merged += 1;
      const members = membersFromRefs(fix.members);
      if (!members.length) {
        console.error('[NIGHTLY-FIX] 修正 #%d（提案 #%d）已補合併，但這列沒有成員紀錄，'
          + '來源標不了 done，請人工確認並結案', fix.id, fix.finding_id);
        continue;
      }
      await markGroupDone({ findingId: fix.finding_id, members }, pushUserId || startedBy);
      console.log('[NIGHTLY-FIX] 上一批停在 adopted 的提案 #%d 已補合併', fix.finding_id);
    } catch (err) {
      // 還是合不進去（主 clone 仍髒／仍分岔）＝下一批再試。這裡不記失敗額度，理由同 noteDeferred。
      console.error('[NIGHTLY-FIX] 補合併提案 #%d 仍未成功，留待下批：%s', fix.finding_id, err.message);
    }
  }
  return merged;
}

/**
 * runNightlyFix({ startedBy }) -> { attempted, applied, skipped, reason? }
 */
async function runNightlyFix({ startedBy = null } = {}) {
  // 併發防護：cron 重複觸發、或人工在批次進行中又按一次，會變成兩批各自往 master 合併。
  // 維護旗標是現成的單一真相（自帶到期時間，卡死不了）。
  if (await isMaintenance()) {
    console.log('[NIGHTLY-FIX] 已在維護視窗中（上一批還在跑或旗標未到期），本次不啟動');
    return { attempted: 0, applied: 0, skipped: 0, reason: 'already-running' };
  }

  const startedAt = now();
  const batchStartedAt = startedAt.toISOString();
  const deadlineAt = deadlineFor(startedAt);
  let entered = false;
  let mergedAny = false;
  // runId 放在 try 外面：收尾要在 finally 做，否則保險絲查詢（tokensSince）之類的例外一逃出
  // 迴圈，這一列就永遠停在 running——那正是 C4 要防的症狀。
  let runId = null;

  try {
    await enterMaintenance();
    entered = true;

    if (!await waitForDrain()) {
      console.log('[NIGHTLY-FIX] 等在飛任務排空逾時（%d 分鐘），放棄本批次', Math.round(NIGHTLY_FIX_DRAIN_MAX_MS / 60000));
      return { attempted: 0, applied: 0, skipped: 0, reason: 'drain-timeout' };
    }

    const { rows: [settings] } = await query('SELECT cli_push_user_id FROM teams_settings WHERE id=1');
    const pushUserId = settings && settings.cli_push_user_id;

    /**
     * 撿上一批停在 adopted 的（見 resumeAdoptedFixes）。
     *
     * ⚠ 位置有兩個硬條件，不可下移：
     * 1. 必須在 fetchApprovedFeedback **之前**。deferred 的來源意見仍是 approved，補合併成功會把
     *    它們標成 done；晚於取候選的話，同一批意見會一邊被補合併、一邊又被當成新候選整條重跑。
     * 2. 必須在「沒有候選就早退」**之前**。那正是最需要補合併的情況——來源已經被上一批處理完、
     *    只剩一個孤在分支上的 commit，早退會讓它永遠等不到下一次。
     * ⚠ mergedAny 也要在這裡就設：下面幾個早退都是 `return`，finally 照跑，補進去的碼一樣要靠
     *    那次重啟才會生效。
     */
    const resumed = await resumeAdoptedFixes({ pushUserId, startedBy })
      .catch(e => { console.error('[NIGHTLY-FIX] 補合併上一批失敗：', e.message); return 0; });
    if (resumed) mergedAny = true;

    // triage／merge 也要燒 token，所以進迴圈之前先問一次保險絲
    const preFuse = await fuseTripped(deadlineAt, batchStartedAt);
    if (preFuse) {
      console.log('[NIGHTLY-FIX] 開跑前保險絲已跳（%s），本批次不執行', preFuse);
      return { attempted: 0, applied: 0, skipped: 0, reason: preFuse };
    }

    const healthCandidates = await fetchHealthCandidates();
    const feedbackCandidates = await triageFeedback(await fetchApprovedFeedback());
    const candidates = sortCandidates(feedbackCandidates, healthCandidates);
    if (!candidates.length) {
      console.log('[NIGHTLY-FIX] 沒有可執行的候選（意見回饋 %d、健檢提案 %d）',
        feedbackCandidates.length, healthCandidates.length);
      return { attempted: 0, applied: 0, skipped: 0 };
    }

    const { indexed, byOrdinal } = indexCandidates(candidates);
    const mergedGroups = await mergeCandidates(indexed.map(toCandidateItem));
    if (!mergedGroups.length) {
      // ⚠ 這不是候選自己的錯（agent 執行失敗或解析不出 groups），不該記在候選帳上——
      // 但也不能悄悄什麼都不做：候選集體落空要大聲留痕，否則現象是「今晚有 approved
      // 候選、卻連一條 fix_attempts 都沒增加」，看起來像候選憑空消失。
      console.error('[NIGHTLY-FIX] 本輪 %d 筆候選統整（mergeCandidates）集體落空，本批次不執行任何一條',
        candidates.length);
      return { attempted: 0, applied: 0, skipped: 0 };
    }
    const groups = normalizeGroups(mergedGroups, byOrdinal);

    /**
     * 對帳（2-C2）：四個位置會讓候選蒸發而完全不記帳——mergeCandidates 集體落空（上面已處理，
     * 不佔用個別候選的失敗額度）、normalizeGroups 判「沒有對得上的成員序號」／跨組去重淨空、
     * merge agent 宣告 layer=env/unclear 而整組被跳過。這些情況下對應的候選成員連 log 都沒有
     * （normalizeGroups 只印組名，不印落單成員的序號）。⚠ 必須放在「groups 是否為空」的早退
     * 判斷**之前**：groups.length===0（merge 回的組全數被 normalizeGroups 判掉）本身就是
     * 「全部候選蒸發」的極端情況，早退在對帳之前會讓這整批連一次失敗都不記。
     *
     * ⚠ 這裡刻意只對「進了 groups（不論是否因超出 NIGHTLY_FIX_MAX 被 capped 排除）」與
     * 「byOrdinal 全集」兩者的差集記帳——**排隊等下一晚**的候選（在 groups 裡、只是被
     * capped 截斷）不算蒸發，不能誤記失敗；只有「merge 完全沒把它放進任何一組」的才算。
     */
    const groupedIds = new Set();
    for (const g of groups) for (const id of g.memberIds) groupedIds.add(id);
    const vanished = indexed.filter(it => !groupedIds.has(it.ordinal));
    if (vanished.length) {
      console.log('[NIGHTLY-FIX] %d 筆候選統整後未落入任何一組（非因排隊），記一次失敗：%s',
        vanished.length, vanished.map(it => `${it.source}#${it.row.id}`).join(','));
      await noteFailedAttempt({ members: vanished }, '統整（merge）未把此候選納入任何一組')
        .catch(e => console.error('[NIGHTLY-FIX] 對帳記錄失敗次數時又出錯：', e.message));
    }

    if (!groups.length) {
      console.log('[NIGHTLY-FIX] %d 筆候選統整後沒有可執行的組', candidates.length);
      return { attempted: 0, applied: 0, skipped: 0 };
    }

    // ⚠ 上限套在**統整後**的條數：統整前就砍會把「其實是同一件事的 8 筆」誤當成 8 條工作。
    const capped = groups.slice(0, NIGHTLY_FIX_MAX);
    const skipped = groups.length - capped.length;
    console.log('[NIGHTLY-FIX] 候選 %d 筆 → 統整 %d 組 → 本批次執行 %d 組（截止 %s）',
      candidates.length, groups.length, capped.length, deadlineAt.toISOString());

    const { rows: [run] } = await query(
      `INSERT INTO health_check_runs (status, window_days, started_by, cadence) VALUES ('running',$1,$2,$3) RETURNING id`,
      [BATCH_WINDOW_DAYS, startedBy, BATCH_CADENCE]
    );
    runId = run.id;

    let attempted = 0;
    let applied = 0;

    for (const group of capped) {
      const fuse = await fuseTripped(deadlineAt, batchStartedAt);
      if (fuse) {
        console.log('[NIGHTLY-FIX] 保險絲跳了（%s），不再開新的一條（已跑 %d 條）', fuse, attempted);
        break;
      }

      /**
       * 2-I1：維護視窗續期。保險絲是「開跑之前」檢查（見 fuseTripped 的檔頭註解），單一候選最壞
       * 可跑到 ~90 分鐘（measureTests × 2 ＋ platform-fix ＋ fix-review ＋ 重跑一次）；
       * NIGHTLY_FIX_MAINTENANCE_MS 卻只有 4 小時且只在批次一開始 enterMaintenance 過一次、
       * 不會自動續期。自動排程路徑（22:30 起跑、02:00 截止）最後一條可能 01:59 才開始、03:30 才
       * 結束，維護旗標卻在 02:30 到期——中間整整一小時 cron 會恢復派工，然後 restartSelf() 把
       * 剛派出去的 agent 全砍掉留下 `*_running` 孤兒，正是維護視窗存在的理由，而且完全靜默。
       * 選這個做法而非把 NIGHTLY_FIX_MAINTENANCE_MS 拉大：拉大治標不治本（仍有理論上限，且會讓
       * 「批次真的卡死不動」時的維護旗標多佔用好幾小時）。enterMaintenance 是冪等的 UPSERT
       * （見 maintenance.js），這裡每條開始前續期一次，成本只是一個 UPDATE；只要批次仍在推進，
       * 視窗就跟著往後延，一旦卡死不再有候選開跑，旗標仍會在最後一次續期後的原定時間到期解除。
       */
      await enterMaintenance().catch(e => console.error('[NIGHTLY-FIX] 維護視窗續期失敗：', e.message));

      // ⚠ 每條各自 try/catch：adoptFix（狀態不符）與 applyFix（主 clone 髒、與 origin 分岔、
      // push 失敗、查不到容器名）都會拋。不接住的話第一條死掉後面全不跑。
      let cand = null;
      // ⚠ merged 要跟著 cand 一起帶出 try：result.merged 為 true 之後，markGroupDone 仍可能拋錯
      // （例如來源列被別處刪掉）而落進下面的 catch。這種情況碼已經合併成功，catch 卻無條件
      // noteFailedAttempt 的話，會把「合併成功、只是收尾失敗」記成失敗額度——訊息與事實相反：
      // 使用者會看到自己核准的意見先顯示已核准、幾晚後又跳回待處理並掛著「連續失敗」，但碼其實
      // 早就在 master 上了。catch 裡要用 `!merged` 擋掉這種情況。
      //
      // ⚠ 但「什麼都不記」也不對：若 markGroupDone **持續**拋錯（來源列被刪、FK、DB 暫時性錯誤），
      // 該候選的 status 會永遠停在 approved、fix_attempts 永遠 0——每晚重付 triage、重跑兩次全套
      // 測試、重新 merge 進 master、重啟平台一次，且永久佔掉 NIGHTLY_FIX_MAX 一格。這是「碼已合併
      // 但收尾失敗」的第三種結局，不併進 merged／failed 任一格：走專屬的 retireToHuman，文案明講
      // 「碼已合併進 master」——這是使用者與管理員最需要知道的一句。
      let merged = false;
      try {
        cand = await materializeGroup(group, runId);
        attempted += 1;
        const result = await runOneCandidate(cand, { pushUserId, startedBy });
        if (result.merged) {
          // ⚠ mergedAny 要在這裡就設：碼此刻已經在 master 上了。就算下面標記失敗，平台也必須
          // 重啟才會載到新碼——不重啟的話現象是「碼進去了、畫面卻什麼都沒變」。
          mergedAny = true;
          merged = true;
          // 反過來，計數要等標記成功才加：markGroupDone 拋錯代表來源沒被標掉，這一條隔晚會對
          // 已經合併的碼再跑一次，此時報「applied+1」是高報。
          try {
            await markGroupDone(cand, pushUserId || startedBy);
            applied += 1;
          } catch (doneErr) {
            console.error('[NIGHTLY-FIX] 提案 #%d 碼已合併但標記來源失敗，退回人工確認：%s',
              cand.findingId, doneErr.message);
            for (const it of cand.members) {
              await retireToHuman(it.source === 'feedback', it.row.id,
                `碼已合併進 master，但標記來源失敗，請人工確認並手動結案：${doneErr.message}`)
                .catch(e => console.error('[NIGHTLY-FIX] 退回人工時又出錯：', e.message));
            }
          }
        } else if (result.retire) {
          // no_change：一次即退場，不走「累加到門檻」那條路（見 runOneCandidate 內的說明）。
          // ⚠ 對照 markGroupDone 失敗那段：每個成員各自 `.catch`，不讓單一成員退場失敗逃到外層
          // catch。逃出去的話 cand 非 null、merged 為 false，外層會對**全部**成員（含已經退場
          // 成功、fix_attempts 剛被歸零的那幾個）再跑一次 noteFailedAttempt，把計數從 0 灌回 1。
          for (const it of cand.members) {
            await retireToHuman(it.source === 'feedback', it.row.id, result.reason)
              .catch(e => console.error('[NIGHTLY-FIX] 提案 #%d 成員 %s#%d 退場失敗：%s',
                cand.findingId, it.source, it.row.id, e.message));
          }
          console.log('[NIGHTLY-FIX] 提案 #%d 已因 no_change 立即退場', cand.findingId);
        } else if (result.deferred) {
          // deferred＝改好也審過了，只是合併當下平台狀態不允許（主 clone 髒／分岔／push 失敗）。
          // 同 adopted 一樣不燒失敗額度，但一定要留痕：不留的話畫面上跟「今晚沒輪到它」無法區分。
          await noteDeferred(cand, result.reason).catch(e =>
            console.error('[NIGHTLY-FIX] 記錄延後原因時又出錯：', e.message));
        } else if (!result.adopted) {
          // adopted＝修好了只差沒有推送身分（設定問題），不該算在這一條的失敗額度裡，
          // 否則一次設定疏漏就會把當晚每一條的退場額度都燒掉。
          await noteFailedAttempt(cand, result.reason).catch(e =>
            console.error('[NIGHTLY-FIX] 記錄失敗次數時又出錯：', e.message));
        }
      } catch (err) {
        console.error('[NIGHTLY-FIX] 這一條中止（%s）：%s', group.title, err.message);
        if (cand) {
          if (!merged) await noteFailedAttempt(cand, err.message).catch(e =>
            console.error('[NIGHTLY-FIX] 記錄失敗次數時又出錯：', e.message));
        } else {
          // materializeGroup 自己就拋錯：cand 從沒建出來，但這一條確實試過了（不記的話摘要行
          // 「嘗試 N 條」會低報），來源成員也確實沒能推進，要照樣記次——noteFailedAttempt
          // 只用得到 cand.members，不需要完整的 cand。
          attempted += 1;
          await noteFailedAttempt({ members: group.members }, err.message).catch(e =>
            console.error('[NIGHTLY-FIX] 記錄失敗次數時又出錯：', e.message));
        }
      } finally {
        // 這一條走完（成功、退場、失敗、拋錯都算）就把「處理中」收掉。放 finally 而不是各分支
        // 各寫一次：漏掉任一條路徑，那一列就會永遠掛著轉圈動畫，而它其實早就跑完了。
        await setStage((cand || group).members, null);
      }
    }

    console.log('[NIGHTLY-FIX] 本批次結束：嘗試 %d 條、合併 %d 條、超出上限未跑 %d 條', attempted, applied, skipped);

    // skipped：統整後超出 NIGHTLY_FIX_MAX、連跑都沒跑到的組數
    return { attempted, applied, skipped };
  } finally {
    // ⚠ 這三件事的順序不可調換，而且都要在 finally：
    // 1. 收掉 run——不論是正常跑完、保險絲查詢拋錯、還是整批拋錯，都不能讓它停在 running
    //    （停在 running 會讓健檢頁永遠顯示「執行中」，也讓下一輪排程誤判上一輪還沒結束）
    if (runId != null) {
      await query(`UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1`, [runId])
        .catch(err => console.error('[NIGHTLY-FIX] 收尾 health_check_runs 失敗：', err.message));
    }
    // 兜底清 batch_stage：上面每一條各自的 finally 已經清過自己，但 triage 途中拋錯、或哪天新增
    // 了漏清的路徑，殘留的值會讓那一列永遠轉圈。整批清一次，代價是兩句 UPDATE。
    for (const t of ['feedback', 'health_check_findings']) {
      await query(`UPDATE ${t} SET batch_stage=NULL WHERE batch_stage IS NOT NULL`)
        .catch(err => console.error('[NIGHTLY-FIX] 收尾清 batch_stage 失敗：', err.message));
    }
    // 2. 清旗標——一定要排在重啟指令之前。那道指令會把這個行程一起帶走，排在後面的話不保證
    //    跑得到，維護旗標就會留到 4 小時後才自動到期，期間派工全部停擺。
    if (entered) await leaveMaintenance().catch(() => {});
    // 3. 一條都沒合併成功就不重啟：沒有新碼進 master，重啟只是白白中斷服務。
    if (mergedAny) await restartSelf();
  }
}

async function restartSelf() {
  try {
    const container = await selfContainerName();
    console.log('[NIGHTLY-FIX] 重啟平台容器 %s 讓新碼生效', container);
    execFile('docker', ['restart', container], err => {
      if (err) console.error('[NIGHTLY-FIX] restart:', err.message);
    });
  } catch (err) {
    // 查不到容器名＝重啟不了。碼已經在 master 上，人工重啟即可——但一定要留下這行字，
    // 否則現象會是「平台跑著舊碼、畫面上什麼都沒變」。
    console.error('[NIGHTLY-FIX] 查不到平台容器，碼已合併但未重啟，請人工重啟：', err.message);
  }
}

module.exports = { runNightlyFix, _setClockForTesting, MACHINE_RETIRE_PREFIX };
