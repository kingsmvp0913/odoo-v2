const { execFile } = require('child_process');
const { query } = require('../db');
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

// 可自動修的 layer；健檢候選的嚴重度門檻。意見回饋不套嚴重度——人親自核准過就是把關。
const AUTO_LAYERS = new Set(['code', 'prompt', 'observability']);
const HEALTH_SEVERITIES = new Set(['medium', 'high', 'error']);

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
      ORDER BY created_at ASC`
  );
  return hc
    .filter(h => AUTO_LAYERS.has(h.layer) && HEALTH_SEVERITIES.has(h.severity))
    .map(h => ({ source: 'finding', row: h }));
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
    const { understandable } = await triageOne(it.row.id);
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
      : members.map(m => m.row.layer).find(l => AUTO_LAYERS.has(l));
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

async function materializeGroup(group, runId) {
  const reuseId = soleFindingId(group.members);
  const base = {
    title: group.title, detail: group.detail, action: group.action,
    layer: group.layer, verify_route: group.verify_route,
    risk_if_wrong: reuseId != null ? (group.members[0].row.risk_if_wrong || null) : null,
    members: group.members,
  };
  if (reuseId != null) return { findingId: reuseId, reused: true, ...base };

  const hasFeedback = group.members.some(m => m.source === 'feedback');
  const evidence = await feedbackEvidence(group.members);

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
       (run_id, agent_name, agent_label, diagnosis, severity, rationale, kind, layer, evidence, status)
     VALUES ($1,$2,$3,$4,'medium',$5,'proposal',$6,$7,'done')
     RETURNING id`,
    [runId, hasFeedback ? 'feedback' : 'health-auditor',
     base.title, base.detail, base.action || null, base.layer, evidence]
  );
  return { findingId: row.id, reused: false, ...base };
}

async function createFixRow(findingId, startedBy) {
  const { rows: [row] } = await query(
    `INSERT INTO finding_fixes (finding_id, status, created_by) VALUES ($1,'running',$2) RETURNING id`,
    [findingId, startedBy || null]
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

// 機器退場寫進 note 的標記前綴。前端用 `startsWith` 判斷（不是 SQL LIKE），所以不受
// pg-mem 把 `[...]` 當字元類別那個坑影響；但這裡選不含方括號的字面詞，避免以後有人
// 改成 SQL LIKE 查詢又踩一次。
const MACHINE_RETIRE_PREFIX = '自動退場：';

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
 * 這一晚沒能合併 → 每個來源成員的連續失敗次數 +1，達門檻就退回人工。
 *
 * 「成功才標 done」的反面是：一條**永遠**合併不了的意見（review 一直 reject、主 clone 一直髒、
 * applyFix 一直拋）會每晚重跑一次完整流程——重付一次 triage、重跑兩次 runFix（含兩次全套測試）
 * ——並且**永久佔掉 NIGHTLY_FIX_MAX 的一格**，把後來提的意見擠在後面永遠輪不到。
 * 無上限的成本＋安靜的飢餓，兩件事都不能留。
 */
async function noteFailedAttempt(cand, reason) {
  for (const it of cand.members) {
    const isFeedback = it.source === 'feedback';
    const { rows: [r] } = isFeedback
      ? await query(
        `UPDATE feedback SET fix_attempts = COALESCE(fix_attempts,0) + 1 WHERE id=$1 RETURNING fix_attempts`,
        [it.row.id])
      : await query(
        `UPDATE health_check_findings SET fix_attempts = COALESCE(fix_attempts,0) + 1 WHERE id=$1 RETURNING fix_attempts`,
        [it.row.id]);
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
  let fixId = await createFixRow(cand.findingId, startedBy);
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

    const verdict = await reviewFix(fixId, cand);
    if (verdict.verdict === 'approve') {
      if (!pushUserId) {
        await adoptFix(fixId, startedBy);
        console.error('[NIGHTLY-FIX] 未設定 CLI 推送身分（teams_settings.cli_push_user_id 為空），'
          + `提案 #${cand.findingId} 停在 adopted，不合併不重啟`);
        return { merged: false, adopted: true, fixId };
      }
      await adoptFix(fixId, pushUserId);
      // ⚠ inflight 傳非空值 ⇒ 只合併不重啟（最後才單獨重啟一次）
      await applyFix(fixId, pushUserId, ['nightly-fix']);
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
    fixId = await createFixRow(cand.findingId, startedBy);
    await runFix(fixId, { findingId: cand.findingId, startedBy });
  }
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
    const groups = normalizeGroups(await mergeCandidates(indexed.map(toCandidateItem)), byOrdinal);
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
      `INSERT INTO health_check_runs (status, window_days, started_by) VALUES ('running',$1,$2) RETURNING id`,
      [BATCH_WINDOW_DAYS, startedBy]
    );
    runId = run.id;

    const { rows: [settings] } = await query('SELECT cli_push_user_id FROM teams_settings WHERE id=1');
    const pushUserId = settings && settings.cli_push_user_id;

    let attempted = 0;
    let applied = 0;

    for (const group of capped) {
      const fuse = await fuseTripped(deadlineAt, batchStartedAt);
      if (fuse) {
        console.log('[NIGHTLY-FIX] 保險絲跳了（%s），不再開新的一條（已跑 %d 條）', fuse, attempted);
        break;
      }

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
        } else if (!result.adopted) {
          // adopted＝修好了只差沒有推送身分（設定問題），不該算在這一條的失敗額度裡，
          // 否則一次設定疏漏就會把當晚每一條的退場額度都燒掉。
          await noteFailedAttempt(cand, result.reason);
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
