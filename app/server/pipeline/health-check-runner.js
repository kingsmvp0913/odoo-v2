const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { listAgents, loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildAgentSummary } = require('./health-data');

const SEVERITIES = new Set(['ok', 'low', 'medium', 'high']);

// 近期完全沒被呼叫的關卡不可記成 ok：健檢 agent 自己在診斷正文裡都寫明「零執行樣本，這不是
// 健康證明」，但存成 ok 到前端就是一顆綠燈。實測 run#2 的 14 個 ok 裡，deploy-fix 與
// wiki-drift-classifier 都是 0 次呼叫——整頁綠得虛胖，反而蓋掉真正該看的那幾則。
// 刻意不放進 SEVERITIES：那是「模型可以回傳什麼」，這是我們依樣本數覆寫上去的。
const SEV_NO_SAMPLE = 'n/a';

// 跨關卡彙整：per-agent 健檢天生看不到「不屬於任何單一 agent」的問題。實測 run#1，同一個
// blocker（asset bundle 編不出來）出現在七個 agent 的摘要裡，每一則都正確判定「這屬環境層、
// 非本 agent 的提示詞可左右」——七個判斷都對，合起來沒有人負責。
// 統計單位刻意是「幾張**不同任務**卡在同一類原因」而不是「幾個 agent 提到它」：後者會被單一
// 任務灌水（一張任務走過七個關卡，就會在七個 agent 的 blocker_samples 裡各出現一次，看起來
// 像七個獨立證據，其實是同一件事）。
const SYSTEM_AGENT = '__system__';
const SYSTEM_MIN_TASKS = parseInt(process.env.HEALTH_SYSTEM_MIN_TASKS || '2', 10);
const SYSTEM_MIN_RATIO = parseFloat(process.env.HEALTH_SYSTEM_MIN_RATIO || '0.3');

// blocker_content 的分群鍵：平台的停下原因多半以 [方括號標籤] 開頭（[部署測試區 asset 檢查失敗]
// 這種），直接當鍵最準。沒有標籤的取第一行前 40 字並把數字正規化成 N——「循環 2 次」與
// 「循環 3 次」是同一類問題，不該分成兩群。
function blockerKey(s) {
  const t = String(s || '').trim();
  const tagged = t.match(/^\[([^\]]{1,40})\]/);
  if (tagged) return tagged[1];
  return t.split('\n')[0].replace(/\d+/g, 'N').slice(0, 40) || '（無停下原因）';
}

// 落一筆跨關卡的系統層 finding（沒有達標的群就不落，不為報而報）。
// 不給 suggested_prompt：這類問題改任何一支 agent 的 prompt 都沒用，硬給一份會把人導去改錯地方
//（前端的「帶入編輯器」按鈕也只在有 suggested_prompt 時才出現，正好不會誤導）。
async function aggregateSystemFinding(runId, windowDays) {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  // 刻意不寫 `blocker_content IS NOT NULL`：pg-mem 對有索引欄位的 IS NOT NULL 加比較條件會靜默
  // 回空集合（見 .claude/rules/testing.md 規則 15），在 JS 濾等價且不踩雷。
  const { rows } = await query(
    "SELECT id, blocker_content FROM tasks WHERE status='stopped' AND updated_at >= $1", [cutoff]
  );
  const stopped = rows.filter(r => r.blocker_content && String(r.blocker_content).trim());
  if (stopped.length < SYSTEM_MIN_TASKS) return null;

  const groups = new Map();
  for (const r of stopped) {
    const k = blockerKey(r.blocker_content);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const [key, members] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const ratio = members.length / stopped.length;
  if (members.length < SYSTEM_MIN_TASKS || ratio < SYSTEM_MIN_RATIO) return null;

  const pct = Math.round(ratio * 100);
  const sample = String(members[0].blocker_content).replace(/\s+/g, ' ').slice(0, 300);
  const finding = {
    severity: ratio >= 0.5 ? 'high' : 'medium',
    diagnosis:
      `近 ${windowDays} 天停下的 ${stopped.length} 張任務中，有 ${members.length} 張（${pct}%）卡在同一類原因：` +
      `「${key}」。這類問題不屬於任何單一 agent 的提示詞——各關健檢會各自正確地判定「與本關無關」，` +
      `於是沒有任何一則 finding 會指向它。範例：${sample}`,
    rationale:
      `統計單位是「幾張不同任務卡在同一類原因」而非「幾個 agent 提到它」：同一張任務會走過多個關卡，` +
      `在每一關的 blocker 樣本裡各出現一次，用後者會把一件事誤算成多個獨立證據。`
  };
  await query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale)
     VALUES ($1,$2,$3,$4,$5,NULL,$6)`,
    [runId, SYSTEM_AGENT, '跨關卡彙整', finding.diagnosis, finding.severity, finding.rationale]
  );
  return finding;
}

// admin 一鍵健檢的背景執行（fire-and-forget）：對每個有 stage 的 pipeline agent（排除自己）
// 聚合摘要 → 跑 opus 健檢 agent → 落一筆 finding。單一 agent 失敗不影響其他（best-effort）。
async function runHealthCheck(runId, { windowDays = 30, startedBy = null } = {}) {
  try {
    // 續跑支援：跳過此 run 已有 finding 的 agent——server 重啟後從中斷點接續，不重跑已完成者
    const { rows: doneRows } = await query('SELECT agent_name FROM health_check_findings WHERE run_id=$1', [runId]);
    const doneSet = new Set(doneRows.map(r => r.agent_name));
    const targets = listAgents().filter(a => a.stage && a.stage !== 'workflow_health' && !doneSet.has(a.name));
    const ha = loadAgent('workflow-health');
    for (const agent of targets) {
      await checkOne(runId, agent, ha, windowDays, startedBy);
    }
    // 跨關卡彙整（零 token，純統計）。續跑時已落過就不重複；失敗不影響整輪收尾——
    // 它是加值資訊，不該有能力讓已完成的 21 份 per-agent 診斷跟著作廢。
    if (!doneSet.has(SYSTEM_AGENT)) {
      try { await aggregateSystemFinding(runId, windowDays); }
      catch (err) { console.error('[HEALTH-CHECK] system finding:', err.message); }
    }
    await query("UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1", [runId]);
  } catch (err) {
    console.error('[HEALTH-CHECK]', err.message);
    await query("UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE id=$1", [runId]).catch(() => {});
  }
}

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

async function checkOne(runId, agent, ha, windowDays, startedBy) {
  let finding = null;
  // 摘要聚合失敗＝根本沒呼叫 claude，不可落失敗帳（否則 calls/failed_calls 統計灌水）
  let prompt = null;
  let summary = null;
  try {
    const full = loadAgent(agent.name);                     // 取現行 prompt body
    summary = await buildAgentSummary(agent, { windowDays });
    prompt = ha.render({
      agent_label: agent.label,
      agent_role: full.role || '',
      agent_prompt: full.body || '',
      summary: JSON.stringify(summary)
    });
  } catch (err) {
    console.error('[HEALTH-CHECK] summary error:', err.message);
  }
  let raw = null;
  if (prompt) try {
    const { text, usage, durationMs } = await runClaude(prompt, { model: ha.model, agentType: 'workflow_health' });
    raw = text;
    await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);
    // 三個長文字（建議提示詞／診斷正文／理由）全部走獨立標籤區塊，剝乾淨後 <result> 的 JSON
    // 只剩 severity 與 has_prompt 兩個短值，幾乎壞不掉。run#1 只把 suggested_prompt 移出 JSON，
    // 治了一半：run#2 的 23 份仍有 7 份首解析失敗（haiku 補救救回 3、另 4 份連補救都失敗整份報廢），
    // 死的全是輸出量大的那幾份——判正常的因為輸出短反而都活著，存活者偏差原封不動地留著。
    // 剝除順序 prompt 必須在最前：被分析的 agent prompt body 可能含任何標籤，先整塊拿掉，
    // 後面三個 lastIndexOf 才不會抓到它裡面的假邊界。
    // 相容舊格式：agent 若仍把 diagnosis／rationale／suggested_prompt 放 JSON 裡（能解析成功的
    // 情況）照樣接受——prompt 改版與 server 部署之間的空窗期不該整批落 error。
    const { inner: promptBlock, cleaned: afterPrompt } = extractTaggedBlock(text, 'prompt');
    const { inner: diagBlock, cleaned: afterDiag } = extractTaggedBlock(afterPrompt, 'diagnosis');
    const { inner: ratBlock, cleaned } = extractTaggedBlock(afterDiag, 'rationale');
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
    // 列舉值先 trim+lowercase 再比對：模型輸出的大小寫與尾隨空白不穩定，而 severity 對不上
    // 的代價是整份診斷被丟掉（見 rules/pipeline.md §72）。
    const severity = String((parsed && parsed.severity) || '').trim().toLowerCase();
    const diagnosis = String((diagBlock || (parsed && parsed.diagnosis)) || '').trim();
    if (diagnosis && SEVERITIES.has(severity)) {
      finding = {
        severity,
        diagnosis,
        suggested_prompt: (promptBlock && promptBlock.trim()) || (parsed && parsed.suggested_prompt) || null,
        rationale: (ratBlock && ratBlock.trim()) || (parsed && parsed.rationale) || null
      };
    }
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', err);
  }
  if (!finding) {
    finding = {
      severity: 'error',
      diagnosis: '健檢失敗：無法取得有效診斷' + saveRawOutput(runId, agent.name, raw),
      suggested_prompt: null,
      rationale: null
    };
  } else if (summary && summary.token && summary.token.calls === 0) {
    finding.severity = SEV_NO_SAMPLE;                       // 零樣本不記 ok（見 SEV_NO_SAMPLE）
  }
  try {
    await query(
      `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [runId, agent.name, agent.label, finding.diagnosis, finding.severity, finding.suggested_prompt, finding.rationale]
    );
  } catch (err) {
    console.error('[HEALTH-CHECK]', err.message);
  }
}

// 啟動續跑：上次 server 重啟時跑到一半的健檢（status='running'）從中斷點接續，
// 而非永遠停在 running 或一律標 error 作廢。fire-and-forget，比照原觸發路徑。
async function resumeInterruptedRuns() {
  const { rows } = await query("SELECT id FROM health_check_runs WHERE status='running'");
  for (const r of rows) {
    console.log(`[HEALTH-CHECK] resume interrupted run ${r.id}`);
    runHealthCheck(r.id).catch(() => {});
  }
  return rows.length;
}

module.exports = { runHealthCheck, resumeInterruptedRuns };
