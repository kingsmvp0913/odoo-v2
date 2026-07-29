const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectNotes } = require('./project-notes');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const yaml = require('js-yaml');

// 澄清閘門的對話關（confirm_pending／clarify_pending 共用）：跑 clarify-chat agent。
// 三種決策：answer（回答、狀態原地不動）／proceed（推進）／revise（產題目草案）。
// 推進與否由 mode 在結構上限定——不靠 prompt 自律，「提問」入口就算 agent 硬回 proceed 也推不動。
const Q_SEP = '---QUESTIONS---';

function parseClarifyChat(s) {
  const text = String(s).trim();
  const m = text.match(/^DECISION:\s*(answer|proceed|revise)\b/i);
  if (!m) throw new Error('缺 DECISION');
  const decision = m[1].toLowerCase();
  const rest = text.slice(m[0].length);
  const sepIdx = rest.indexOf(Q_SEP);
  const replyPart = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
  const reply = replyPart.replace(/^\s*REPLY:\s*/i, '').trim();
  if (!reply) throw new Error('缺 REPLY');
  let questions_yaml = null;
  if (decision === 'revise') {
    if (sepIdx === -1) throw new Error('revise 缺 ---QUESTIONS---');
    const yamlStr = rest.slice(sepIdx + Q_SEP.length).trim();
    const v = yaml.load(yamlStr, { schema: yaml.CORE_SCHEMA });
    if (!v || typeof v !== 'object') throw new Error('QUESTIONS 非有效 YAML 物件');
    questions_yaml = yamlStr;
  }
  return { decision, reply, questions_yaml };
}

// mode → 允許的決策集合。結構性限制：agent 回了不被允許的決策就降級成 answer，
// 因為 answer 是唯一「什麼都不會壞」的結果（只是多回一句話）。
const MODE_RULES = {
  answer_or_proceed: {
    allow: ['answer', 'proceed'],
    rule: '本次只允許 `answer` 或 `proceed`。使用者剛送出題目的回答——他若在反問、或有必答題沒被答到，回 answer；都答齊了才回 proceed。'
  },
  ask: {
    allow: ['answer'],
    rule: '本次只允許 `answer`。使用者是主動來提問的，不是來答題的——單純回答他的問題，不要催他答題，也不要推進任務。'
  },
  revise: {
    allow: ['revise'],
    rule: '本次只允許 `revise`。使用者問完了，要你依這段對話重新產出題目清單（含已可確定的預填答案）。'
  }
};

// 對話回帶 user＋ai 兩邊（比照 spec-review）：只帶 user 會讓 agent 看不到自己問過什麼、換角度重問。
async function loadConversation(taskId) {
  const { rows } = await query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 AND role IN ('user','ai') ORDER BY created_at DESC, id DESC LIMIT 12",
    [taskId]
  );
  return rows.reverse().map(l => `${l.role === 'ai' ? 'AI' : '使用者'}：${l.content}`).join('\n') || '（無對話）';
}

// agent 失敗／解析失敗時退回的狀態：這兩關是「等你回答」，一旦 stopped 使用者就失去回答入口。
// 使用者的答案在跑 agent 之前已寫進 task_logs，不會遺失。
// 回程狀態由 resume_status 記載（路由在轉 clarify_chat_running 時寫入原狀態）；
// 直接以 clarify_pending 狀態呼叫時（補跑路徑）也認得。
function fallbackStatus(task) {
  return task.resume_status === 'clarify_pending' || task.status === 'clarify_pending'
    ? 'clarify_pending' : 'confirm_pending';
}

async function failBack(task, userId, message) {
  const back = fallbackStatus(task);
  await query("UPDATE tasks SET status=$2, updated_at=NOW() WHERE id=$1", [task.id, back]);
  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [task.id, message]);
  notify.emitToUser(userId, 'task:updated', { taskId: task.id, status: back });
}

// 認證失效（claude-runner 已標 claudeStatus='auth'，見 auth-signature.js）對使用者是
// 「跟你的回答無關、再按一次多半就過」；其餘失敗才需要他知道是系統出錯。
function failMessage(err) {
  if (err && err.claudeStatus === 'auth') return 'AI 連線認證暫時失效（與你的回答無關），請再送出一次。';
  return `AI 回覆失敗，請再送出一次。（${stopReason('澄清問答', err)}）`;
}

async function runClarifyChat(taskArg, userId, signal, mode) {
  const taskId = taskArg.id;
  // 重查完整任務列：runner 派工只 SELECT 六個欄位（runner.js:425），analysis_yaml／resume_status／
  // clarify_mode 都不在其中——直接用傳進來的物件會讓 agent 拿到「（無規格）」。
  const { rows: [task] } = await query('SELECT * FROM tasks WHERE id=$1', [taskId]);
  if (!task) return;
  // mode 以 DB 為準（路由寫入），呼叫端顯式指定時才覆蓋（供測試與未來的直呼叫）
  mode = mode || task.clarify_mode;
  const ref = { taskId: task.task_id, projectId: task.project_id };
  // 未知 mode 退到「最嚴格」而非最寬鬆：這行是「結構性擋住推進」的唯一落點，
  // 呼叫端拼錯字不該讓限制最嚴的入口靜默變成可推進。
  let modeCfg = MODE_RULES[mode];
  if (!modeCfg) {
    console.error(`[CLARIFY] 未知 mode '${mode}'，退到只准 answer`);
    modeCfg = MODE_RULES.ask;
  }

  let raw;
  try {
    const agent = loadAgent('clarify-chat');
    const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      conversation: await loadConversation(taskId),
      mode_rule: modeCfg.rule,
      project_notes: projectNotes || ''
    }).trim();
    const result = await runClaude(prompt, { taskId, userId, signal, model: agent.model, agentType: 'respec' });
    raw = result.text;
    await logTokenUsage(ref, userId, 'respec', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage(ref, userId, 'respec', err);
    if (err.aborted) return; // 手動暫停：狀態原地不動
    await failBack(task, userId, failMessage(err));
    return;
  }

  // 不包 try/catch：parseAgentResult 只在「補救呼叫本身被 abort」時往外拋，
  // 那是手動暫停＝正常流程，必須讓它往上傳（比照 spec-review／respec-agent），
  // 吞掉會把暫停誤標成「AI 回覆失敗」寫進時間軸還改狀態。解析失敗它自己回 null。
  const parsed = await parseAgentResult(raw, { parse: parseClarifyChat, signal, ref, userId });
  if (!parsed) {
    await failBack(task, userId, 'AI 回覆失敗，請再送出一次。（未回傳有效結果）');
    return;
  }

  // 決策不在本 mode 允許範圍 → 降級成 answer（回話但不推進、不改題目），絕不放行成推進
  const decision = modeCfg.allow.includes(parsed.decision) ? parsed.decision : 'answer';

  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, parsed.reply]);

  if (decision === 'proceed') {
    const next = fallbackStatus(task) === 'clarify_pending' ? 'clarify_answered' : 'confirm_answered';
    await query("UPDATE tasks SET status=$2, updated_at=NOW() WHERE id=$1", [taskId, next]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: next });
    return;
  }

  if (decision === 'revise') {
    const back = fallbackStatus(task);
    await query("UPDATE tasks SET clarify_draft=$2, status=$3, updated_at=NOW() WHERE id=$1", [taskId, parsed.questions_yaml, back]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: back });
    return;
  }

  const back = fallbackStatus(task);
  await query("UPDATE tasks SET status=$2, updated_at=NOW() WHERE id=$1", [taskId, back]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: back });
}

module.exports = { parseClarifyChat, runClarifyChat, loadConversation, MODE_RULES };
