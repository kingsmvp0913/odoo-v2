const crypto = require('crypto');
const { withResume } = require('./with-resume');
const { parseAgentResult } = require('./agent-result');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { query } = require('../db');
const notify = require('../notify');
const { assembleTaskContext } = require('./sync');
const { recordTroubleshooting, extractMemoryBlock } = require('./troubleshooting');
const { extractDriftBlock, enqueueWikiDrift } = require('./wiki-drift');
const { machineLogHeader } = require('../../public/js/machine-logs.js');

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
  let projectSlug = '';
  let repoPaths = '（無 repo，僅能查 wiki／正式區 DB／log）';
  if (task.project_id) {
    const info = await getProjectInfo(task.project_id).catch(() => null);
    if (info) {
      projectName = info.name;
      // 見 chat-agent.js 同段註解：中文專案名未編碼會讓 /ai/wiki 的 curl 直接 400
      projectSlug = encodeURIComponent(info.folder_name || info.name);
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
    project_slug: projectSlug,
    repo_paths: repoPaths
  });

  // 續接輪只送「使用者這輪講的話」：追問（cs_reply_pending→cs_running）與補資料
  // （cs_data_needed→cs-data-submit→cs_running）兩條重跑路徑，新發言都落在 task_logs 的
  // 最後一則 role='user'，故共用同一份 retry prompt，由 cs-retry.md 自行判斷是哪一種。
  const retryAgent = loadAgent('cs-retry');
  const { rows: [lastUser] } = await query(
    "SELECT content FROM task_logs WHERE task_id = $1 AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1",
    [taskId]
  );
  // 只寫在 fresh prompt 裡、但每輪都該生效的權威內容折進指紋（見 with-resume.js 的 extraVersion）：
  // 任務原文／附件（assembleTaskContext）與 repo 路徑會中途變動——補了附件、或原本未綁專案後來綁了，
  // session 內都還是舊快照。折進去才會在變動時自動退回 fresh，重讀新脈絡。
  const ctxVersion = crypto.createHash('sha1')
    .update(`${task.original_text || ''}\n${repoPaths}\n${projectSlug}`)
    .digest('hex').slice(0, 12);

  let result = null;
  let rawText = '';
  let blockerMsg = 'CS agent 回應無法解析為有效 JSON';
  try {
    const { text, assistantText, usage, durationMs } = await withResume({
      freshAgentName: 'cs',
      retryAgentName: 'cs-retry',
      getSession: async () => {
        const { rows: [r] } = await query('SELECT cs_session_id, cs_prompt_ver FROM tasks WHERE id=$1', [taskId]);
        return r && r.cs_session_id ? { sessionId: r.cs_session_id, promptVer: r.cs_prompt_ver } : null;
      },
      setSession: ({ sessionId, promptVer }) =>
        query('UPDATE tasks SET cs_session_id=$2, cs_prompt_ver=$3 WHERE id=$1', [taskId, sessionId, promptVer]),
      clearSession: () =>
        query('UPDATE tasks SET cs_session_id=NULL, cs_prompt_ver=NULL WHERE id=$1', [taskId]),
      renderFresh: () => prompt,
      renderRetry: () => retryAgent.render({
        new_message: lastUser ? lastUser.content : '（無新發言）'
      }).trim(),
      // retry 失敗會靜默降級跑 fresh，使用者照樣拿到回覆——但失敗那次的 token／時間必須記帳，
      // 否則「失敗重跑」這個最貴的情境在 token_usage 裡完全隱形（比照 spec-review.js）
      onRetryFailed: err => logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, task.user_id, 'cs', err),
      extraVersion: ctxVersion,
      model: agent.model,
      runOpts: { signal, taskId, userId, agentType: 'cs' }
    });
    // cs 會實地查證、有時把 <result> 當中間步驟吐出後又補收尾散文／派子任務，末輪 ev.result（text）就不含契約標籤。
    // 用整段 assistant transcript（assistantText）解析，讓 extractResult 撈得回最後一組 <result>；退回 text 保底。
    rawText = assistantText || text || '';
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, task.user_id, 'cs', usage, durationMs);
    result = await parseAgentResult(rawText, { parse: JSON.parse, signal, ref: { taskId: task.task_id, projectId: task.project_id }, userId: task.user_id });
  } catch (err) {
    // CLI/API 執行失敗與「回應無法解析」是不同問題，分開歸因（健檢流程層 P3）
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, task.user_id, 'cs', err);
    if (err.aborted) return; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    blockerMsg = `CS agent 執行失敗：${err.message}`;
    console.error(`[CS-AGENT] error task ${taskId}:`, err.message);
  }

  // 兩個選用側通道（需綁定專案；解析或寫入失敗都留痕不中斷分流）：
  //  <memory>    釐清出可留存的結論（典型 operation：只回覆不改程式，不進 library agent）→ 寫回疑難排解區
  //  <wiki-drift> 讀碼發現某 wiki 頁與程式碼矛盾（頁錯、碼對）→ 入漂移佇列供健檢彙整（不自動改文件）
  if (task.project_id) {
    const mem = extractMemoryBlock(rawText);
    if (mem.entry) {
      try { await recordTroubleshooting(task.project_id, mem.entry); }
      catch (err) { console.error(`[CS-AGENT] troubleshooting 寫回失敗 task ${taskId}:`, err.message); }
    }
    const drift = extractDriftBlock(rawText);
    if (drift.entry) {
      try { await enqueueWikiDrift({ projectId: task.project_id, taskId: task.task_id, userId: task.user_id, source: 'cs', slug: drift.entry.slug, reason: drift.entry.reason }); }
      catch (err) { console.error(`[CS-AGENT] wiki-drift 入列失敗 task ${taskId}:`, err.message); }
    }
  }

  if (!result) {
    // 一併清 session：解析失敗＝上一輪沒吐好契約，withResume 的降級只涵蓋 runClaude 拋錯（回 null 它看不到），
    // 不清的話人工重跑會續接到同一場「不吐契約」的對話，原地重演。
    await query(
      "UPDATE tasks SET status='stopped', cs_session_id=NULL, cs_prompt_ver=NULL, blocker_content=$2, updated_at=NOW() WHERE id=$1",
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
    // session 同上一段理由一併清掉，重跑才拿得到 fresh 脈絡
    await query(
      "UPDATE tasks SET status='stopped', cs_session_id=NULL, cs_prompt_ver=NULL, blocker_content=$2, updated_at=NOW() WHERE id=$1",
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
    // code_change_clear：cs 已實查、reason 是初步定因。兩個受眾各拿一份，刻意不共用同一字串——
    // reason 依 cs.md 要求含檔案路徑／Model/Method／[碼] 來源標籤（分析關要靠它定位），原文貼進時間軸
    // 就是使用者反映「看不懂」的主因（實測平均 906 字的技術文）。故：
    // (1) 時間軸（role='ai'）寫 reason_plain——否則使用者只看到任務憑空跳進分析、不知道為何判定要改程式。
    // (2) cs_findings 存 reason 供分析關當「待驗證線索」，免得 cs 查過的根因被丟掉、分析從零重查（雙倍 token）。
    // 舊 prompt／偶發漏欄位時 reason_plain 會是空的，退回貼 reason（看不懂好過看不到，不阻斷分流）。
    // 這條 fallback 貼的就是那份 906 字技術文，故本前綴也進 machine-logs registry 收合；
    // 但只在「夠長」時收（collapseWhenLong）——正常路徑貼的 reason_plain 是白話短句，
    // 把它折成一句 hint 等於藏掉唯一看得懂的說明，反而回到使用者反映「看不懂」的原點。
    const reason = typeof result.reason === 'string' ? result.reason.trim() : '';
    const reasonPlain = typeof result.reason_plain === 'string' ? result.reason_plain.trim() : '';
    const shown = reasonPlain || reason;
    if (shown) {
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
        [taskId, `${machineLogHeader('cs_code_change')}\n${shown}`]
      );
    }
    // 離開 cs 關即清 session（不跨關累積，見 with-resume.js 設計說明）：分析關有自己的
    // analysis_session_id，cs 這場對話到此為止，findings 已存欄位往下傳。
    await query(
      "UPDATE tasks SET status='analysis_running', cs_findings=$2, cs_session_id=NULL, cs_prompt_ver=NULL, updated_at=NOW() WHERE id=$1",
      [taskId, reason || null]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
  }
}

module.exports = { runCsAgent };
