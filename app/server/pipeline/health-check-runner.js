const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { listAgents, loadAgent } = require('./agent-loader');
const { runAgent } = require('./agent-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildAgentSummary, buildTaskSummary, buildWindowSummary } = require('./health-data');
const { MACHINE_RETIRE_PREFIX } = require('./retire-prefix');
const { inAutoFixScope } = require('./auto-fix-scope');

const SEVERITIES = new Set(['ok', 'low', 'medium', 'high']);

// 夜間批次（nightly-fix.js）自建的 health_check_runs 列的辨識機制：沿用既有的 cadence 欄
// （daily／weekly／monthly 已在用），不新增欄位。⚠ 這裡不 require nightly-fix.js 取常數字面值
// ——那會與它 require 本檔的方向形成循環（見 retire-prefix.js 的檔頭說明，MACHINE_RETIRE_PREFIX
// 就是同一個坑抽出來的教訓），只能各自寫死同一個字串常數，兩邊改動時要留意保持一致。
const BATCH_CADENCE = 'nightly-fix';

// 健檢子行程一律在 repo 根執行：judging 用的判準寫在 .claude/skills/healthCheck，而 headless
// claude 只認 cwd 的 project skill、不會往上層目錄找。server 是 `npm start`（cwd=app/）起的，
// 不指定 cwd 就落在 app/ 而載不到——實測從 app/ 問「有沒有 healthCheck skill」回 NONE、從 repo
// 根回 FOUND。這種缺失完全沒有訊號：agent 照跑、測試全綠，只是判準沒生效。
const REPO_ROOT = path.join(__dirname, '..', '..', '..');


// 用底線包起來的假 agent_name：findings 表的 agent_name 同時承載「哪一關」與「哪一種非
// per-agent 的診斷」，真 agent 名不可能撞。
// ⚠ 這裡原本還有 __system__／__summary__／__triage__ 三個，屬已退役的逐關診斷（runHealthCheck）。
// 那條路徑最後一次實際執行是 2026-08-20，已整條移除；舊資料仍留在 findings 表，前端不再顯示。
const TASK_AGENT = '__task__';
const TASK_LABEL = '任務健檢';

// 解析失敗時把模型原始輸出落檔。opus 早就把診斷寫出來了（run#2 失敗的四份各 5–7k output
// tokens、跑了 84–125 秒），只因收尾格式不合就整份丟掉，而且沒有任何地方留存——下次同樣的
// 失敗依舊無從查起。落檔後至少「為什麼解析不過」變成可回答的問題。
// 預設與 deploy／E2E 共用 data/logs，故一併吃 cron 的過期清理。
function saveRawOutput(runId, agentName, raw) {
  if (!raw) return '';                                      // 連呼叫都沒成功，沒有東西可存
  const file = `health-run${runId}-${agentName}.log`;
  try {
    const dir = process.env.HEALTH_LOG_DIR || path.join(__dirname, '..', '..', '..', 'data', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), raw);
    return `（模型有回應但結果解析不過；原始輸出已存 ${file}）`;
  } catch (err) {
    console.error('[HEALTH-CHECK] raw dump:', err.message);
    return '';
  }
}

// 收成失敗，並把原因留下來。原本只寫 status='error'，為什麼掛的沒有任何地方存——實測 run#19
// （2026-09-03 23:00 的自動健檢）隔天完全查不出原因，只能猜。
// ⚠ 這件事在「管理頁只看提案」之後更要緊：健檢掛掉時它一筆提案都不會產生，畫面上跟「今晚本來
// 就沒事做」長得一模一樣（此 repo 踩過：夜班空轉 98 輪無人察覺）。這一欄是唯一的分辨依據。
async function failRun(runId, reason) {
  await query(
    "UPDATE health_check_runs SET status='error', error=$2, finished_at=NOW() WHERE id=$1",
    [runId, String(reason || '').slice(0, 2000) || '（未附原因）']
  ).catch(err => console.error('[HEALTH-CHECK] 收 error 失敗：', err.message));
}

// scope=task：把一張任務跨關卡展開跑一次診斷。與全平台健檢共用同一張 findings 表與同一份判準
//（.claude/skills/healthCheck）——兩者是同一批資料的兩個投影，不是兩套分析：前者跨任務聚合看
// 某一關，後者跨關卡展開看某一張。
// 刻意只跑一次呼叫、不套用「分流→深診」：分流存在的理由是決定「花錢深看哪幾關」，單張任務沒有
// 這個取捨；而依判準，單張任務的證據本來就不得產生提示詞改動（一張任務走過七關會在七處各出現
// 一次，用次數算會把一件事誤算成七個獨立證據），深診那半段在這裡沒有出口。
async function runTaskHealthCheck(runId, { taskDbId, startedBy = null } = {}) {
  // status 依 kind 明確帶值、不吃欄位 DEFAULT：kind='agent'（一般診斷）維持 pending；
  // kind='proposal'（挖到平台 bug，見下方 layer==='platform' 分支）比照 runAudit 走 approved，
  // 兩者是同一個「提案通道」概念，不該因為來源是單張任務診斷就少了自動核准。
  const insert =
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale, kind, layer, status)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9)`;
  try {
    const summary = await buildTaskSummary(taskDbId);
    // 任務不存在要落成看得見的失敗：run 停在 running 或空白收尾，畫面上跟「還在跑」長得一樣。
    if (!summary) {
      await query(insert, [runId, TASK_AGENT, TASK_LABEL, `找不到任務（tasks.id=${taskDbId}）`, 'error', null, 'agent', null, 'pending']);
      await failRun(runId, `找不到任務（tasks.id=${taskDbId}）`);
      return;
    }
    const agent = loadAgent('health-task');
    const prompt = agent.render({ summary: JSON.stringify(summary) });

    let finding = null;
    let raw = null;
    try {
      const { text, usage, durationMs } = await runAgent(prompt, { model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'workflow_health', cwd: REPO_ROOT });
      raw = text;
      // taskId 一律給 null（不是漏填）：健檢自己的花費若記進被診斷的那張任務，下次再健檢同一張，
      // 它就會在自己的 per_stage 與關卡序列裡看到 workflow_health——診斷工具污染被診斷的對象。
      await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);
      const { inner: diagBlock, cleaned: afterDiag } = extractTaggedBlock(text, 'diagnosis');
      const { inner: ratBlock, cleaned } = extractTaggedBlock(afterDiag, 'rationale');
      const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
      const severity = String((parsed && parsed.severity) || '').trim().toLowerCase();
      const diagnosis = String((diagBlock || (parsed && parsed.diagnosis)) || '').trim();
      if (diagnosis && SEVERITIES.has(severity)) {
        finding = {
          severity, diagnosis,
          rationale: (ratBlock && ratBlock.trim()) || (parsed && parsed.rationale) || null,
          layer: String((parsed && parsed.layer) || '').trim().toLowerCase() === 'platform' ? 'platform' : null
        };
      }
    } catch (err) {
      await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', err);
    }
    if (!finding) {
      finding = {
        severity: 'error',
        diagnosis: '健檢失敗：無法取得有效診斷' + saveRawOutput(runId, TASK_AGENT, raw),
        rationale: null, layer: null
      };
    }
    // suggested_prompt 永遠是 NULL：單張任務的證據不足以改全平台的提示詞（判準的紅旗之一）。
    // 前端的「帶入編輯器」按鈕只在有 suggested_prompt 時才出現，所以這一關自然不會把人導去改 prompt。
    //
    // layer='platform' 是唯一的例外出口，落 kind='proposal'（＝畫面上出得來「🔧 修這條」、後端 fix
    // 端點也才收）。判準對「一張任務不算證據」的限制是**針對提示詞**的：一關的 prompt 改動會影響
    // 所有任務，而一張任務走過七關會在七處各出現一次，用次數算會把一件事誤算成七個獨立證據。平台
    // 程式的 bug 不吃這個折扣——它是決定性的，一次重現就成立，判準自己也寫「平台程式碼 bug 一律列入，
    // 走獨立出口」。原本這裡一律落 kind='agent'，等於連那條出口一起堵死：任務健檢挖到平台 bug 也
    // 只能寫成一段字給人自己去改（task 184 的 QA 拿舊規格審查即是一例）。
    const kind = finding.layer === 'platform' ? 'proposal' : 'agent';
    const status = kind === 'proposal' ? 'approved' : 'pending';
    await query(insert, [runId, TASK_AGENT, TASK_LABEL, finding.diagnosis, finding.severity, finding.rationale, kind, finding.layer, status]);
    await query("UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1", [runId]);
  } catch (err) {
    console.error('[HEALTH-CHECK] task:', err.message);
    await failRun(runId, err.message);
  }
}

// ── 主導型健檢（scope=platform 的現行做法）────────────────────────────────────────
// 舊做法是「程式把 21 關的摘要算好 → 每關各跑一次 opus → 再把結論拼起來」。它答的是「每一關健不
// 健康」，但真正要的是「這個系統下一步該做什麼優化」——那是跨關的問題，逐關切片天生答不出來。
// 現在改成一支審計 agent 自己主導：程式只給一份增量視窗的輪廓，它自己下 SQL 深挖、自己讀提示詞、
// 自己回溯到更早的資料找同類案例湊證據，最後輸出「提案清單」而不是「逐關診斷」。
const AUDIT_AGENT = '__audit__';
// 主導型健檢會自己反覆下 SQL 回溯查證，比舊的「程式餵好摘要、一問一答」慢得多——實測 2026-08-21
// 用當年的 600s 預設直接逾時、整輪報廢。現在與共用上限同值，旋鈕保留供本關單獨再放寬。
const AUDIT_TIMEOUT_MS = parseInt(process.env.HEALTH_AUDIT_TIMEOUT_MS || '2400000', 10);

const STATUS_TEXT = { pending: '待處理', approved: '已核准（將自動執行）', no_change: '不須調整', done: '處理完成' };

// 上一輪留下的提案與人的裁決。餵回去有兩個作用：判「不須調整」的不會被重講第二次；判「處理完成」
// 的要回頭查那個指標有沒有往預期方向走。這是把健檢從「每輪重寫一份報告」變成「有記憶的優化迴圈」
// 的關鍵——尤其視窗改成增量之後，沒有它每輪都會從零開始。
async function previousProposals(limit = 20) {
  const { rows } = await query(
    `SELECT diagnosis, layer, status, verdict_note, target_metric, metric_baseline, applied_at, kind, decided_at
       FROM health_check_findings
      WHERE kind IN ('proposal','signal') ORDER BY id DESC LIMIT $1`, [limit]
  );
  if (!rows.length) return '（這是第一輪，沒有上一輪的提案）';
  return rows.reverse().map(r => {
    const head = String(r.diagnosis || '').split('\n')[0].slice(0, 200);
    const applied = r.applied_at ? `；於 ${new Date(r.applied_at).toISOString().slice(0, 10)} 套用` : '';
    // 帶 MACHINE_RETIRE_PREFIX 的 note 是夜間批次自己寫的，不是人的裁決——冠「你的裁決」等於把
    // 機器自己的輸出貼上人類標籤送回去當跨輪記憶，auditor 讀到會誤以為是人在跟它對話。
    // ⚠ 光看前綴不夠：管理員按「待處理」但沒清空預填的機器 note 時，那筆 note 仍以前綴開頭卻
    // 確實是人的裁決（decided_at 非 NULL）。要跟前端 isMachineRetired 對齊——帶前綴「且」
    // decided_at 為 NULL 才算機器退場，否則這裡會把人的裁決誤標成「夜間批次自動退場」餵回去。
    const verdict = r.verdict_note
      ? ((r.verdict_note.startsWith(MACHINE_RETIRE_PREFIX) && !r.decided_at)
          ? `\n  夜間批次自動退場：${r.verdict_note.slice(MACHINE_RETIRE_PREFIX.length)}`
          : `\n  你的裁決：${r.verdict_note}`)
      : '';
    return `- [${r.kind === 'signal' ? '候選訊號' : '提案'}｜${r.layer || '未分類'}｜${STATUS_TEXT[r.status] || r.status}] ${head}\n` +
           `  指標：${r.target_metric || '（未填）'}（當時 ${r.metric_baseline || '—'}）${applied}${verdict}`;
  }).join('\n');
}

async function insertFinding(runId, row) {
  // status 明確帶值、不依賴欄位 DEFAULT：DEFAULT 已改成 approved（Phase 7.1，讓 proposal 當晚
  // 自動實作），但 signal（證據還不夠）／summary（總結敘述）／note（零樣本、解析失敗）都不是
  // 「可核准、會被自動修」的條目，混著吃到 DEFAULT 會把它們也標成 approved 送進夜間批次。
  //
  // 2-I2：proposal 還要再依 severity／layer 分岔——不符合 nightly-fix.js 的自動修範圍
  // （layer 不在 code／prompt／observability，或 severity 是 low／ok）的提案，落 approved
  // 會讓管理頁寫著「已核准（將自動執行）」，但 fetchHealthCandidates 永遠篩不到它，狀態說謊；
  // 而 open_count（admin-routes.js）只算 status='pending'，這些提案又會從待處理清單裡消失，
  // 三邊互相矛盾。规格 §255／§257 明寫「low／ok 與超出自動範圍的都留在管理頁給人決定」——
  // 落 pending 才是誠實的初始狀態，人要核准仍可以核准（核准後才變 approved，屆時才真的會被撈）。
  const auto = row.kind === 'proposal' && inAutoFixScope(row.layer || null, row.severity || null);
  const status = auto ? 'approved' : 'pending';
  const { rows: [f] } = await query(
    `INSERT INTO health_check_findings
       (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale,
        kind, layer, evidence, target_metric, metric_baseline, risk_if_wrong, status)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [runId, AUDIT_AGENT, row.label || '系統健檢', row.diagnosis, row.severity, row.rationale || null,
     row.kind, row.layer || null, row.evidence || null, row.target_metric || null, row.metric_baseline || null,
     row.risk_if_wrong || null, status]
  );
  if (auto) await openFeedbackForFinding(f.id, row);
}

// 中等以上的提案同時在「意見回饋管理」開一筆，預設已核准。那一頁是唯一的待辦收斂處：使用者提的
// 意見與健檢挖出來的問題最後都要有人決定做不做，分兩個畫面管等於要記得兩個地方都要看。
//
// user_id 留 NULL＝提交者是 AI 健檢（前端據此顯示，見 AdminFeedback.js）。
// triage_* 直接用健檢的產出填好：health-auditor 的輸出本來就是「標題／細節／根因層／建議做法」
// 那個形狀，跟 feedback-triage 要翻出來的東西一模一樣，再花一次 opus 去翻是白燒。
// finding_id 連回來源，也是「這條已經開過單」的唯一憑據——nightly-fix 的 fetchHealthCandidates
// 靠它排除掉已開單的提案，否則同一條會被當成兩個候選跑兩遍。
async function openFeedbackForFinding(findingId, row) {
  try {
    // 先查再插，不用 `INSERT ... SELECT ... WHERE NOT EXISTS` 的單句寫法：pg-mem 解析不了
    // 帶參數的 EXISTS（實測 `function exists(integer[]) does not exist`），整支測試會紅在
    // 一個與正式環境無關的地方。健檢一次只跑一輪，這裡沒有並發插入的競態。
    const { rows: dup } = await query('SELECT 1 FROM feedback WHERE finding_id = $1 LIMIT 1', [findingId]);
    if (dup.length) return;
    await query(
      `INSERT INTO feedback (user_id, content, status, triage_title, triage_detail, triage_layer,
                             triage_action, finding_id)
       VALUES (NULL, $1, 'approved', $2, $3, $4, $5, $6)`,
      [row.diagnosis, row.label || '系統健檢', row.diagnosis, row.layer || null,
       row.rationale || null, findingId]
    );
  } catch (err) {
    // 開單失敗不能讓整輪健檢報廢——提案本身已經寫進 findings 了，人還是看得到。
    console.error('[HEALTH-CHECK] 健檢提案開單失敗：', err.message);
  }
}

// 趨勢比對的資料塊：把「上一期同長度視窗」的量體與各關指標一起餵進去，讓 agent 回答得了
// 「上一期標成處理完成的提案，指標有沒有真的往預期方向走」。只給每月的 30 天大健檢——日／週視窗
// 太短，兩期之間的差多半是樣本雜訊，硬要比只會生出沒有證據的提案。
// 只取 volume 與 per_stage，不帶 tasks／rejections 明細：這是拿來對照數字的，帶明細會把上一期的
// 個案原封不動再講一次（而那些多半已在上一輪提過、也已被裁決）。
async function buildTrendBlock(sinceAt) {
  const start = new Date(sinceAt);
  const prev = await buildWindowSummary(new Date(start.getTime() - (Date.now() - start.getTime())), start);
  return JSON.stringify({ window: prev.window, volume: prev.volume, per_stage: prev.per_stage });
}

async function runAudit(runId, { sinceAt, cadence = 'daily', startedBy = null } = {}) {
  let raw = null;
  try {
    const summary = await buildWindowSummary(sinceAt);
    // 零樣本早退：視窗內沒有任何 agent 呼叫也沒有任務異動（例如週末），此時呼叫模型只會逼它為了
    // 交差硬生問題出來——判準明列「指標都正常還硬生一份改動」是紅旗。不燒錢，照實記一筆。
    if (!summary.volume.agent_calls && !summary.volume.tasks_touched) {
      await insertFinding(runId, {
        kind: 'note', severity: 'ok',
        diagnosis: `本輪視窗（${summary.window.since} 起）內沒有任何 agent 呼叫或任務異動，未進行診斷。`
      });
      await query("UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1", [runId]);
      return;
    }

    const agent = loadAgent('health-auditor');
    // trend 一律要給值：placeholder 沒對應資料時 render 只會靜默填空字串（見 agentPrompt skill 鐵則 1），
    // 不做趨勢比對時明講「不做」，比留一段空洞的標題安全。
    const prompt = agent.render({
      previous: await previousProposals(),
      trend: cadence === 'monthly'
        ? await buildTrendBlock(sinceAt)
        : '本輪不做趨勢比對（只有每月 1 號的 30 天大健檢會帶上一期資料）。',
      summary: JSON.stringify(summary)
    });
    const { text, usage, durationMs } = await runAgent(prompt, {
      model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'workflow_health', cwd: REPO_ROOT, timeoutMs: AUDIT_TIMEOUT_MS
    });
    raw = text;
    await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);

    const { inner: sumBlock, cleaned } = extractTaggedBlock(text, 'summary');
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
    const severity = String((parsed && parsed.severity) || '').trim().toLowerCase();
    const proposals = (parsed && Array.isArray(parsed.proposals)) ? parsed.proposals : null;
    if (!SEVERITIES.has(severity) || !proposals) {
      await insertFinding(runId, {
        kind: 'note', severity: 'error',
        diagnosis: '健檢失敗：無法取得有效結果' + saveRawOutput(runId, AUDIT_AGENT, raw)
      });
      await failRun(runId, '模型有回應但結果解析不過（severity 或 proposals 欄不合法）');
      return;
    }

    // 總結與提案分開存：一個是給人讀的敘述，一個是可動手、可追蹤成效的條目。混在一起就再也分不出
    // 「哪句話有數據撐、哪句是推論」。
    const sum = (sumBlock || '').trim();
    if (sum) await insertFinding(runId, { kind: 'summary', severity, label: '本輪總結', diagnosis: sum });

    for (const p of proposals) {
      const title = String(p.title || '').trim();
      const metric = String(p.target_metric || '').trim();
      const baseline = String(p.metric_baseline || '').trim();
      const kind = p.kind === 'signal' ? 'signal' : 'proposal';
      // 指標門檻只套在 proposal 上。signal 的定義就是「證據還不夠、存著等下一輪累積」——要求它
      // 附得出指標基線本身自相矛盾，而判準又叫 agent 把講不出指標的一律降級成 signal，兩邊一夾
      // 就是「降級完照樣被丟掉」，等於承諾了一個不存在的收納桶。
      // 說不出「動哪個指標、現值多少」的**提案**仍一律丟掉（判準：三者缺一不成立）。丟掉要留痕，
      // 否則下次會誤以為模型什麼都沒提。
      if (!title || (kind === 'proposal' && (!metric || !baseline))) {
        console.warn('[HEALTH-CHECK] 提案缺標題或指標，已丟棄：', title || '(無標題)');
        continue;
      }
      // 每條提案帶自己的嚴重度。整輪共用一個值時，「輕微的可以不處理」的粒度只到整輪——五條提案
      // 一律同色、同待辦，分不出哪條可以放著。對不上列舉值（舊版提示詞、拼錯）就退回整輪的值，
      // 讓舊資料與新舊版本交接期照樣顯示得出來。
      const psev = String(p.severity || '').trim().toLowerCase();
      await insertFinding(runId, {
        kind,
        severity: SEVERITIES.has(psev) ? psev : severity,
        label: title,
        layer: String(p.layer || '').trim() || null,
        evidence: p.evidence ? String(p.evidence) : null,
        target_metric: metric,
        metric_baseline: baseline,
        risk_if_wrong: p.risk_if_wrong ? String(p.risk_if_wrong) : null,
        diagnosis: [title, String(p.detail || '').trim()].filter(Boolean).join('\n\n'),
        rationale: p.action ? String(p.action) : null
      });
    }
    await query("UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1", [runId]);
  } catch (err) {
    console.error('[HEALTH-CHECK] audit:', err.message);
    await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', err).catch(() => {});
    await failRun(runId, err.message);
  }
}

// 本輪視窗的起點＝上一輪全平台健檢的完成時刻。刻意不是「上次套用改動的時刻」：被判「不須調整」
// 的輪次也要把視窗往前推，否則視窗永遠停在原地、每輪重看同一批資料。
// 從沒跑過 → 退回 7 天，給第一輪一點基礎樣本。
//
// 2-M1：排除夜間批次自建的列（cadence='nightly-fix'）。批次列的 finished_at 是它自己收尾的
// 時刻（通常在凌晨 2 點附近），若被當成「上一輪全平台健檢完成時刻」，下一輪審計的視窗起點會
// 被推到批次結束那一刻——跳過批次執行期間累積的資料，等於漏看一段。
async function auditWindowStart() {
  const { rows } = await query(
    `SELECT finished_at, created_at FROM health_check_runs
      WHERE task_db_id IS NULL AND status='done' AND cadence <> $1
      ORDER BY id DESC LIMIT 1`, [BATCH_CADENCE]
  );
  const last = rows[0];
  if (!last) return new Date(Date.now() - 7 * 86400000);
  return new Date(last.finished_at || last.created_at);
}

// 啟動續跑：上次 server 重啟時跑到一半的健檢（status='running'）從中斷點接續，
// 而非永遠停在 running 或一律標 error 作廢。fire-and-forget，比照原觸發路徑。
// 依 task_db_id 分流：拿 scope=task 的 run 去跑全平台健檢，會在同一個 run 底下混進 21 關的
// findings，畫面上再也分不出這是哪一張任務的診斷。
async function resumeInterruptedRuns() {
  const { rows } = await query("SELECT id, task_db_id, since_at, cadence FROM health_check_runs WHERE status='running'");
  for (const r of rows) {
    // 2-C1：批次列（cadence='nightly-fix'）必須最先攔下，不落入下面任何一種 scope 的續跑。
    // 批次本身無法「續跑」——它的狀態（哪些候選已 triage、哪些已合併）活在 nightly-fix.js
    // 的函式呼叫堆疊裡，不是可以從 DB 重建的檢查點；resumeInterruptedRuns 若把它交給
    // runHealthCheck（沒有 task_db_id／since_at 時的 fallback），會在批次列底下冒出全平台
    // 逐關診斷的 findings（21 關），與批次自己合併組寫入的 findings 混在同一個 run 下——
    // 這正是本輪要修的坑本身（實測過的失敗）。直接收成 error，讓管理頁看得出「這輪沒完成」，
    // 而不是被誤判成另一種健檢在跑。
    if (r.cadence === BATCH_CADENCE) {
      console.log(`[HEALTH-CHECK] run ${r.id} 是夜間批次列，無法續跑，收成 error`);
      await failRun(r.id, '夜間批次中途被重啟打斷，無法續跑');
      continue;
    }
    // 兩種 scope 各自續跑：單張任務／主導型審計（有 since_at）。
    // 走錯會在同一個 run 底下混進另一種格式的 findings，畫面上再也分不出這一輪是什麼。
    // cadence 要一併帶回：不帶會退回 daily，續跑的月健檢就靜默少掉趨勢比對那一段。
    if (r.task_db_id) {
      console.log(`[HEALTH-CHECK] resume interrupted run ${r.id}`);
      runTaskHealthCheck(r.id, { taskDbId: r.task_db_id }).catch(() => {});
    } else if (r.since_at) {
      console.log(`[HEALTH-CHECK] resume interrupted run ${r.id}`);
      runAudit(r.id, { sinceAt: r.since_at, cadence: r.cadence || 'daily' }).catch(() => {});
    } else {
      // 兩者皆空＝逐關診斷（runHealthCheck）的歷史列。那條路徑已整條退役（最後一次實際執行
      // 2026-08-20），沒有東西可以續跑它了。收成 error 而不是靜默跳過：留在 running 的話
      // getHealthCheckSchedule 會一直判「本輪執行中」而不再排程，健檢從此安靜停擺。
      console.log(`[HEALTH-CHECK] run ${r.id} 是已退役的逐關診斷，無法續跑，收成 error`);
      await failRun(r.id, '逐關診斷（runHealthCheck）已退役，這一輪無法續跑');
    }
  }
  return rows.length;
}

module.exports = { runTaskHealthCheck, runAudit, auditWindowStart, resumeInterruptedRuns };
