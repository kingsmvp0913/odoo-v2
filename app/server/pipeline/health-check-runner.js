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
    const targets = listAgents().filter(a => a.stage && a.stage !== 'workflow_health');
    const ha = loadAgent('workflow-health');
    for (const agent of targets) {
      await checkOne(runId, agent, ha, windowDays, startedBy);
    }
    await query("UPDATE health_check_runs SET status='done', finished_at=NOW() WHERE id=$1", [runId]);
  } catch (err) {
    await query("UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE id=$1", [runId]).catch(() => {});
  }
}

async function checkOne(runId, agent, ha, windowDays, startedBy) {
  let finding = null;
  try {
    const full = loadAgent(agent.name);                     // 取現行 prompt body
    const summary = await buildAgentSummary(agent, { windowDays });
    const prompt = ha.render({
      agent_label: agent.label,
      agent_role: full.role || '',
      agent_prompt: full.body || '',
      summary: JSON.stringify(summary)
    });
    const { text, usage, durationMs } = await runClaude(prompt, { model: ha.model });
    await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs);
    const parsed = await parseAgentResult(text, { parse: JSON.parse });
    if (parsed && typeof parsed.diagnosis === 'string' && SEVERITIES.has(parsed.severity)) {
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
  await query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, suggested_prompt, rationale)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [runId, agent.name, agent.label, finding.diagnosis, finding.severity, finding.suggested_prompt, finding.rationale]
  );
}

module.exports = { runHealthCheck };
