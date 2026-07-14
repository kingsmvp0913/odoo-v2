const { query } = require('../db');
const { listAgents, loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildAgentSummary } = require('./health-data');

const SEVERITIES = new Set(['ok', 'low', 'medium', 'high']);

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
    const parsed = await parseAgentResult(text, { parse: JSON.parse, ref: {}, userId: startedBy });
    if (parsed && typeof parsed.diagnosis === 'string' && parsed.diagnosis.trim() && SEVERITIES.has(parsed.severity)) {
      finding = {
        severity: parsed.severity,
        diagnosis: parsed.diagnosis,
        suggested_prompt: parsed.suggested_prompt || null,
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
