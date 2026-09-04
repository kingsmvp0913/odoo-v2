const fs = require('fs');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { getProjectInfo, worktreeParent, buildRepoPaths } = require('./task-agent');
const { ensureWorktreeSkills } = require('./worktree-skills');
const { coreSourceGuidance } = require('../lib/odoo-core-src');
const { getProjectNotes } = require('./project-notes');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { safeReturnStatus } = require('./stations');
const { machineLogHeader, stripMachineHeader } = require('../../public/js/machine-logs.js');
const { taskAttachmentNote } = require('./sync');

// 卡在哪一關的中文顯示（stuck_stage 用）
const STAGE_LABEL = {
  analysis_running: '分析', coding_running: '開發', qa_running: 'QA 審查',
  merge_running: '併入測試', deploy_testing: '部署測試區', playwright_running: 'E2E 測試',
  respec_running: '調整規格', review_pending: '最終人工審核'
};
// advance.target → 目標 status（白名單，最遠只到 review_pending，不含 done）
const TARGET_STATUS = {
  qa: 'qa_running', merge: 'merge_running', deploy: 'deploy_testing',
  e2e: 'playwright_running', review: 'review_pending'
};
// 各關卡對應的重試計數器：落到該關時歸零，讓使用者聲稱已處理的關卡重取完整重試額度
const RESUME_COUNTER = {
  qa_running: 'qa_retry_count', deploy_testing: 'deploy_retry_count', playwright_running: 'pw_retry_count'
};
// 落回 coding＝碼要重改，下游關卡累積的失敗計數算的是「舊碼」，不該延續到新碼上。
// coding 自己沒有計數器，故它不在 RESUME_COUNTER 裡——但這使得 goto('coding_running') 一個計數器
// 都不歸零：實測 task 109 的 deploy_retry_count 卡在 4（上限 3），此後每次「修正指示→分診 fix→
// coding→QA→deploy」都在部署第一下就觸頂 stopped，coding 與 QA 是確定白跑的（每輪約 $1.7）。
const CODING_RESET_COUNTERS = ['qa_retry_count', 'deploy_retry_count', 'pw_retry_count'];
// 分診關自己：resume_status 若指向這兩者，代表它是 clarify 閘門寫的「回分診續判」回程，
// 不是原關——原關另存在 triage_home（見 db.js）。誤當原關會讓分診 resume 回到自己、無限重進分診。
const TRIAGE_STATUSES = new Set(['reject_triage', 'resolve_triage']);

async function stop(taskId, userId, reason) {
  await query("UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, reason]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  return true;
}

// 通用分診：任務停下（reject_triage=人工審核退回／resolve_triage=卡關填修正指示）後，
// 讀 diff＋runtime log 查清真相，依「停下原因＋使用者的話」判 resume/advance/fix/respec 決定下一步。
async function runRejectTriage(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, status, git_branch, analysis_yaml, retry_feedback, resume_status, triage_home, respec_return_status, blocker_content FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) return stop(taskId, userId, '專案未設定任何已完成 clone 的 Repo');

  const isReject = task.status === 'reject_triage';

  // 這裡曾有「人工退回 >=2 次就禁 fix、強制降級 respec」的防呆。已移除：它算的是任務累計退回次數，
  // 不是「同一問題重複退回」——兩件無關的退回（例：DB 欄位缺失 ＋ 按鈕樣式）會被算成同一筆帳，
  // 把純樣式修正誤判成規格問題整包重跑分析（實測 task 157）。「這次退的跟上次是不是同一件事」
  // 只有讀得懂內容的 agent 判得出來，改由它依「有沒有改變什麼算正確」自行判 fix／respec
  // （分界線寫在 analysis-reject.md）。把關的是人：每一輪 fix 都是人主動退回換來的（見下方 fix 分支）。

  // 情境輸入：停在哪關、停下原因、使用者最新的話、以及 resume 的「原關」——依入口組不同來源
  // rejectReason 另存乾淨的退回原文（userInstruction 下面會被接上近期對話與待吸收留言，不能複用）：
  // fix 分支要把它原樣送進規格檢查點，混入其他脈絡會讓 respec-patch 把對話內容也當成需求。
  let stuckStage, stopContext, userInstruction, homeStatus, rejectReason = null;
  if (isReject) {
    stuckStage = STAGE_LABEL.review_pending;
    stopContext = '任務已通過所有自動關卡（QA／E2E），在最終人工審核被審核者退回。';
    // 走 registry 的剝除器，不要自己寫 /^\[人工退回\]\s*/：轉義後的字面值繞得過
    // frontend-machine-logs 的前綴單一來源守衛（它比對的是未轉義字串），等於留下看不見的第二份副本。
    rejectReason = stripMachineHeader('manual_reject', task.retry_feedback) || null;
    userInstruction = rejectReason || '（無退回原因）';
    homeStatus = 'review_pending';
  } else {
    // resume_status 指向分診關本身＝走過 clarify 往返（閘門把回程寫在該欄），真正的原關在 triage_home。
    // respec_running 也是中繼關、不是原關：追加需求檢查點攔截推進時，「原本要去的那一關」記在
    // respec_return_status。respec 途中失敗（claude 逾時／認證撞刷新／回非 YAML）會停在 stopped，
    // 使用者解除阻塞後 resume_status 仍是 'respec_running'——不還原就會被下面的 safeReturnStatus
    // 當成非法值落到 coding_running，把一張已經跑到 deploy 的任務打回開發重跑整條尾巴，
    // 正好抵銷掉 respec_return_status 這個欄位存在的目的。
    const home = task.resume_status === 'respec_running'
      ? task.respec_return_status
      : ((TRIAGE_STATUSES.has(task.resume_status) ? null : task.resume_status) || task.triage_home);
    stuckStage = STAGE_LABEL[home] || home || '（未知）';
    stopContext = (task.blocker_content || '（無停下原因）').trim();
    const { rows: [instr] } = await query(
      "SELECT content FROM task_logs WHERE task_id=$1 AND role='user' AND content LIKE '[修正指示]%' ORDER BY created_at DESC LIMIT 1",
      [taskId]
    );
    userInstruction = instr ? instr.content.replace(/^\[修正指示\]\s*/, '').trim() : '（無指示）';
    homeStatus = safeReturnStatus(home);
  }
  // 併入近幾則對話（審核退回時審核者可能有補充）
  const { rows: dlg } = await query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 AND role IN ('user','ai') ORDER BY created_at DESC LIMIT 6", [taskId]
  );
  const convo = dlg.reverse().map(l => `${l.role === 'ai' ? 'AI' : '使用者'}：${l.content}`).join('\n');
  if (convo) userInstruction = `${userInstruction}\n---（近期對話）---\n${convo}`;

  // 尚未納入規格的使用者留言：使用者在關卡執行期間補的話，可能是追加需求，也可能只是流程指令
  // （「已修正，直接推進到部署測試區」這種）。分診看不到它就無從分辨——判 respec 才會讓 analysis
  // 把需求寫進規格，判 advance／fix 則等於當它不存在。這也是 respec 分支有資格銷帳的前提。
  const { rows: pendingMsgs } = await query(
    "SELECT content FROM task_messages WHERE task_id=$1 AND source='manual' AND applied_at IS NULL ORDER BY occurred_at ASC, id ASC",
    [taskId]
  );
  if (pendingMsgs.length) {
    userInstruction = `${userInstruction}\n---（尚未納入規格的使用者留言）---\n${pendingMsgs.map(m => String(m.content).trim()).join('\n')}`;
  }

  let raw;
  try {
    const agent = loadAgent('analysis-reject');
    // base 分支＝任務切點 ai-dev：用 main 當 diff 基底會把其他已核准任務的變更算成本任務的成果
    const { AI_BRANCH } = require('./git');
    const baseBranch = AI_BRANCH;
    const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
    const prompt = agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      main_branch: baseBranch,
      git_branch: task.git_branch || '（未設定）',
      repo_paths: buildRepoPaths(info, task.task_id),
      odoo_core_src: coreSourceGuidance(info.odoo_version, info.enterprise_src),
      analysis_yaml: task.analysis_yaml || '（無規格）',
      stuck_stage: stuckStage,
      stop_context: stopContext,
      user_instruction: userInstruction,
      // 退回意見的主要載體常是截圖（人工退回可夾帶附件）：不帶這段，分診就只能憑退回文字猜
      // fix／respec，而圖上畫的若是 SD 沒寫的東西，判出來的路由必錯（task 150 即如此）。
      attachments: await taskAttachmentNote(taskId),
      project_notes: projectNotes || ''
    }).trim();
    // 停在早期分析階段就被 resume 時 worktree 尚未建立；worktree 不存在 → 退回專案根（一定存在），
    // 否則 spawn 會拿不存在的 cwd 直接 ENOENT。分診不需任務 worktree（判 resume 後回 analysis 會重建）。
    const wt = worktreeParent(info.root, task.task_id);
    const cwd = fs.existsSync(wt) ? wt : info.root;
    if (cwd === wt) ensureWorktreeSkills(cwd);      // 退回專案根時不佈：那是主 clone，不是任務工作區
    const result = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, agentType: 'reject_triage' });
    raw = result.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'reject_triage', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'reject_triage', err);
    if (err.aborted) return true; // 手動暫停：狀態原地不動
    return stop(taskId, userId, stopReason('分診 Agent 執行失敗', err));
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal, ref: { taskId: task.task_id, projectId: task.project_id }, userId });
  const summary = (result?.summary || '').trim();
  const logAi = (content) => query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, content]);
  // 分診結論是工程訊息（講 Model／檔名／根因，寫給開發與審核看），走 machine-logs registry 的
  // `[審核分診]` 前綴讓時間軸收合成一句人話。outcome＝這次判去哪，收合後使用者才知道接下來會怎樣。
  // answer 分支（回答使用者提問）刻意不用它——那則是講給人聽的，要整段展開。
  const logTriage = (outcome, content) => logAi(`${machineLogHeader('triage_summary', outcome)}\n${content}`);

  // 列舉值先正規化再比對（大小寫／前後空白）：模型輸出不穩定，' FIX ' 這種飄動會一路掉到
  // 「未回傳有效結果」，整包分診結論被丟掉、任務白白 stopped。target 同理（不合法會靜默降級成 resume）。
  let decision = String(result?.decision ?? '').trim().toLowerCase();
  const target = String(result?.target ?? '').trim().toLowerCase();

  // 共用：清停下狀態、落到某 status（並歸零該關計數器）。keepFeedback 保留 retry_feedback 給重跑的關卡當回饋。
  // reentry_count 一律歸零：分診＝人工已介入，總循環兜底（MAX_REENTRY）額度應重新起算——
  // 否則達上限被停過的任務，人工放回後只剩一次下游失敗額度就再度永久 stopped，人工介入實質失效。
  // （代價：前端顯示的循環次數變成「距上次人工介入」的次數，屬可接受語意。）
  // feedback：明確寫入 retry_feedback（與 keepFeedback 互斥，優先）。給 fix 分支把分診結論交棒下去用。
  // returnStatus：落到 respec_running 這種「中繼關」時，把它跑完要去的那一關記進 respec_return_status
  // （respec-agent 讀這欄決定回哪）。不帶就照舊清成 NULL——用完即棄，留著會被之後的路徑誤讀。
  const goto = async (nextStatus, { keepFeedback = false, feedback = null, freshRespec = false, resetReentry = true, returnStatus = null } = {}) => {
    const counter = RESUME_COUNTER[nextStatus];
    // triage_home 一併清：本次分診已落地，暫存的原關用完即棄，留著會被下一次分診誤當原關
    const sets = ['status=$2', 'blocker_content=NULL', 'blocker_type=NULL', 'resume_status=NULL', 'triage_home=NULL', 'updated_at=NOW()'];
    const params = [taskId, nextStatus];
    if (returnStatus) { params.push(returnStatus); sets.push(`respec_return_status=$${params.length}`); }
    else sets.push('respec_return_status=NULL');
    if (resetReentry) sets.push('reentry_count=0');
    if (feedback !== null) { params.push(feedback); sets.push(`retry_feedback=$${params.length}`); }
    else if (!keepFeedback) sets.push('retry_feedback=NULL');
    // freshRespec＝交回分析重寫規格，coding 的痕跡要一併清乾淨。git_branch 必須跟 coding_session_id
    // 一起清：respec-agent 判「pre-coding」（＝規格審核閘門的對話式問答，該委派 spec-review）的條件是
    // 兩者皆空，只清一半會讓任務重產規格、停在 spec_review 後，使用者按「送出修改意見」時被判成
    // 「已開工」→ 跳過 spec-review 對話、把修改意見當追加需求 patch 完直接轉 coding_running，
    // 規格審核閘門被靜默繞過。清掉安全：branch_pending→coding 一定會重寫 git_branch，且分支名由
    // task_id 決定、重算同值。
    // spec_session_id／spec_prompt_ver 同樣一併清：真正落地點是 task-agent.js 分析關寫出新規格
    // 那一刻（writeAnalysisYaml，主防線），這裡只是提早在交回 analysis 之前先清一次的備援——
    // 萬一 analysis 那輪中途失敗、任務還沒走到那一刻就又被繞回 spec_review，也不會續接到舊 session。
    if (freshRespec) sets.push('coding_session_id=NULL', 'git_branch=NULL', 'spec_session_id=NULL', 'spec_prompt_ver=NULL');
    // 「終點是 coding」就歸零下游計數器，中間有沒有繞經 respec_running 不影響這個理由（下游計數算的是舊碼）。
    if (nextStatus === 'coding_running' || returnStatus === 'coding_running') sets.push(...CODING_RESET_COUNTERS.map(c => `${c}=0`));
    else if (counter) sets.push(`${counter}=0`);
    await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$1`, params);
    notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  };

  // answer → 純提問（僅最終人工審核退回）：在時間軸回答，不路由。回滾這次 /reject 的副作用——提問不算退回，
  // 只有真的退回修改才計入退回統計／健檢。刪本次 task_rejections(new)＋系統退回標記、清 retry_feedback。
  // 不動 reentry_count：/reject 本就不再累加它，故此處也無 +1 可回滾；若硬扣會誤傷真實自動彈跳累積的計數。
  if (decision === 'answer' && isReject) {
    const question = stripMachineHeader('manual_reject', task.retry_feedback) || '（提問）';
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)", [taskId, question]);
    await logAi(summary || '（無回答）');
    // 認 source='human' 而非 status='new'：classify 的 cron 撈 new 只花 5~13 秒、本關要跑 60~190 秒，
    // 實測每次都是 classify 先把 new 改成 classified，於是這行刪除從上線起一次都沒命中過
    // （正式庫 52 筆人工退回，status='new' 0 筆），使用者的提問被永久記成退回、灌進健檢的退回率。
    // 本分支只在 isReject（狀態 reject_triage）成立，而該狀態唯一入口就是剛插入這筆的 /reject，
    // 所以「最近一筆 human」必然是本次；source 過濾則保住 QA 自動退回那些真實統計來源。
    const { rows: [rej] } = await query(
      "SELECT id FROM task_rejections WHERE task_id=$1 AND source='human' ORDER BY created_at DESC, id DESC LIMIT 1",
      [task.task_id]
    );
    if (rej) await query('DELETE FROM task_rejections WHERE id=$1', [rej.id]);
    // 前綴比對而非整串相等：/reject 那筆改成 role='user' 且內容是「[人工退回]\n<原因全文>」之後，
    // 原本 content='[人工退回]' 的等值條件一次也命中不了——症狀是提問被回滾了，時間軸上卻還留著
    // 一則「你退回了這次審核」。上一行剛插入的提問本文沒有前綴，不會被這條誤刪。
    // role 收兩種：改版當下已經停在 reject_triage 的任務，標記還是舊的 role='system' 那一筆。
    // 用 substring 而非 LIKE '[人工退回]%'：pg-mem 把 LIKE 裡的 [...] 當成 regex 字元類別（真
    // Postgres 不會），寫成 LIKE 的話正式環境會刪、測試環境永遠刪不到，等於測試在說謊。
    // 長度直接內插：來源是本檔的常數前綴、不是使用者輸入；CJK 都在 BMP，JS 的 .length 與
    // Postgres substring 的字元數一致。
    const rejectMarker = machineLogHeader('manual_reject');
    const { rows: [sys] } = await query(
      "SELECT id FROM task_logs WHERE task_id=$1 AND role IN ('user','system')"
      + ` AND substring(content, 1, ${rejectMarker.length}) = $2`
      + ' ORDER BY created_at DESC, id DESC LIMIT 1',
      [taskId, rejectMarker]
    );
    if (sys) await query('DELETE FROM task_logs WHERE id=$1', [sys.id]);
    await query(
      "UPDATE tasks SET status='review_pending', retry_feedback=NULL, updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'review_pending' });
    return true;
  }

  // clarify → 停下批次問人：退回原因含糊到 fix 與 respec 都說得通、且答案會左右去向時，不硬猜，
  // 走與 QA 同一條統一 clarify 閘門問使用者。答完回原分診關（reject_triage/resolve_triage），
  // 由本員帶「使用者答覆＋原退回原因」續判。carryFeedback 保原因避免被清空。
  const clarifyQs = Array.isArray(result?.questions)
    ? result.questions.map(q => String(q).trim()).filter(Boolean) : [];
  if (decision === 'clarify' && clarifyQs.length) {
    if (summary) await logTriage('需要你回答問題', summary);
    // 閘門會把 resume_status 寫成分診關自己（答完的回程）——原關先搬進 triage_home，否則永久遺失。
    // 只有 resolve 入口有原關可保（reject 入口的原關固定是 review_pending，不需暫存）。
    if (!isReject) await query('UPDATE tasks SET triage_home=$2 WHERE id=$1', [taskId, homeStatus]);
    const { enterClarifyGate } = require('./verdict-router');
    await enterClarifyGate(taskId, userId, {
      questions: clarifyQs,
      carryFeedback: task.retry_feedback,
      resumeStatus: task.status,
      fromStatus: task.status
    });
    return true;
  }

  // respec → 交回分析：分診員不自己改 SD，把結論當「使用者澄清」餵給重跑的 analysis（clarification 讀 role='user'）
  if (decision === 'respec') {
    const handoff = summary || '判定為規格問題，請依停下原因重新分析並調整規格。';
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)", [taskId, `${machineLogHeader('respec_handoff')}\n${handoff}`]);
    // 留言的銷帳不在這裡：analysis 這輪可能失敗或被中止，跳關前先銷帳會讓第二輪分診改判 fix／
    // advance 時需求已消失。改由 task-agent.js 在「成功寫出新規格」的同一段落地（見該處註解）。
    await goto('analysis_running', { freshRespec: true });
    return true;
  }

  // fix → coding：保留 retry_feedback（退回原因／失敗回饋）給 coding resume 當修補依據。
  // 刻意「不」過總循環斷路器（bumpReentryOrStop），reentry 一律歸零：斷路器防的是 QA／deploy／E2E
  // 之間無人監督地空轉燒 token（那三關仍各自呼叫它），而分診的每一輪都是人主動退回／填修正指示
  // 換來的，帶著新資訊，不是機器空轉。舊版讓人工退回也吃額度（MAX_REENTRY=2），結果是第二次退回
  // 直接 stopped，且填修正指示 → 又判 fix → 又觸頂 → 任務永久推不動（實測過的死迴圈）。
  // 分診結論必須進 retry_feedback（coding 的輸入欄位），不能只 logAi 落時間軸——那只給人看。
  // 觸頂 stopped 進來的任務 retry_feedback 常是 NULL（上一輪 coding 推進時已消費），只靠
  // keepFeedback 保留到的是 NULL，整段診斷一個字都傳不到 coding，coding 只能空轉（實測 task 109）。
  // 兩份併存：原始失敗訊息說「哪裡壞了」，分診結論說「為什麼上一輪的修法沒用」，缺一不可。
  if (decision === 'fix') {
    if (summary) await logTriage('轉回開發修正', summary);
    const carried = [task.retry_feedback, summary && `[分診結論]\n${summary}`].filter(Boolean).join('\n\n');
    const opts = carried ? { feedback: carried } : { keepFeedback: true };
    // 人工退回一律先過規格檢查點，再進 coding。理由是 fix 這條路是唯一「使用者的話不經規格就直接
    // 落到 coding」的入口：退回意見若改變了「什麼算正確」，QA 手上仍只有舊 SD，會把「照使用者說的做」
    // 判成超出規格而退回，coding 再照 QA 的話改回去——使用者的要求被靜默抹掉，任務最後還顯示綠燈
    // （實測 task 126：選單改名要求連頁面標題一起改，來回兩輪後改動被完全還原）。分診 prompt 早已
    // 寫明這個後果（analysis-reject.md 的 fix／respec 分界線）卻仍判錯，故改由結構把關而非 prompt 自律。
    // 走的是既有的追加需求佇列：respec-patch 判有規格變更就 patch 進 analysis_yaml、判沒有（純 bug）
    // 就原樣放行，兩種結果最後都落到 coding，所以純實作性退回的行為與過去一致，只多一次規格比對。
    // 限 isReject：卡關修正指示（resolve）多為技術性修法，不走這條。限已開工（git_branch 有值）：
    // 未開工時 respec-agent 會判 pre-coding 改委派 spec-review，那是規格審核閘門、不是這裡要的路徑。
    // 分診結論在這條路上不會遺失：respec-agent 會先把 retry_feedback（含上面塞的 `[分診結論]`）讀成
    // carried、附進送給 respec-patch 的 requirements，再一起寫回 retry_feedback（見 respec-agent.js 的
    // carried 段）。本註解原本寫的是「會被 `[追加需求]` 覆寫掉、傳不到 coding」，那是 d0262da0
    // （2026-08-14 引入 carried）之前的行為，已不成立。
    if (isReject && rejectReason && task.git_branch) {
      // 標明來源：respec-patch 的判準對「途中留言」刻意保守（多數留言是流程指示，誤判成需求會讓
      // 跑到後段的任務整條白跑），但審核退回意見的先驗完全相反——它幾乎都在講成品哪裡不對。
      // 不標來源它會拿閒聊的標準去看退回意見、一律判無變更，整道檢查點就成了 no-op。
      await query(
        "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1, 'manual', '人工退回', $2, NOW())",
        [taskId, `[人工審核退回意見]\n${rejectReason}`]
      );
      await goto('respec_running', { ...opts, returnStatus: 'coding_running' });
      return true;
    }
    await goto('coding_running', opts);
    return true;
  }

  // advance → 放行推進到 target（白名單，最遠 review）；target 不合法則保守退回 resume
  if (decision === 'advance' && TARGET_STATUS[target]) {
    if (summary) await logTriage('放行往下一關', summary);
    let advanceTo = TARGET_STATUS[target];
    // target=deploy 不直落部署：部署讀的是主 clone 常駐 testing 的工作樹，而 doDeploy 只做
    // ensureTestingBranch（純 checkout，不併任務分支）——task→testing 的合併只有 merge_running 會做。
    // 直落等於拿未併的舊碼重跑、回報同一個舊錯誤，coding 進去查碼發現早已修好、無事可做而 stop，
    // 人再填一次修正指示又繞回來（raifong T1 實測連續五輪白跑）。改先過 merge：merge 成功本來就轉
    // deploy_testing，分支已併時走 Already up to date 的快速路徑，等於只多一個冪等步驟。
    // deploy 計數要自己補歸零：落點改成 merge 後 RESUME_COUNTER 查不到它，而使用者說「已修好、重測
    // 部署」本就該重取完整額度（實測 task 109：計數卡在上限，之後每輪都在部署第一下觸頂白跑）。
    if (advanceTo === 'deploy_testing') {
      advanceTo = 'merge_running';
      await query('UPDATE tasks SET deploy_retry_count=0 WHERE id=$1', [taskId]);
      // 不留痕的話，使用者要的是「重測部署」、看到的卻是狀態變成「併入測試」，像被判去了別的地方
      await logAi('先併入測試分支再部署——部署讀的是 testing 分支，未併入會跑到舊碼、回報同一個舊錯誤');
    }
    // 專案停用 E2E：advance 推進到 E2E 時改導向最終人工審核（旗標在此處也當家，堵住繞過主推進點的路徑）
    if (advanceTo === 'playwright_running') {
      const { rows: [proj] } = await query('SELECT e2e_disabled FROM projects WHERE id=$1', [task.project_id]);
      if (proj && proj.e2e_disabled) {
        await logAi('E2E 已依專案設定停用，跳過');
        advanceTo = 'review_pending';
      }
    }
    await goto(advanceTo);
    return true;
  }

  // resume（含 advance 但 target 不合法）→ 回原關重跑，保留 retry_feedback 給該關當回饋
  if (decision === 'resume' || decision === 'advance') {
    if (summary) await logTriage('回到原本那一關重跑', summary);
    await goto(homeStatus, { keepFeedback: true });
    return true;
  }

  // decision 認得、但這一輪用不了 → 停下交人工，並說清楚實際發生什麼。
  // 刻意**不**比照 advance 缺 target 那樣降級放行——方向性相反：advance 降級是放棄往前推進、
  // 回原關重跑（更保守）；這兩種降級卻是放寬：
  //   - clarify 缺題：agent 說它得先問使用者才能決定方向，卻沒產出題目。放行＝讓任務帶著未解的
  //     疑問繼續跑，多半重蹈覆轍。
  //   - answer 走錯入口：agent 以為使用者只是提問，但 resolve 入口收到的是卡關修正指示。
  //     放行＝使用者的疑問沒人回答。
  // 只修訊息：舊版兩者都掉到下面那句通用文案，把「agent 挑錯決策」謊報成「未回傳有效結果」，
  // 看到的人會跑去 terminal 找解析失敗——但根本沒有解析失敗，agent 有好好回結果。
  const MISUSE = {
    clarify: '分診判定需要先問你問題才能決定方向，卻沒有產出任何題目',
    answer: '分診判定這是一則提問（該決策僅適用於最終人工審核退回），但這裡收到的是卡關修正指示',
  };
  if (MISUSE[decision]) return stop(taskId, userId, `${MISUSE[decision]}。請補充說明後再送出。`);

  return stop(taskId, userId, `分診 Agent 未回傳有效結果（decision=${decision || '空'}），請檢查 terminal 輸出`);
}

module.exports = { runRejectTriage };
