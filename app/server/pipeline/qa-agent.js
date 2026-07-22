const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent, promptVersion } = require('./agent-loader');
const { getProjectInfo, worktreeParent, buildRepoPaths, latestResolution } = require('./task-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { classifyFailure } = require('./failure-classifier');
const { parseQaIssues, recordQaRejection } = require('./qa-rejection');
const { getProjectNotes } = require('./project-notes');

const QA_LIMIT = 5;
// 每個 QA session 世代最多 resume 幾次（比照 coding 的 RESUME_LIMIT）：重驗走 --resume
// 續用上輪對話（已含規格、規則、上輪 diff 探索），只送短增量 prompt 省 token
const QA_RESUME_LIMIT = 2;

// QA 審查：對照 SD 檢查任務 diff。pass→merge_running；fail→退 coding 並計數（滿 QA_LIMIT→stopped）。
async function runQaAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, user_id, git_branch, analysis_yaml, qa_retry_count, qa_session_id, qa_resume_count, qa_prompt_ver, qa_reviewed_commit FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;
  // prompt 版本綁定：qa prompt 改過（版本不符）或舊任務（NULL）→ resume 前判為不可續用，走 fresh 吃新指令。
  const qaVer = promptVersion('qa');

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='專案未設定任何已完成 clone 的 Repo', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 死結熔斷（P6）：自上輪 QA 後任務分支 HEAD 未變＝coding 認定程式已對、未提交任何修正，但 QA 又要 fail
  // → 兩邊僵住。與其一路燒到 QA_LIMIT（現在每輪都是全新 opus coding），提早停下轉人工裁決
  // （既有 triage 能判 QA 對→advance 放行、QA 錯→fix 補指示）。以單一主 repo 為準（單模組任務為主）。
  let headSha = null;
  if (task.git_branch && info.repos?.[0]?.local_path) {
    const { revParse } = require('./git');
    try { headSha = await revParse(info.repos[0].local_path, task.git_branch); } catch { /* 分支未建／無 commit：略過偵測 */ }
  }
  if (headSha && task.qa_reviewed_commit === headSha && (task.qa_retry_count || 0) > 0) {
    const { rows: [prev] } = await query(
      "SELECT content FROM task_logs WHERE task_id=$1 AND role='ai' AND content LIKE '[QA 未通過]%' ORDER BY id DESC LIMIT 1",
      [taskId]
    );
    const findings = prev ? prev.content.replace(/^\[QA 未通過\]\s*/, '').trim() : '（見上輪 QA 清單）';
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='code', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, `QA 與開發僵局：自上輪 QA 後任務分支未有新 commit（coding 認為程式已正確、未修改），但 QA 仍判未通過。需你裁決 QA 指出的問題是否成立——成立→補充如何修正；不成立→可裁決放行。\n\nQA 未解清單：\n${findings.slice(0, 500)}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 產出本輪 QA 原始輸出（resume 或 fresh）：抽成內部函式，好在 transient 失敗時整段重跑一次（比照 deploy-testing）
  const attempt = async () => {
    // 主分支名依實際 repo 而定（main/master），寫死 main 會讓 diff 基底錯誤、審查失準
    const { getMainBranch } = require('./git');
    const mainBranch = await getMainBranch(info.repos[0].local_path).catch(() => 'main');
    // 撈最近一筆 QA 未解清單餵給本輪：QA 逐項重驗（修好的掉、沒修的留、新的加），讓迴圈收斂而非每輪重新發散。
    // 新語意下每筆 [QA 未通過] 本身即「當下完整未解清單」，取最新一筆＝最完整，不必串接歷史。
    const { rows: [prev] } = await query(
      "SELECT content FROM task_logs WHERE task_id=$1 AND role='ai' AND content LIKE '[QA 未通過]%' ORDER BY id DESC LIMIT 1",
      [taskId]
    );
    const priorFindings = prev ? prev.content.replace(/^\[QA 未通過\]\s*/, '').trim() : '（首輪，無上輪清單）';
    const resolution = (await latestResolution(taskId)) || '（無）';
    // QA 在任務 worktree 父目錄操作（可跨 repo 子目錄讀 diff），只讀不改
    const cwd = worktreeParent(info.root, task.task_id);

    // 重驗走 --resume：上輪 session 已含規格＋審查規則＋repo 探索，本輪只送「重取 diff＋逐項重驗」
    // 的短增量 prompt（比照 coding 的省 token 設計）。首輪／無上輪清單／resume 額度用完 → fresh。
    const canResume = !!task.qa_session_id && (task.qa_resume_count || 0) < QA_RESUME_LIMIT && !!prev && task.qa_prompt_ver === qaVer;
    let callResult = null;
    if (canResume) {
      const retryAgent = loadAgent('qa-retry');
      const prompt = retryAgent.render({
        main_branch: mainBranch,
        git_branch: task.git_branch || '（未設定）',
        repo_paths: buildRepoPaths(info, task.task_id),
        prior_findings: priorFindings,
        resolution
      }).trim();
      try {
        callResult = await runClaude(prompt, { cwd, taskId, userId, signal, resumeSessionId: task.qa_session_id, model: retryAgent.model, agentType: 'qa' });
        await query('UPDATE tasks SET qa_resume_count = qa_resume_count + 1, qa_session_id = COALESCE($2, qa_session_id) WHERE id=$1', [taskId, callResult.sessionId]).catch(() => {});
      } catch (err) {
        if (err.aborted) throw err; // 手動暫停：交外層原樣處理，session 留著解除後續用
        // timeout：清掉 stale session（並歸零 count，比照 session-lost 分支）再 rethrow，讓下次解鎖
        // 降級為 fresh 讀新脈絡；否則人工每次解鎖都拿同一 stale session 重演同一 timeout、counter 也永不推進
        if (err.claudeStatus === 'timeout') {
          await query('UPDATE tasks SET qa_session_id=NULL, qa_resume_count=0 WHERE id=$1', [taskId]).catch(() => {});
          throw err;
        }
        // 其餘（session 遺失、CLI 壞掉）記帳後清 session 改跑 fresh 一次
        await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', err);
        await query('UPDATE tasks SET qa_session_id=NULL, qa_resume_count=0 WHERE id=$1', [taskId]).catch(() => {});
        callResult = null;
      }
    }
    if (!callResult) {
      const agent = loadAgent('qa');
      const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
      const prompt = agent.render({
        project_name: info.name,
        odoo_version: info.odoo_version,
        main_branch: mainBranch,
        git_branch: task.git_branch || '（未設定）',
        repo_paths: buildRepoPaths(info, task.task_id),
        analysis_yaml: task.analysis_yaml || '（無規格）',
        prior_findings: priorFindings,
        resolution,
        project_notes: projectNotes || ''
      }).trim();
      callResult = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, agentType: 'qa' });
      await query('UPDATE tasks SET qa_session_id=$2, qa_resume_count=0, qa_prompt_ver=$3 WHERE id=$1', [taskId, callResult.sessionId || null, qaVer]).catch(() => {});
    }
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', callResult.usage, callResult.durationMs);
    return callResult.text;
  };

  let raw;
  try {
    try {
      raw = await attempt();
    } catch (err) {
      // transient（網路抖動/行程被砍）→ 自動重試一次，不佔任何計數（比照 deploy-testing）；其餘原樣往外拋
      if (err.aborted || classifyFailure(err.message, { claudeStatus: err.claudeStatus }) !== 'transient') throw err;
      raw = await attempt();
    }
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    // 依失敗類別歸因 blocker_type（env/code/transient）；判不出（unknown）留 null 交人工，不再一律 null（健檢根因 B）。
    // timeout 分類器契約上不判（回 unknown），但它是 infra 而非程式問題——比照 deploy 關標 env，人工一眼可識別（健檢 R4）
    const cls = err.claudeStatus === 'timeout' ? 'env' : classifyFailure(err.message, { claudeStatus: err.claudeStatus });
    await query(
      "UPDATE tasks SET status='stopped', blocker_type=$3, blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, stopReason('QA Agent 執行失敗', err), cls === 'unknown' ? null : cls]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 記下本輪實際審查的分支 HEAD：下輪 QA 若 HEAD 未變＝coding 未提交修正 → 上方死結熔斷提早轉人工。
  if (headSha) await query('UPDATE tasks SET qa_reviewed_commit=$2 WHERE id=$1', [taskId, headSha]).catch(() => {});

  let result = await parseAgentResult(raw, { parse: JSON.parse, signal, ref: { taskId: task.task_id, projectId: task.project_id }, userId });

  // 正規化 verdict 再比對：大小寫／前後空白／詞形變體（PASS／FAIL／「 pass 」／passed／failed）都落到
  // 既有 handler，否則 FAIL＋完整 issues 清單會被整包丟到「未回傳有效結果」stopped、不退 coding、log 不寫
  const normalizeVerdict = r => {
    const v = String(r?.verdict).trim().toLowerCase();
    return v === 'passed' ? 'pass' : v === 'failed' ? 'fail' : v;
  };
  // fail 必須附可行動細節（issues 或 summary）才有資格退 coding——「未提供細節」的 fail 會讓 coding
  // 瞎改一輪、還污染下一輪 QA 的未解清單，白燒 qa_retry/reentry（健檢 R3）。判定與下方實際消費
  // （parseQaIssues）須同一函式，否則 guard 放行的畸形 fail 會讓 detail.list 對 null 取屬性炸掉。
  // spec_questions 非空＝有效的規格裁決請求：即使沒有 issues/summary 也不算「無細節的無效 fail」，
  // 不可被 R3 攔截吞掉（否則規格歧義永遠進不了 clarify gate）。
  const hasSpec = r => Array.isArray(r?.spec_questions) && r.spec_questions.some(s => String(s).trim());
  let verdict = normalizeVerdict(result);

  if (verdict === 'fail' && !parseQaIssues(result) && !hasSpec(result)) {
    // fail 卻沒任何細節＝本輪審查無效：重問一次（非退 coding、不寫 [QA 未通過] log、不佔計數）；
    // 重問仍無細節才停等人工，blocker 講明實際收到的內容而非泛稱格式錯誤
    notify.emitToUser(userId, 'terminal:output', { taskId, data: '[QA] 回報 fail 但未附問題清單，視為無效審查，重問一次...\n' });
    try {
      raw = await attempt();
      result = await parseAgentResult(raw, { parse: JSON.parse, signal, ref: { taskId: task.task_id, projectId: task.project_id }, userId });
      verdict = normalizeVerdict(result);
    } catch (err) {
      if (err.aborted) return true; // 手動暫停：比照上方，狀態原地不動
      await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', err);
      result = null; verdict = ''; // 重問也掛掉 → 走下方無效結果停等人工
    }
    if (verdict === 'fail' && !parseQaIssues(result) && !hasSpec(result)) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_content='QA 連兩輪回報 fail 但未附任何問題清單（issues/summary 皆空），無法退開發修正，請人工檢視 diff', updated_at=NOW() WHERE id=$1",
        [taskId]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return true;
    }
  }

  if (verdict === 'pass') {
    await query("UPDATE tasks SET status='merge_running', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_running' });
    return true;
  }

  if (verdict === 'fail') {
    // 規格歧義分流（規格 §3.1/§3.2）：spec_questions 非空 → 批次問使用者，同輪 code 問題暫存待答完一次補。
    const specQs = Array.isArray(result?.spec_questions)
      ? result.spec_questions.map(s => String(s).trim()).filter(Boolean) : [];
    if (specQs.length) {
      const d = parseQaIssues(result);
      const codeCarry = d ? (d.list.length ? d.list.join('\n') : d.summary) : '';
      const { enterClarifyGate } = require('./verdict-router');
      await enterClarifyGate(taskId, userId, { questions: specQs, codeFeedback: codeCarry });
      return true;
    }
    const detail = parseQaIssues(result); // 上方已擋掉無細節的 fail，此處必有值
    const issues = detail.list.length ? detail.list.join('\n') : detail.summary;
    // 落地 QA 退回（含逐條根因）→ 退回紀錄＋餵健檢；env_flaky 也照寫供統計
    await recordQaRejection(task, detail.items, detail.summary).catch(e =>
      console.error('[QA] recordQaRejection 失敗:', e.message));
    // summary 是 md 契約要求的「給實作 Agent 的修正指引」，要進 retry_feedback；
    // 但不進 [QA 未通過] log——那份是下一輪 QA 的未解清單，混入指引會被當成待驗項
    const feedback = (detail.list.length && detail.summary) ? `${issues}\n修正指引：${detail.summary}` : issues;
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[QA 未通過]\n${issues}`]
    );
    const nextCount = (task.qa_retry_count || 0) + 1;
    if (nextCount >= QA_LIMIT) {
      await query(
        "UPDATE tasks SET status='stopped', qa_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `QA 連續 ${QA_LIMIT} 次未通過，需人工介入。最後問題：${issues.slice(0, 300)}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      const { bumpReentryOrStop } = require('./reentry');
      if (await bumpReentryOrStop(taskId, userId)) return true; // 總循環達上限 → 已標 stopped
      await query(
        "UPDATE tasks SET status='coding_running', qa_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `[QA 未通過]\n${feedback}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    }
    return true;
  }

  // 無有效 RESULT-JSON
  await query(
    "UPDATE tasks SET status='stopped', blocker_content='QA Agent 未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1",
    [taskId]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  return true;
}

module.exports = { runQaAgent };
