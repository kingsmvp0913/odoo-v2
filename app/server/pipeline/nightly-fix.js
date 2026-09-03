const { execFile } = require('child_process');
const { query } = require('../db');
const { enterMaintenance, leaveMaintenance } = require('./maintenance');
const { triageOne, mergeCandidates } = require('./feedback-triage');
const { reviewFix } = require('./fix-review');
const { runFix, adoptFix, applyFix, pickSelfContainer } = require('./finding-fix');

/**
 * nightly-fix.js — 夜間批次編排器：意見回饋通道的核心。
 *
 * 進維護視窗 → 撈候選（意見回饋 approved ＋ 健檢提案 approved）→ triage → 統整 → 逐條
 * 走完整條鏈（runFix → fix-review → adopt → applyFix 只合併）→ 全部跑完才重啟一次。
 *
 * ⚠ 這是「平台自己改自己」的最後一段自動化，任何一步失敗都不能讓維護旗標卡死——
 * 那會讓派工從此安靜停擺（見 maintenance.js 的三道保險）。
 */

const NIGHTLY_FIX_MAX = parseInt(process.env.NIGHTLY_FIX_MAX || '5', 10);
const NIGHTLY_FIX_MAX_RETRY = parseInt(process.env.NIGHTLY_FIX_MAX_RETRY || '1', 10);
const NIGHTLY_FIX_DEADLINE_HOUR = parseInt(process.env.NIGHTLY_FIX_DEADLINE_HOUR || '2', 10);
const NIGHTLY_FIX_TOKEN_BUDGET = parseInt(process.env.NIGHTLY_FIX_TOKEN_BUDGET || '12000000', 10);
const NIGHTLY_FIX_DRAIN_MAX_MS = parseInt(process.env.NIGHTLY_FIX_DRAIN_MAX_MS || '1800000', 10);
const DRAIN_POLL_MS = 60000;
const TIME_ZONE = 'Asia/Taipei';

// 可自動修的 layer；健檢候選的嚴重度門檻。意見回饋不套嚴重度——人親自核准過就是把關。
const AUTO_LAYERS = new Set(['code', 'prompt', 'observability']);
const HEALTH_SEVERITIES = new Set(['medium', 'high', 'error']);

let _clockForTesting = null;
function _setClockForTesting(clock) { _clockForTesting = clock; }
function now() { return _clockForTesting ? _clockForTesting() : new Date(); }

// 比照 cron.js 的 taipeiDateParts：只取當地時（deadline 判斷只需要這個）。
function taipeiHour(d) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: '2-digit', hour12: false
  }).formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return Number(values.hour) % 24; // 24 是 en-US 對午夜的表示法，正規化成 0
}

// getInflightInfo 延到函式內才 require：nightly-fix 不該在載入時就拉進 runner（避免循環依賴，
// runner.js 之後串接本模組——Task 7.3）。
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

// 健檢提案候選：approved 的 proposal，套 severity 門檻與可自動修的 layer（已知 layer，可在此就篩）。
async function fetchHealthCandidates() {
  const { rows: hc } = await query(
    `SELECT id, agent_label AS title, diagnosis AS detail, layer, severity, rationale AS action,
            risk_if_wrong, target_metric, metric_baseline, evidence, created_at
       FROM health_check_findings
      WHERE status = 'approved' AND kind = 'proposal'
      ORDER BY created_at ASC`
  );
  return hc
    .filter(h => AUTO_LAYERS.has(h.layer) && HEALTH_SEVERITIES.has(h.severity))
    .map(h => ({ source: 'finding', row: h }));
}

// 意見回饋候選：approved 但**尚未 triage**（triage_layer 還是 NULL，layer 要等 triageOne 跑完才知道，
// 不可在這裡先套 layer 條件）。不套嚴重度——人親自核准過就是把關。
async function fetchApprovedFeedback() {
  const { rows: fb } = await query(
    `SELECT id, content, user_id, created_at FROM feedback WHERE status = 'approved' ORDER BY created_at ASC`
  );
  return fb.map(f => ({ source: 'feedback', row: f }));
}

// 意見回饋跑 triageOne：把使用者原文翻成具體修改需求，順便補上 layer（觸發本函式前 layer 未知）。
// 回 understandable:false 的剔除（triageOne 內部已把 status 退回 'new'）；翻譯出來的 layer 不在
// 可自動修範圍（例如 env）也剔除——篩掉的意見留在原地不動狀態，不做任何寫入。
async function triageFeedback(items) {
  const kept = [];
  for (const it of items) {
    const { understandable } = await triageOne(it.row.id);
    if (!understandable) continue;
    const { rows: [refreshed] } = await query(
      `SELECT id, triage_title AS title, triage_detail AS detail, triage_layer AS layer,
              triage_action AS action, verify_route, user_id, created_at
         FROM feedback WHERE id=$1`, [it.row.id]);
    if (!AUTO_LAYERS.has(refreshed.layer)) continue;
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

function toCandidateItem(it) {
  return { id: it.row.id, source: it.source, title: it.row.title || '(無標題)', detail: it.row.detail || '' };
}

// 統整後的一組 → 準備寫進 health_check_findings 的欄位（不重建健檢來源的既有 finding）。
async function feedbackEvidence(memberIds, byKey) {
  const notes = [];
  for (const id of memberIds) {
    const it = byKey.get(`feedback:${id}`);
    if (!it) continue;
    const { rows: [u] } = await query('SELECT display_name, username FROM users WHERE id=$1', [it.row.user_id]);
    const who = (u && (u.display_name || u.username)) || '匿名';
    const when = new Date(it.row.created_at).toISOString();
    notes.push(`使用者 ${who} 於 ${when} 回報`);
  }
  return notes.length ? notes.join('\n') : null;
}

// 一組只有單一健檢提案成員（沒有意見回饋、沒有被合併）：健檢來源本來就有 finding，不重建，
// 直接沿用既有 id——重建會讓 fix-review 之後的 applyFix 標「done」寫錯 finding、也會讓健檢頁
// 出現一條看起來一樣但脈絡全新的重複列。
function soleFindingId(memberIds, byKey) {
  if (memberIds.length !== 1) return null;
  const it = byKey.get(`finding:${memberIds[0]}`);
  return it ? it.row.id : null;
}

async function materializeGroup(group, byKey, runId) {
  const memberIds = Array.isArray(group.member_ids) ? group.member_ids : [];
  const reuseId = soleFindingId(memberIds, byKey);

  const base = {
    title: group.title || '(無標題)',
    detail: group.detail || '',
    action: group.action || '',
    layer: group.layer || 'code',
    verify_route: group.verify_route || '',
    risk_if_wrong: null,
    member_ids: memberIds,
  };

  if (reuseId != null) return { findingId: reuseId, ...base };

  // 一組裡若含意見回饋成員，補上「誰在何時回報」；純健檢提案（多筆合併）沒有單一原文可附。
  const hasFeedback = memberIds.some(id => byKey.has(`feedback:${id}`));
  const evidence = hasFeedback ? await feedbackEvidence(memberIds, byKey) : null;

  // ⚠ health_check_findings 沒有 verify_route 欄位（那是 feedback 表才有的）；merge 產出的
  // verify_route 只在記憶體內傳給 reviewFix 判斷要不要截圖，不落地。
  const { rows: [row] } = await query(
    `INSERT INTO health_check_findings
       (run_id, agent_name, agent_label, diagnosis, severity, rationale, kind, layer, evidence)
     VALUES ($1,'feedback',$2,$3,'medium',$4,'proposal',$5,$6)
     RETURNING id`,
    [runId, base.title, base.detail, base.action || null, base.layer, evidence]
  );
  return { findingId: row.id, ...base };
}

// 逐條走完整條鏈：runFix → (通過測試才)fix-review → reject 重跑一次 → adopt →
// applyFix(只合併，僅在有 pushUserId 時)。
//
// pushUserId 為 null（teams_settings.cli_push_user_id 未設定）：整批停在 adopted，不呼叫
// applyFix——不得寫死 user id，也不得代為決定用誰的身分推。
async function runOneCandidate(cand, { pushUserId, startedBy }) {
  let fixId = await createFixRow(cand.findingId, startedBy);
  await runFix(fixId, { findingId: cand.findingId, startedBy });

  let attempt = 0;
  for (;;) {
    const { rows: [fix] } = await query('SELECT status FROM finding_fixes WHERE id=$1', [fixId]);
    if (!fix || fix.status !== 'ready') return { merged: false };

    const verdict = await reviewFix(fixId, cand);
    if (verdict.verdict === 'approve') {
      if (!pushUserId) {
        await adoptFix(fixId, startedBy);
        console.error('[NIGHTLY-FIX] 未設定 CLI 推送身分（teams_settings.cli_push_user_id 為空），'
          + `提案 #${cand.findingId} 停在 adopted，不合併不重啟`);
        return { merged: false, adopted: true, fixId };
      }
      await adoptFix(fixId, pushUserId);
      // ⚠ inflight 傳非空值 ⇒ 只合併不重啟。
      await applyFix(fixId, pushUserId, ['nightly-fix']);
      return { merged: true, fixId };
    }

    // reviewFix 只回 verdict，不落地——記到這一筆 finding_fixes，否則審查理由無跡可尋。
    await query(`UPDATE finding_fixes SET reject_reason=$2 WHERE id=$1`, [fixId, verdict.reason || '審查未通過']);

    attempt += 1;
    if (attempt > NIGHTLY_FIX_MAX_RETRY) return { merged: false };

    // 退回改一次：開新的一筆 finding_fixes 重跑（不覆寫舊列，finding_fixes 本來就是為
    // 「一條提案可試修多次」設計的）。
    fixId = await createFixRow(cand.findingId, startedBy);
    await runFix(fixId, { findingId: cand.findingId, startedBy });
  }
}

async function createFixRow(findingId, startedBy) {
  const { rows: [row] } = await query(
    `INSERT INTO finding_fixes (finding_id, status, created_by) VALUES ($1,'running',$2) RETURNING id`,
    [findingId, startedBy || null]
  );
  return row.id;
}

/**
 * runNightlyFix({ startedBy }) -> { attempted, applied, skipped, reason? }
 */
async function runNightlyFix({ startedBy = null } = {}) {
  const batchStartedAt = now().toISOString();
  let entered = false;
  let mergedAny = false;

  try {
    await enterMaintenance();
    entered = true;

    const drained = await waitForDrain();
    if (!drained) {
      return { attempted: 0, applied: 0, skipped: 0, reason: 'drain-timeout' };
    }

    const healthCandidates = await fetchHealthCandidates();
    const feedbackCandidates = await triageFeedback(await fetchApprovedFeedback());
    const candidates = sortCandidates(feedbackCandidates, healthCandidates);
    if (!candidates.length) return { attempted: 0, applied: 0, skipped: 0 };

    const byKey = new Map(candidates.map(it => [`${it.source}:${it.row.id}`, it]));
    const groups = await mergeCandidates(candidates.map(toCandidateItem));
    if (!groups.length) return { attempted: 0, applied: 0, skipped: 0 };

    const capped = groups.slice(0, NIGHTLY_FIX_MAX);
    const skipped = groups.length - capped.length;

    const { rows: [run] } = await query(
      `INSERT INTO health_check_runs (status, window_days, started_by)
       VALUES ('running',0,$1) RETURNING id`,
      [startedBy]
    );

    const { rows: [settings] } = await query('SELECT cli_push_user_id FROM teams_settings WHERE id=1');
    const pushUserId = settings && settings.cli_push_user_id;

    let attempted = 0;
    let applied = 0;

    for (const group of capped) {
      // 兩道保險絲在開跑前檢查：deadline、token 預算。半途中斷會留下髒 worktree 與半套 diff。
      if (taipeiHour(now()) >= NIGHTLY_FIX_DEADLINE_HOUR) break;
      if (await tokensSince(batchStartedAt) >= NIGHTLY_FIX_TOKEN_BUDGET) break;

      const cand = await materializeGroup(group, byKey, run.id);
      attempted += 1;

      const result = await runOneCandidate(cand, { pushUserId, startedBy });
      if (result.merged) { applied += 1; mergedAny = true; }
    }

    await query(`UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1`, [run.id]);

    // skipped：統整後超出 NIGHTLY_FIX_MAX 上限、連跑都沒跑到的組數（不含開跑前就 break 掉的
    // 剩餘 capped 項目——那些歸在 attempted 之外、既非 applied 也非本欄定義的「上限之外」）。
    return { attempted, applied, skipped };
  } finally {
    // 清旗標要排在重啟指令之前：docker restart 會把這個行程一起帶走，之後的程式碼不保證跑得到。
    if (entered) await leaveMaintenance().catch(() => {});
    if (mergedAny) {
      try {
        const container = await pickSelfContainerSafe();
        if (container) {
          execFile('docker', ['restart', container], err => {
            if (err) console.error('[NIGHTLY-FIX] restart:', err.message);
          });
        }
      } catch (err) {
        console.error('[NIGHTLY-FIX] restart lookup:', err.message);
      }
    }
  }
}

// docker ps/inspect 查容器名，沿用 finding-fix.js 的 pickSelfContainer 判定規則（唯一命中才重啟）。
async function pickSelfContainerSafe() {
  const os = require('os');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  if (process.env.PLATFORM_CONTAINER) return process.env.PLATFORM_CONTAINER;
  try {
    const { stdout: names } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}']);
    const list = names.split('\n').map(s => s.trim()).filter(Boolean);
    if (!list.length) return null;
    const { stdout } = await execFileAsync(
      'docker', ['inspect', '--format', '{{.Name}}\t{{.Config.Hostname}}', ...list], { maxBuffer: 8 * 1024 * 1024 });
    return pickSelfContainer(stdout, os.hostname());
  } catch (err) {
    console.error('[NIGHTLY-FIX] pickSelfContainer:', err.message);
    return null;
  }
}

module.exports = { runNightlyFix, _setClockForTesting };
