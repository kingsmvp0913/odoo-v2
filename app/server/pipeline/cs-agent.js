const { runClaude } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { query } = require('../db');
const notify = require('../notify');
const { assembleTaskContext } = require('./sync');
const { recordTroubleshooting, extractMemoryBlock } = require('./troubleshooting');

async function runCsAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, project_id, user_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;
  task.original_text = await assembleTaskContext(taskId);

  // 使用者先前輪次已補充的答案（cs-data-submit 寫入 task_logs）。cs-agent 重跑時
  // 必須帶入，否則看不到已回答內容 → 重複詢問 → cs_data_needed ↔ cs_running 鬼打牆。
  const { rows: priorAnswers } = await query(
    "SELECT content FROM task_logs WHERE task_id = $1 AND role = 'user' ORDER BY created_at",
    [taskId]
  );
  const answers = priorAnswers.length ? priorAnswers.map(l => l.content).join('\n\n') : '（尚無）';

  // 撈最近一版 [客服回覆] 草稿（若有）當上下文，讓「把回覆改客氣點／補一句 X」這種針對草稿的追問能連貫
  // 修訂——典型是追問重跑（cs_reply_pending→cs_running）。注意：只要曾有 operation 輪次寫過 [客服回覆]，
  // 該筆 log 就會一直留著，補資料迴圈（cs_data_needed→cs-data-submit→cs_running）重跑時也會撈到同一份舊
  // 草稿，並非「無前一版」；cs.md 已引導 agent 依最新使用者輸入判斷情境，非空不代表當次一定是追問。無任何
  // 一版則傳「（無）」。
  const { rows: [priorReplyRow] } = await query(
    "SELECT content FROM task_logs WHERE task_id = $1 AND role = 'ai' AND content LIKE '[客服回覆]%' ORDER BY created_at DESC, id DESC LIMIT 1",
    [taskId]
  );
  const priorReply = priorReplyRow
    ? priorReplyRow.content.replace(/^\[客服回覆\]\s*/, '').trim()
    : '（無）';

  // 技術客服能力片段需要 repo 路徑與專案名：此關尚未建 worktree，讀主 clone（唯讀）。
  const { getProjectInfo } = require('./task-agent');
  let projectName = '（未綁定專案）';
  let repoPaths = '（無 repo，僅能查 wiki／正式區 DB／log）';
  if (task.project_id) {
    const info = await getProjectInfo(task.project_id).catch(() => null);
    if (info) {
      projectName = info.name;
      if (info.repos.length) repoPaths = info.repos.map(r => `- ${r.local_path}`).join('\n');
    }
  }

  const agent = loadAgent('cs');
  const prompt = agent.render({
    title: task.title || '未命名',
    original_text: task.original_text || '（無詳細內容）',
    answers,
    prior_reply: priorReply,
    project_name: projectName,
    repo_paths: repoPaths
  });

  let result = null;
  let rawText = '';
  let blockerMsg = 'CS agent 回應無法解析為有效 JSON';
  try {
    const { text, usage, durationMs } = await runClaude(prompt, { signal, taskId, userId, model: agent.model, agentType: 'cs' });
    rawText = text || '';
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, task.user_id, 'cs', usage, durationMs);
    result = await parseAgentResult(text, { parse: JSON.parse, signal, ref: { taskId: task.task_id, projectId: task.project_id }, userId: task.user_id });
  } catch (err) {
    // CLI/API 執行失敗與「回應無法解析」是不同問題，分開歸因（健檢流程層 P3）
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, task.user_id, 'cs', err);
    if (err.aborted) return; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    blockerMsg = `CS agent 執行失敗：${err.message}`;
    console.error(`[CS-AGENT] error task ${taskId}:`, err.message);
  }

  // 客服釐清出可留存的結論（典型是 operation：只回覆、不改程式，不會走任務流程進 library agent）時，
  // agent 會另附 <memory> 側通道，寫回 wiki 疑難排解區供日後查詢。需綁定專案；失敗留痕不中斷分流。
  if (task.project_id) {
    const { entry } = extractMemoryBlock(rawText);
    if (entry) {
      try { await recordTroubleshooting(task.project_id, entry); }
      catch (err) { console.error(`[CS-AGENT] troubleshooting 寫回失敗 task ${taskId}:`, err.message); }
    }
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
    // 把回覆也寫進時間軸（role='ai'），否則回覆只存在 cs_reply 欄、只在 cs_reply_pending 動作面板顯示，
    // 任務一離開該狀態（→done）面板消失＝使用者再也看不到客服回答了什麼（與下方 vague 問題同理）。
    if (result.reply) {
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
        [taskId, `[客服回覆]\n${result.reply}`]
      );
    }
    await query(
      "UPDATE tasks SET status='cs_reply_pending', cs_reply=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.reply || '']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_reply_pending' });
  } else if (result.type === 'code_change_vague') {
    // 把要問的問題也寫進時間軸（role='ai'），否則問題只存在 cs_question 欄、只在動作面板顯示，
    // 答完換面板就從對話時間軸消失＝使用者看不到「當初問了什麼」。
    const qs = Array.isArray(result.questions) ? result.questions : (result.question ? [result.question] : []);
    const qText = qs.map((q, i) => `${i + 1}. ${String(q).trim()}`).filter(Boolean).join('\n');
    if (qText) {
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
        [taskId, `[需要你補充資料]\n${qText}`]
      );
    }
    await query(
      "UPDATE tasks SET status='cs_data_needed', cs_question=$2, updated_at=NOW() WHERE id=$1",
      [taskId, result.question || JSON.stringify(result.questions || [])]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'cs_data_needed' });
  } else if (result.type !== 'code_change_clear') {
    // 契約只有三種 type；未知值靜默放行成 code_change_clear 會拿垃圾輸出繼續燒 analysis token（Rule 12）
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, `CS agent 回傳未知分類 type：${JSON.stringify(result.type)}，請檢查 terminal 輸出`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  } else if (!task.project_id) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, '需修改程式的任務必須先綁定專案，請至任務設定綁定專案後重試']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  } else {
    // code_change_clear：cs 已實查、reason 是初步定因。
    // (1) 寫進時間軸（role='ai'），否則使用者只看到任務憑空跳進分析、不知道客服為何判定要改程式。
    // (2) 存 cs_findings 供分析關當「待驗證線索」，免得 cs 查過的根因被丟掉、分析從零重查（雙倍 token）。
    const reason = typeof result.reason === 'string' ? result.reason.trim() : '';
    if (reason) {
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
        [taskId, `[客服判定：需改程式]\n${reason}`]
      );
    }
    await query(
      "UPDATE tasks SET status='analysis_running', cs_findings=$2, updated_at=NOW() WHERE id=$1",
      [taskId, reason || null]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
  }
}

module.exports = { runCsAgent };
