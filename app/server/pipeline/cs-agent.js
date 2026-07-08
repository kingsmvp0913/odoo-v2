const { runClaude } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { query } = require('../db');
const notify = require('../notify');

async function runCsAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, original_text, project_id, user_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;

  let wikiContext = '';
  if (task.project_id) {
    // 分類任務只需知道專案有哪些主題，不需 wiki 全文（避免 wiki 隨任務累積讓每個工單分流成本線性膨脹，健檢 F）
    const { rows: pages } = await query(
      'SELECT title FROM wiki_pages WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 20',
      [task.project_id]
    );
    wikiContext = pages.map(p => `- ${p.title}`).join('\n');
  }

  // 使用者先前輪次已補充的答案（cs-data-submit 寫入 task_logs）。cs-agent 重跑時
  // 必須帶入，否則看不到已回答內容 → 重複詢問 → cs_data_needed ↔ cs_running 鬼打牆。
  const { rows: priorAnswers } = await query(
    "SELECT content FROM task_logs WHERE task_id = $1 AND role = 'user' ORDER BY created_at",
    [taskId]
  );
  const answers = priorAnswers.length ? priorAnswers.map(l => l.content).join('\n\n') : '（尚無）';

  const agent = loadAgent('cs');
  const prompt = agent.render({
    title: task.title || '未命名',
    original_text: task.original_text || '（無詳細內容）',
    wiki: wikiContext || '（無 wiki）',
    answers
  });

  let result = null;
  let blockerMsg = 'CS agent 回應無法解析為有效 JSON';
  try {
    const { text, usage, durationMs } = await runClaude(prompt, { signal, taskId, userId, model: agent.model });
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, task.user_id, 'cs', usage, durationMs);
    result = await parseAgentResult(text, { parse: JSON.parse, signal });
  } catch (err) {
    // CLI/API 執行失敗與「回應無法解析」是不同問題，分開歸因（健檢流程層 P3）
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, task.user_id, 'cs', err);
    blockerMsg = `CS agent 執行失敗：${err.message}`;
    console.error(`[CS-AGENT] error task ${taskId}:`, err.message);
  }

  if (!result) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, blockerMsg]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  if (result.type === 'operation') {
    await query(
      "UPDATE tasks SET status='cs_reply_pending', cs_reply=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.reply || '']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_reply_pending' });
  } else if (result.type === 'code_change_vague') {
    await query(
      "UPDATE tasks SET status='cs_data_needed', cs_question=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.question || JSON.stringify(result.questions || [])]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_data_needed' });
  } else if (!task.project_id) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, '需修改程式的任務必須先綁定專案，請至任務設定綁定專案後重試']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  } else {
    await query(
      "UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
  }
}

module.exports = { runCsAgent };
