const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { listAgents, loadAgent } = require('./agent-loader');
const { runAgent } = require('./agent-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildAgentSummary, buildTaskSummary, buildWindowSummary } = require('./health-data');
const { MACHINE_RETIRE_PREFIX } = require('./retire-prefix');

const SEVERITIES = new Set(['ok', 'low', 'medium', 'high']);

// 健檢子行程一律在 repo 根執行：judging 用的判準寫在 .claude/skills/healthCheck，而 headless
// claude 只認 cwd 的 project skill、不會往上層目錄找。server 是 `npm start`（cwd=app/）起的，
// 不指定 cwd 就落在 app/ 而載不到——實測從 app/ 問「有沒有 healthCheck skill」回 NONE、從 repo
// 根回 FOUND。這種缺失完全沒有訊號：agent 照跑、測試全綠，只是判準沒生效。
const REPO_ROOT = path.join(__dirname, '..', '..', '..');


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
// 全域總結那一筆的 agent_name（見 summarizeRun）。與 SYSTEM_AGENT 分開存：一個是程式算的客觀
// 統計、一個是模型的跨關推理，混在同一筆會讓「哪句話有數據撐、哪句是推論」再也分不出來。
const SUMMARY_AGENT = '__summary__';
// 分流那一筆（見 triageRun）。健檢改成兩階段：先用「全平台指標、不含任何提示詞」跑一次分流，
// 點名值得深看的關，才對那幾關拉提示詞深診。原本是 21 關各跑一次 opus 再把結論拼起來——
// 每一關只看得到自己，跨關問題於是每一關都正確地判成「與本關無關」，合起來沒有人負責。
const TRIAGE_AGENT = '__triage__';
// 單張任務健檢那一筆（見 runTaskHealthCheck）。與上面三個一樣用底線包起來的假 agent_name：
// findings 表的 agent_name 同時承載「哪一關」與「哪一種非 per-agent 的診斷」，真 agent 名不可能撞。
const TASK_AGENT = '__task__';
const TASK_LABEL = '任務健檢';
// 深診上限：分流若把全部都點名就等於沒篩，成本回到改版前。截斷一律寫進 finding，不靜默丟掉。
const MAX_FOCUS = parseInt(process.env.HEALTH_MAX_FOCUS || '8', 10);
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
  // kind 省略走 DEFAULT 'agent'（例行診斷，非提案）；status 明確帶 pending，不吃欄位 DEFAULT
  // （已改成 approved 是為了 kind='proposal'，這裡混到會把跨關彙整誤標成「已核准待自動修」）。
  await query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale, status)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,'pending')`,
    [runId, SYSTEM_AGENT, '跨關卡彙整', finding.diagnosis, finding.severity, finding.rationale]
  );
  return finding;
}

// 全域總結：per-agent 診斷各自為政，跨關卡的問題會被每一關各自正確地判成「與本關無關」——
// 每個判斷都對，合起來沒有人負責。aggregateSystemFinding 補的是客觀統計那一半（同類 blocker 分組
// 計數），但統計做不了因果推理：「前一關的產出不合後一關的預期」「某關的健康是把問題丟給下一關
// 換來的」這種只有讀過全部診斷的推理者看得出來。這一段補的是推理那一半。
// 輸入是已濃縮的各關診斷（每份幾百字）而非原始數據，所以 context 小、一次呼叫就夠。
// 刻意不合併成「21 關共用一個 session」：那會省更多 token，但會毀掉 doneSet 的中斷續跑，
// 且 context 長到後段時模型對前幾關的注意力會下降。
async function summarizeRun(runId, startedBy) {
  const { rows } = await query(
    `SELECT agent_name, agent_label, severity, diagnosis, rationale FROM health_check_findings
     WHERE run_id=$1 AND agent_name <> $2 ORDER BY id`,
    [runId, SUMMARY_AGENT]
  );
  if (!rows.length) return null;                              // 一份診斷都沒有＝沒東西可總結
  // 從 DB 撈統計而非靠參數傳入：續跑時 aggregateSystemFinding 已在上一輪落過、這輪不會重跑，
  // 傳參數會拿到 null，總結就少掉唯一的客觀規模依據。
  const sys = rows.find(r => r.agent_name === SYSTEM_AGENT);
  const perAgent = rows.filter(r => r.agent_name !== SYSTEM_AGENT);
  if (!perAgent.length) return null;
  const agent = loadAgent('health-summary');
  const prompt = agent.render({
    findings: perAgent.map(r =>
      `### ${r.agent_label || r.agent_name}（severity: ${r.severity}）\n${String(r.diagnosis || '').trim()}`
    ).join('\n\n'),
    system_stat: sys ? `${sys.diagnosis}\n\n（依據：${sys.rationale || ''}）`.trim() : '（無）'
  });
  const { text, usage, durationMs } = await runAgent(prompt, { model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'workflow_health', cwd: REPO_ROOT });
  await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);
  // 比照 checkOne：長文字走獨立標籤，<result> 的 JSON 只剩一個短值，幾乎壞不掉。
  const { inner: diagBlock, cleaned: afterDiag } = extractTaggedBlock(text, 'diagnosis');
  const { inner: ratBlock, cleaned } = extractTaggedBlock(afterDiag, 'rationale');
  const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
  const severity = String((parsed && parsed.severity) || '').trim().toLowerCase();
  const diagnosis = String((diagBlock || (parsed && parsed.diagnosis)) || '').trim();
  // 解析不過就不落：這是加值資訊，落一筆「總結失敗」的紅字只會擠掉真正該看的那幾則
  // （比照 aggregateSystemFinding 的「沒有達標的群就不落，不為報而報」）。
  if (!diagnosis || !SEVERITIES.has(severity)) return null;
  // 同上：kind 走 DEFAULT 'agent'，status 明確 pending，不吃已改成 approved 的欄位 DEFAULT。
  await query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale, status)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,'pending')`,
    [runId, SUMMARY_AGENT, '全域總結', diagnosis, severity, (ratBlock && ratBlock.trim()) || null]
  );
  return { severity, diagnosis };
}

// 分流未點名的關：直接落一筆 ok，零 token。刻意仍落一筆而不是整個略過——健檢頁少掉一半的關
// 會讓人以為那些沒被檢查，而且下次續跑時 doneSet 也認不出它們已經處理過。
async function recordSkipped(runId, agent, summary) {
  const t = (summary && summary.token) || {};
  const rc = (summary && summary.repeat_calls) || {};
  const tk = (summary && summary.tasks) || {};
  const severity = t.calls === 0 ? SEV_NO_SAMPLE : 'ok';
  const diagnosis =
    `分流階段未點名，未拉出提示詞深入診斷。近期指標：呼叫 ${t.calls || 0} 次、` +
    `每張任務平均 ${rc.avg != null ? rc.avg : '—'} 次、卡死率 ${tk.stopped_rate != null ? tk.stopped_rate : '—'}、` +
    `成本 $${t.cost_usd != null ? t.cost_usd : '—'}。`;
  // 同上：kind 走 DEFAULT 'agent'，status 明確 pending。
  await query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale, status)
     VALUES ($1,$2,$3,$4,$5,NULL,NULL,'pending')`,
    [runId, agent.name, agent.label, diagnosis, severity]
  ).catch(err => console.error('[HEALTH-CHECK] skipped finding:', err.message));
}

// 第一階段：一次看完全平台的指標（不含任何 agent 的提示詞），輸出跨關診斷＋值得深看的關。
// 不給提示詞是刻意的——看了就會忍不住開始改它，而這一階段要決定的是「花錢深看誰」。
// 失敗一律回 null，由呼叫端退回「逐關全檢」的舊行為：分流壞掉不可以變成「什麼都沒檢查」。
async function triageRun(runId, targets, windowDays, startedBy) {
  const summaries = new Map();
  for (const a of targets) {
    try { summaries.set(a.name, await buildAgentSummary(a, { windowDays })); }
    catch (err) { console.error('[HEALTH-CHECK] summary error:', a.name, err.message); }
  }
  if (!summaries.size) return null;

  let raw = null;
  try {
    const agent = loadAgent('health-triage');
    const prompt = agent.render({ summaries: JSON.stringify([...summaries.values()], null, 1) });
    const { text, usage, durationMs } = await runAgent(prompt, { model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'workflow_health', cwd: REPO_ROOT });
    raw = text;
    await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);
    const { inner: diagBlock, cleaned: afterDiag } = extractTaggedBlock(text, 'diagnosis');
    const { inner: ratBlock, cleaned } = extractTaggedBlock(afterDiag, 'rationale');
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
    const severity = String((parsed && parsed.severity) || '').trim().toLowerCase();
    const diagnosis = String(diagBlock || '').trim();
    if (!diagnosis || !SEVERITIES.has(severity) || !parsed || !Array.isArray(parsed.focus)) return null;

    // 只認得出來的名字：模型可能回中文標籤或拼錯，濾掉才不會讓深診階段跑空
    let focus = parsed.focus.map(x => String(x).trim()).filter(n => summaries.has(n));
    let note = (ratBlock && ratBlock.trim()) || null;
    if (focus.length > MAX_FOCUS) {
      const dropped = focus.slice(MAX_FOCUS);
      focus = focus.slice(0, MAX_FOCUS);
      note = `${note || ''}
（超過深診上限 ${MAX_FOCUS}，未深診：${dropped.join('、')}）`.trim();
      console.warn(`[HEALTH-CHECK] focus 超過上限，未深診：${dropped.join(',')}`);
    }
    // 同上：kind 走 DEFAULT 'agent'，status 明確 pending。
    await query(
      `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale, status)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,'pending')`,
      [runId, TRIAGE_AGENT, '健檢分流', diagnosis, severity, note]
    );
    return { focus, summaries };
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', err);
    saveRawOutput(runId, TRIAGE_AGENT, raw);
    return null;
  }
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

    // 第一階段分流。續跑時若上一輪已落過分流就不重跑（deep 退回 targets，而 targets 本身
    // 已排除有 finding 的關，等於只補完剩下的）。
    let deep = targets;
    let pre = null;
    if (targets.length && !doneSet.has(TRIAGE_AGENT)) {
      const tri = await triageRun(runId, targets, windowDays, startedBy)
        .catch(err => { console.error('[HEALTH-CHECK] triage:', err.message); return null; });
      if (tri) {
        pre = tri.summaries;
        const set = new Set(tri.focus);
        deep = targets.filter(t => set.has(t.name));
        for (const a of targets.filter(t => !set.has(t.name))) await recordSkipped(runId, a, pre.get(a.name));
      } else {
        // 分流壞掉退回舊行為（逐關全檢）而不是什麼都不檢：貴，但不會靜默漏掉整輪健檢
        console.error('[HEALTH-CHECK] 分流失敗 → 退回逐關全檢');
      }
    }
    for (const agent of deep) {
      await checkOne(runId, agent, ha, windowDays, startedBy, pre && pre.get(agent.name));
    }
    // 跨關卡彙整（零 token，純統計）。續跑時已落過就不重複；失敗不影響整輪收尾——
    // 它是加值資訊，不該有能力讓已完成的 21 份 per-agent 診斷跟著作廢。
    if (!doneSet.has(SYSTEM_AGENT)) {
      try { await aggregateSystemFinding(runId, windowDays); }
      catch (err) { console.error('[HEALTH-CHECK] system finding:', err.message); }
    }
    // 全域總結排最後：它要讀本輪所有 per-agent 診斷＋上面剛落的客觀統計。
    // 同樣 best-effort——總結失敗不該讓已完成的 21 份診斷跟著作廢。
    if (!doneSet.has(SUMMARY_AGENT)) {
      try { await summarizeRun(runId, startedBy); }
      catch (err) { console.error('[HEALTH-CHECK] summary:', err.message); }
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

async function checkOne(runId, agent, ha, windowDays, startedBy, preSummary = null) {
  let finding = null;
  // 摘要聚合失敗＝根本沒呼叫 claude，不可落失敗帳（否則 calls/failed_calls 統計灌水）
  let prompt = null;
  let summary = null;
  try {
    const full = loadAgent(agent.name);                     // 取現行 prompt body
    summary = preSummary || await buildAgentSummary(agent, { windowDays });   // 分流階段已算過就不重算
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
    const { text, usage, durationMs } = await runAgent(prompt, { model: ha.model, provider: ha.provider, effort: ha.effort, agentType: 'workflow_health', cwd: REPO_ROOT });
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
    // 同上：kind 走 DEFAULT 'agent'，status 明確 pending。
    await query(
      `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [runId, agent.name, agent.label, finding.diagnosis, finding.severity, finding.suggested_prompt, finding.rationale]
    );
  } catch (err) {
    console.error('[HEALTH-CHECK]', err.message);
  }
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
      await query("UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE id=$1", [runId]);
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
    await query("UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE id=$1", [runId]).catch(() => {});
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
  const status = row.kind === 'proposal' ? 'approved' : 'pending';
  await query(
    `INSERT INTO health_check_findings
       (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale,
        kind, layer, evidence, target_metric, metric_baseline, risk_if_wrong, status)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [runId, AUDIT_AGENT, row.label || '系統健檢', row.diagnosis, row.severity, row.rationale || null,
     row.kind, row.layer || null, row.evidence || null, row.target_metric || null, row.metric_baseline || null,
     row.risk_if_wrong || null, status]
  );
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
      await query("UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE id=$1", [runId]);
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
    await query("UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE id=$1", [runId]).catch(() => {});
  }
}

// 本輪視窗的起點＝上一輪全平台健檢的完成時刻。刻意不是「上次套用改動的時刻」：被判「不須調整」
// 的輪次也要把視窗往前推，否則視窗永遠停在原地、每輪重看同一批資料。
// 從沒跑過 → 退回 7 天，給第一輪一點基礎樣本。
async function auditWindowStart() {
  const { rows } = await query(
    "SELECT finished_at, created_at FROM health_check_runs WHERE task_db_id IS NULL AND status='done' ORDER BY id DESC LIMIT 1"
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
    console.log(`[HEALTH-CHECK] resume interrupted run ${r.id}`);
    // 三種 scope 各自續跑：單張任務／主導型審計（有 since_at）／舊的逐關健檢（歷史列）。
    // 走錯會在同一個 run 底下混進另一種格式的 findings，畫面上再也分不出這一輪是什麼。
    // cadence 要一併帶回：不帶會退回 daily，續跑的月健檢就靜默少掉趨勢比對那一段。
    if (r.task_db_id) runTaskHealthCheck(r.id, { taskDbId: r.task_db_id }).catch(() => {});
    else if (r.since_at) runAudit(r.id, { sinceAt: r.since_at, cadence: r.cadence || 'daily' }).catch(() => {});
    else runHealthCheck(r.id).catch(() => {});
  }
  return rows.length;
}

module.exports = { runHealthCheck, runTaskHealthCheck, runAudit, auditWindowStart, resumeInterruptedRuns };
