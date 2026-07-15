const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const yaml = require('js-yaml');

// respec_running：使用者途中留言＝追加需求。把待吸收的 manual 留言增量 patch 進 analysis_yaml
// （維持單一規格來源，QA 重驗吃得到），並把需求塞進 retry_feedback（coding-retry resume 不讀 analysis_yaml，
// 只讀 retry_feedback），退回 coding_running 走 resume 增量補實作。留言標 applied_at＝已吸收（防反覆觸發）。
async function runRespecPatch(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, analysis_yaml, coding_session_id FROM tasks WHERE id = $1', [taskId]
  );
  if (!task) return;

  // coding_session_id 只在 coding fresh 成功後寫入 → 不存在＝coding 從未跑過＝這是規格審核閘門的改規格
  // （spec_review 嚴格在 coding 之前）。patch 完退回 spec_review 讓使用者重看、不設 retry_feedback（尚無 session 可 resume）。
  // 存在＝途中追加需求，照舊退回 coding_running 走 resume 增量補實作、帶 retry_feedback。
  const preCoding = !task.coding_session_id;
  const returnStatus = preCoding ? 'spec_review' : 'coding_running';

  // 撈這批待吸收留言（capture ids：patch 期間新進的留言留到下一個檢查點，不在這批標記）
  const { rows: pending } = await query(
    "SELECT id, content FROM task_messages WHERE task_id = $1 AND source = 'manual' AND applied_at IS NULL ORDER BY occurred_at ASC, id ASC",
    [taskId]
  );
  if (!pending.length) {
    // 競態：留言已被別的路徑吸收 → 不空跑 agent，直接退回原關卡
    await query("UPDATE tasks SET status=$2, updated_at=NOW() WHERE id=$1", [taskId, returnStatus]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: returnStatus });
    return;
  }
  // maxId＝這批最後一則的 id（SERIAL 單調遞增）：patch 期間新進的留言 id 必更大，用 id <= maxId
  // 精準標記「這批」而不誤標之後才進來的（留到下一個檢查點）。
  const maxId = pending[pending.length - 1].id;
  const requirements = pending.map((p, i) => `${i + 1}. ${String(p.content).trim()}`).join('\n');

  const ref = { taskId: task.task_id, projectId: task.project_id };
  const agent = loadAgent('respec-patch');
  let raw;
  try {
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      requirements
    }).trim();
    const result = await runClaude(prompt, { taskId, userId, signal, model: agent.model, agentType: 'respec' });
    raw = result.text;
    await logTokenUsage(ref, userId, 'respec', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage(ref, userId, 'respec', err);
    if (err.aborted) return; // 手動暫停：狀態原地不動，解除後從 respec_running 重跑
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, stopReason('追加需求更新規格失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  // 解析：patch 後的完整 analysis_yaml（驗證可被 yaml.load 解析為物件，回傳原始文字保存）
  const newYaml = await parseAgentResult(raw, {
    parse: s => {
      const v = yaml.load(s, { schema: yaml.CORE_SCHEMA });
      if (!v || typeof v !== 'object') throw new Error('patch 結果非有效 YAML 物件');
      return String(s).trim();
    },
    signal, ref, userId
  });
  if (!newYaml) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='追加需求更新規格未回傳有效 YAML，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  // 標記這批留言已吸收（先標記再退，即使無實質變更也不會反覆觸發）。
  await query(
    "UPDATE task_messages SET applied_at = NOW() WHERE task_id = $1 AND source = 'manual' AND applied_at IS NULL AND id <= $2",
    [taskId, maxId]
  );
  if (preCoding) {
    // 規格審核閘門的改規格：更新規格後退回 spec_review 讓使用者重看，不設 retry_feedback（尚無 coding 可 resume）。
    await query(
      "UPDATE tasks SET analysis_yaml = $2, status = 'spec_review', updated_at = NOW() WHERE id = $1",
      [taskId, newYaml]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'spec_review' });
  } else {
    // 途中追加需求：retry_feedback 帶 [追加需求] 前綴（distillFeedback 取 gate='追加需求'、body=需求本文餵給 coding-retry resume），退回 coding。
    await query(
      "UPDATE tasks SET analysis_yaml = $2, retry_feedback = $3, status = 'coding_running', updated_at = NOW() WHERE id = $1",
      [taskId, newYaml, `[追加需求]\n${requirements}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
  }
}

module.exports = { runRespecPatch };
