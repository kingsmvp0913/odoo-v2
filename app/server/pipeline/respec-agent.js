const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { taskWorkContext } = require('./work-context');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { enqueue: enqueueEmbedding } = require('../lib/embedding-index');
const yaml = require('js-yaml');
const { safeReturnStatus } = require('./stations');

// 遞迴排序物件鍵並 trim 字串，讓「同一份規格的不同寫法」收斂成同一個字串。
// 陣列順序保留（規格的 requirements 是有序的，重排屬實質變更）。
function stableKey(v) {
  if (Array.isArray(v)) return v.map(stableKey);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = stableKey(v[k]); return o; }, {});
  }
  return typeof v === 'string' ? v.trim() : v;
}

// 兩份規格「語意上」是否相同。用來決定 respec 後任務回原關還是退回 coding 重做整條，
// 所以誤判的代價是一整輪 coding→QA→merge→deploy 白跑。
// 不能用位元組比對：agent 重排鍵序／換引號／改縮排都不是規格變更，而它是否逐字複製本來就不可控
// （respec-patch.md 已明說不必逐字複製）。任一側解析失敗 → 退回位元組比對，寧可誤判成「有變更」
// 多跑一輪，也不要把真需求當成沒變更而靜默丟掉。
function specUnchanged(oldYaml, newYaml) {
  const norm = s => String(s || '').replace(/\r\n/g, '\n').trim();
  try {
    const a = stableKey(yaml.load(norm(oldYaml), { schema: yaml.CORE_SCHEMA }));
    const b = stableKey(yaml.load(norm(newYaml), { schema: yaml.CORE_SCHEMA }));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
  } catch { /* 解析失敗 → 落到位元組比對 */ }
  return norm(oldYaml) === norm(newYaml);
}

// respec_running：使用者途中留言＝追加需求。把待吸收的 manual 留言增量 patch 進 analysis_yaml
// （維持單一規格來源，QA 重驗吃得到），並把需求也塞進 retry_feedback（coding 每輪都帶 retry_feedback，
// 確保新需求一定被看到），退回 coding_running 增量補實作。留言標 applied_at＝已吸收（防反覆觸發）。
async function runRespecPatch(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, analysis_yaml, coding_session_id, git_branch, respec_return_status FROM tasks WHERE id = $1', [taskId]
  );
  if (!task) return;

  // 追加需求檢查點攔截推進時記下的「原本要去的那一關」；沒有（舊資料／其他入口）才退回 coding。
  const returnTo = safeReturnStatus(task.respec_return_status);

  // pre-coding（規格審核閘門，coding 尚未開工）＝對話式規格問答，委派 spec-review 處理器讀 task_logs 判 answer/revise。
  // 判定不能只看 coding_session_id：coding fresh 成功但 CLI 沒回 sessionId 時會存 NULL（task-agent 以 COALESCE 防的正是這件事）；
  // git_branch 於 branch_pending→coding 轉移必寫＝「已開工」的可靠訊號，兩者皆空才是 pre-coding。
  const preCoding = !task.coding_session_id && !task.git_branch;
  if (preCoding) {
    const { runSpecReview } = require('./spec-review');
    return runSpecReview(task, userId, signal);
  }

  // 撈這批待吸收留言（capture ids：patch 期間新進的留言留到下一個檢查點，不在這批標記）
  const { rows: pending } = await query(
    "SELECT id, content FROM task_messages WHERE task_id = $1 AND source = 'manual' AND applied_at IS NULL ORDER BY occurred_at ASC, id ASC",
    [taskId]
  );
  if (!pending.length) {
    // 競態：留言已被別的路徑吸收 → 不空跑 agent，直接回原本要去的關
    await query("UPDATE tasks SET status=$2, respec_return_status=NULL, updated_at=NOW() WHERE id=$1", [taskId, returnTo]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: returnTo });
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
    // 分析關建好的 worktree：追加需求要落成 requirements 給開發關照做，憑印象寫錯欄位名下游就照著錯，
    // 有 worktree 就讓它先查證再寫；沒有就照舊只看 analysis_yaml
    const work = await taskWorkContext(task);
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      requirements,
      repo_paths: work ? work.repoPaths : ''
    }).trim();
    const result = await runClaude(prompt, { cwd: work ? work.cwd : undefined, taskId, userId, signal, model: agent.model, agentType: 'respec' });
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

  // 留言不含實質規格變更（使用者拿留言框下流程指令是常態——那是推進卡住任務的唯一管道），
  // 規格一字未動就沒有東西要 coding 補實作：回原本要去的那一關，不退 coding。
  // 否則一句「已修正，直接推進到部署測試區」會讓 coding→QA→merge→deploy 整條白跑一遍（task 171）。
  // 規格沒變 ⇒ qa_session_id 不清（QA 可續用舊 session）、retry_feedback 不寫（沒有新需求要交代）。
  //
  // 比對走 specUnchanged（語意，非位元組）——理由見該函式註解。
  if (specUnchanged(task.analysis_yaml, newYaml)) {
    await query(
      "UPDATE tasks SET status = $2, respec_return_status = NULL, updated_at = NOW() WHERE id = $1",
      [taskId, returnTo]
    );
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId,
      '留言不含規格變更（多為流程指示），規格維持原樣，任務照原流程繼續。']).catch(() => {});
    notify.emitToUser(userId, 'task:updated', { taskId, status: returnTo });
    return;
  }

  // 途中追加需求：retry_feedback 帶 [追加需求] 前綴＋需求本文，退回 coding（coding 每輪都讀 retry_feedback 做增量）。
  // 一併清 qa_session_id／歸零 qa_resume_count：規格已改，下輪 QA 必須跑 fresh 讀新 analysis_yaml，
  // 否則 resume 舊 session（內嵌舊規格、qa-retry prompt 不帶新規格）＝用舊規格審查。
  await query(
    "UPDATE tasks SET analysis_yaml = $2, retry_feedback = $3, status = 'coding_running', respec_return_status = NULL, qa_session_id = NULL, qa_resume_count = 0, updated_at = NOW() WHERE id = $1",
    [taskId, newYaml, `[追加需求]\n${requirements}`]
  );
  enqueueEmbedding({ taskId });
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
}

module.exports = { runRespecPatch };
