const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectNotes } = require('./project-notes');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const yaml = require('js-yaml');

// spec_review 對話式閘門（pre-coding）：讀 task_logs 對話＋現行 analysis_yaml，跑 spec-review agent。
// agent 二選一：answer（純提問→回覆、規格不動）／revise（明確要改→重產規格＋回覆）。兩者狀態都回 spec_review。
// 對話真相來源＝task_logs（/spec-revise 已把提問寫成 role='user'），不碰 task_messages（那是 mid-coding 吸收管道）。

// 解析 spec-review 的單一 <result> 輸出：
//   DECISION: answer|revise
//   REPLY:\n<可多行文字>
//   [revise 才有] ---SPEC---\n<完整 analysis.yaml>
// 換行安全、免 JSON 跳脫。revise 必須帶可被 yaml.load 解析的 SPEC，否則丟例外（→ parseAgentResult 回 null → stopped）。
const SPEC_SEP = '---SPEC---';
function parseSpecReview(s) {
  const text = String(s).trim();
  const m = text.match(/^DECISION:\s*(answer|revise)\b/i);
  if (!m) throw new Error('缺 DECISION');
  const decision = m[1].toLowerCase();
  const rest = text.slice(m[0].length);
  const sepIdx = rest.indexOf(SPEC_SEP);
  const replyPart = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
  const reply = replyPart.replace(/^\s*REPLY:\s*/i, '').trim();
  if (!reply) throw new Error('缺 REPLY');
  let analysis_yaml = null;
  if (decision === 'revise') {
    if (sepIdx === -1) throw new Error('revise 缺 ---SPEC---');
    const yamlStr = rest.slice(sepIdx + SPEC_SEP.length).trim();
    const v = yaml.load(yamlStr, { schema: yaml.CORE_SCHEMA });
    if (!v || typeof v !== 'object') throw new Error('SPEC 非有效 YAML 物件');
    analysis_yaml = yamlStr;
  }
  return { decision, reply, analysis_yaml };
}

async function runSpecReview(task, userId, signal) {
  const taskId = task.id;
  const ref = { taskId: task.task_id, projectId: task.project_id };

  // 近期對話（由舊到新）：最後一則 user 發言＝要回應的提問／要求
  const { rows: dlg } = await query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 AND role IN ('user','ai') ORDER BY created_at DESC, id DESC LIMIT 12",
    [taskId]
  );
  const conversation = dlg.reverse()
    .map(l => `${l.role === 'ai' ? 'AI' : '使用者'}：${l.content}`).join('\n') || '（無對話）';

  let raw;
  try {
    const agent = loadAgent('spec-review');
    const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      conversation,
      project_notes: projectNotes || ''
    }).trim();
    const result = await runClaude(prompt, { taskId, userId, signal, model: agent.model, agentType: 'respec' });
    raw = result.text;
    await logTokenUsage(ref, userId, 'respec', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage(ref, userId, 'respec', err);
    if (err.aborted) return; // 手動暫停：狀態原地不動，解除後從 respec_running 重跑
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, stopReason('規格問答失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  const parsed = await parseAgentResult(raw, { parse: parseSpecReview, signal, ref, userId });
  if (!parsed) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='規格問答未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  // 回覆一律落時間軸（role='ai'）；revise 才連同更新 analysis_yaml。兩者狀態都回 spec_review 讓使用者續看／續問。
  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, parsed.reply]);
  if (parsed.decision === 'revise') {
    await query(
      "UPDATE tasks SET analysis_yaml=$2, status='spec_review', updated_at=NOW() WHERE id=$1",
      [taskId, parsed.analysis_yaml]
    );
  } else {
    await query("UPDATE tasks SET status='spec_review', updated_at=NOW() WHERE id=$1", [taskId]);
  }
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'spec_review' });
}

module.exports = { runSpecReview, parseSpecReview };
