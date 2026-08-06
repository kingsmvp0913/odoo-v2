const { query } = require('../db');
const { listAgents, loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildAgentSummary } = require('./health-data');

const SEVERITIES = new Set(['ok', 'low', 'medium', 'high']);

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

async function checkOne(runId, agent, ha, windowDays, startedBy) {
  let finding = null;
  // 摘要聚合失敗＝根本沒呼叫 claude，不可落失敗帳（否則 calls/failed_calls 統計灌水）
  let prompt = null;
  try {
    const full = loadAgent(agent.name);                     // 取現行 prompt body
    const summary = await buildAgentSummary(agent, { windowDays });
    prompt = ha.render({
      agent_label: agent.label,
      agent_role: full.role || '',
      agent_prompt: full.body || '',
      summary: JSON.stringify(summary)
    });
  } catch (err) {
    console.error('[HEALTH-CHECK] summary error:', err.message);
  }
  if (prompt) try {
    const { text, usage, durationMs } = await runClaude(prompt, { model: ha.model, agentType: 'workflow_health' });
    await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);
    // 建議的新提示詞走獨立 <prompt> 區塊，**先剝掉再解析 <result>**：被分析的 agent prompt 本身
    // 常含 <result> 契約範例，把它塞進 JSON 字串會讓 extractResult 的 lastIndexOf('</result>')
    // 抓到 prompt body 裡的那一個，切出破碎 JSON。實測 run#1：21 個 agent 有 5 個因此全滅，
    // 而且全是「有話要說」（要附新提示詞）的那幾個——判正常的因為不附而都活了下來，
    // 形成「結果永遠偏向一切正常」的存活者偏差。
    // 相容舊格式：agent 若仍把 suggested_prompt 放 JSON 裡（能解析成功的情況）照樣接受。
    const { inner: promptBlock, cleaned } = extractTaggedBlock(text, 'prompt');
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
    if (parsed && typeof parsed.diagnosis === 'string' && parsed.diagnosis.trim() && SEVERITIES.has(parsed.severity)) {
      const sp = (promptBlock && promptBlock.trim()) || parsed.suggested_prompt || null;
      finding = {
        severity: parsed.severity,
        diagnosis: parsed.diagnosis,
        suggested_prompt: sp,
        rationale: parsed.rationale || null
      };
    }
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', err);
  }
  if (!finding) {
    finding = { severity: 'error', diagnosis: '健檢失敗：無法取得有效診斷', suggested_prompt: null, rationale: null };
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
