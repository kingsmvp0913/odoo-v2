const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectNotes } = require('./project-notes');
const { taskWorkContext } = require('./work-context');
const { stopReason } = require('./claude-runner');
const { withResume } = require('./with-resume');
const { taskAttachmentNote } = require('./sync');
const { parseAgentResult, repairYamlPayload } = require('./agent-result');
const { enqueue: enqueueEmbedding } = require('../lib/embedding-index');
const { recordSpecVersionSafe } = require('./spec-version');
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
// lenient：嚴格解析失敗後立刻試的零成本第二手（見 agent-result.js 的順序說明）。規格 YAML 壞掉就
// 先當它沒產（analysis_yaml=null）並把壞掉的原文帶出去，呼叫端據此只補救那一段 YAML，修回來照常套用。
// 補救也失敗才降級成「規格不動＋講明沒更新」，而不是把整輪連同一段正確的回覆一起丟掉——
// 這一關的附載是幾百行的 analysis.yaml，踩中機率最高。
function parseSpecReview(s, { lenient = false } = {}) {
  const text = String(s).trim();
  const m = text.match(/^DECISION:\s*(answer|revise)\b/i);
  if (!m) throw new Error('缺 DECISION');
  const decision = m[1].toLowerCase();
  const rest = text.slice(m[0].length);
  const sepIdx = rest.indexOf(SPEC_SEP);
  const replyPart = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
  const reply = replyPart.replace(/^\s*REPLY:\s*/i, '').trim();
  if (!reply) throw new Error('缺 REPLY');
  let analysis_yaml = null, broken_payload = null, payload_error = null;
  if (decision === 'revise') {
    try {
      if (sepIdx === -1) throw new Error('revise 缺 ---SPEC---');
      const yamlStr = rest.slice(sepIdx + SPEC_SEP.length).trim();
      const v = yaml.load(yamlStr, { schema: yaml.CORE_SCHEMA });
      if (!v || typeof v !== 'object') throw new Error('SPEC 非有效 YAML 物件');
      analysis_yaml = yamlStr;
    } catch (e) {
      if (!lenient) throw e;
      // 壞掉的原文與錯誤訊息一起帶出去：呼叫端要拿它去做「只修 YAML 區塊」的補救。
      broken_payload = sepIdx === -1 ? null : rest.slice(sepIdx + SPEC_SEP.length).trim();
      payload_error = String((e && e.message) || '').split('\n')[0] || null;
    }
  }
  return { decision, reply, analysis_yaml, broken_payload, payload_error };
}

// 補救 agent 沒看過這份自訂契約，不講給它聽就只能猜鍵名。
const SPEC_SCHEMA_HINT = [
  'DECISION: answer|revise',
  'REPLY:',
  '<給使用者看的回覆全文，可多行>',
  `${SPEC_SEP}   ← 只有 revise 才有；以下整段是完整的 analysis.yaml`,
  '<YAML>'
].join('\n');

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
    const retryAgent = loadAgent('spec-review-retry');
    const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
    // 分析關建好的 worktree：有就讓它自己查碼再回答／改規格，沒有就照舊只看 analysis_yaml
    const work = await taskWorkContext(task);
    // 續接輪只送「使用者這輪講的話」＋當前規格全文；先前的探索與回覆都在 session 裡。
    // 規格一律重送 DB 版本：revise 輪會改寫 analysis_yaml，session 內殘留的舊版不可信。
    const lastUser = [...dlg].reverse().find(l => l.role === 'user');
    // 附件（多為參考站／現況截圖）連續接輪也要送：規格裡的視覺數值是分析關看著圖量出來的，
    // 這一關 revise 時重產整份 YAML，看不到圖就只能猜、猜錯即靜默覆蓋。續接輪同樣要帶——
    // session 只記得 fresh 那輪當下的附件，使用者中途補傳的圖不在裡面。
    const attachments = await taskAttachmentNote(taskId);
    const result = await withResume({
      freshAgentName: 'spec-review',
      retryAgentName: 'spec-review-retry',
      getSession: async () => {
        const { rows: [r] } = await query('SELECT spec_session_id, spec_prompt_ver FROM tasks WHERE id=$1', [taskId]);
        return r && r.spec_session_id ? { sessionId: r.spec_session_id, promptVer: r.spec_prompt_ver } : null;
      },
      setSession: ({ sessionId, promptVer }) =>
        query('UPDATE tasks SET spec_session_id=$2, spec_prompt_ver=$3 WHERE id=$1', [taskId, sessionId, promptVer]),
      clearSession: () =>
        query('UPDATE tasks SET spec_session_id=NULL, spec_prompt_ver=NULL WHERE id=$1', [taskId]),
      renderFresh: () => agent.render({
        analysis_yaml: task.analysis_yaml || '（無規格）',
        conversation,
        attachments,
        project_notes: projectNotes || '',
        repo_paths: work ? work.repoPaths : ''
      }).trim(),
      renderRetry: () => retryAgent.render({
        analysis_yaml: task.analysis_yaml || '（無規格）',
        attachments,
        new_message: lastUser ? lastUser.content : '（無新發言）'
      }).trim(),
      // retry 失敗會靜默降級跑 fresh，使用者照樣拿到回覆——但失敗那次的 token／時間必須記帳，
      // 否則「失敗重跑」這個最貴的情境在 token_usage 裡完全隱形（健檢 U12；qa-agent.js:117-120 同款）
      onRetryFailed: err => logFailedUsage(ref, userId, 'respec', err, true),
      model: agent.model,
      runOpts: { cwd: work ? work.cwd : undefined, taskId, userId, signal, agentType: 'respec' }
    });
    raw = result.raw ?? result.text;
    await logTokenUsage(ref, userId, 'respec', result.usage, result.durationMs, 'completed', result.resumed);
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

  const parsed = await parseAgentResult(raw, {
    parse: parseSpecReview,
    // 規格 YAML 壞掉時先把回覆與壞掉的原文撈出來，下面單獨補救那一段（見 agent-result.js 的順序說明）。
    lenientParse: t => parseSpecReview(t, { lenient: true }),
    schemaHint: SPEC_SCHEMA_HINT,
    signal, ref, userId
  });
  if (!parsed) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='規格問答未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  // 規格 YAML 壞掉（lenient 降級）→ 只把那段 YAML 送去修，修回來就照常套用，使用者不必重講一次。
  // 整段補救辦不到的事（要它把回覆連同幾百行規格逐字重抄），縮到「修這段 YAML 的格式」才做得到。
  if (parsed.decision === 'revise' && !parsed.analysis_yaml && parsed.broken_payload) {
    parsed.analysis_yaml = await repairYamlPayload(parsed.broken_payload, parsed.payload_error, {
      signal, ref, userId
    });
  }

  // 回覆一律落時間軸（role='ai'）；revise 才連同更新 analysis_yaml。兩者狀態都回 spec_review 讓使用者續看／續問。
  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, parsed.reply]);
  // revise 但規格沒救回來（lenient 降級）：規格維持原樣，並讓使用者看得到「這次沒更新」——
  // 靜靜不更新的話他會以為改好了，往下走才發現規格還是舊的。比照 clarify-chat 的同款分支。
  if (parsed.decision === 'revise' && !parsed.analysis_yaml) {
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, '（規格這次沒有更新：AI 回傳的規格格式異常，上面的回覆仍然有效，請再說一次或人工確認規格。）']
    );
  }
  if (parsed.decision === 'revise' && parsed.analysis_yaml) {
    await query(
      "UPDATE tasks SET analysis_yaml=$2, status='spec_review', updated_at=NOW() WHERE id=$1",
      [taskId, parsed.analysis_yaml]
    );
    // 不走 runner 的 writeAnalysisYaml：那支會一併清掉 spec_session_id／clarify_session_id，
    // 而這裡正是那場 spec_review 問答的中途，清了下一輪就續接不上（withResume 會整場重跑）。
    // 只補快照這一件事——少了它，最常走的這條路上使用者送出修改意見後畫面沒有新版規格書，
    // 版號也會跳號（下一次經分析關寫入時會把第 N+1 版記成第 N 版）。
    await recordSpecVersionSafe(taskId, parsed.analysis_yaml, task.analysis_yaml || null);
    enqueueEmbedding({ taskId });
  } else {
    await query("UPDATE tasks SET status='spec_review', updated_at=NOW() WHERE id=$1", [taskId]);
  }
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'spec_review' });
}

module.exports = { runSpecReview, parseSpecReview };
