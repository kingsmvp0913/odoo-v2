const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent, promptVersion } = require('./agent-loader');
const { getProjectInfo, worktreeParent, buildRepoPaths } = require('./task-agent');
const { coreSourceGuidance } = require('../lib/odoo-core-src');
const { runClaude, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { classifyFailure } = require('./failure-classifier');
const { parseQaIssues, recordQaRejection } = require('./qa-rejection');
const { getProjectNotes } = require('./project-notes');
const { MACHINE_LOGS, machineLogHeader, stripMachineHeader } = require('../../public/js/machine-logs.js');
const yaml = require('js-yaml');

const QA_LIMIT = 5;
// 規格歧義 clarify 迴圈的上限。使用者的裁決由 runner.handleClarifyAnswered 追加進 analysis_yaml
// 的 spec_decisions，故「已裁決輪數」＝該清單長度——計數與裁決落地是同一件事，不另開計數器。
// 到頂仍判規格不明＝這條迴圈收斂不了，再問只是無限來回燒 token，停下交人工。
const QA_SPEC_LIMIT = 2;

function specDecisionCount(analysisYaml) {
  let spec;
  try { spec = yaml.load(analysisYaml || '', { schema: yaml.CORE_SCHEMA }); } catch { return 0; }
  return Array.isArray(spec?.spec_decisions) ? spec.spec_decisions.length : 0;
}
// 每個 QA session 世代最多 resume 幾次（比照 coding 的 RESUME_LIMIT）：重驗走 --resume
// 續用上輪對話（已含規格、規則、上輪 diff 探索），只送短增量 prompt 省 token
const QA_RESUME_LIMIT = 2;

// 最近一筆 QA 未解清單，但**只看最近一次「QA 通過」之後的**。任務 pass 之後可能從 deploy／E2E
// 失敗回流再進 QA，那時先前的清單早已作廢（pass 分支會寫下分界標記）——不設下界的話會撈到好幾輪前
// 就修掉的舊清單，QA 對著不存在的問題重驗，而僵局熔斷貼給使用者的也是那份陳年清單，與真因對不上。
const LATEST_QA_FINDINGS_SQL = `
  SELECT content FROM task_logs
   WHERE task_id=$1 AND role='ai' AND content LIKE '${MACHINE_LOGS.qa_fail.prefix}%'
     AND id > COALESCE((SELECT MAX(id) FROM task_logs
                         WHERE task_id=$1 AND role='ai' AND content LIKE '[QA 通過]%'), 0)
   ORDER BY id DESC LIMIT 1`;

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
    const { rows: [prev] } = await query(LATEST_QA_FINDINGS_SQL, [taskId]);
    const findings = prev ? stripMachineHeader('qa_fail', prev.content) : '（見上輪 QA 清單）';
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='code', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      // 放行的措辭要寫死給使用者看：QA 這一關不再讀使用者的修正指示（那是流程層的話，放行與否
      // 由分診的 advance 決定），所以「我覺得 QA 判錯了」必須講成分診聽得懂的推進指令才有用。
      // 不寫明的話使用者只會寫「這個沒問題，繼續」，分診多半判 resume＝回 QA 重跑，原地打轉。
      [taskId, `QA 與開發僵局：自上輪 QA 後任務分支未有新 commit（coding 認為程式已正確、未修改），但 QA 仍判未通過。需你裁決 QA 指出的問題是否成立——\n・成立 → 在修正指示裡補充「該怎麼修」。\n・不成立、要放行 → 請明確寫「跳過 QA，直接推進到合併」（只寫「沒問題」「繼續」會被判成回 QA 重跑，原地打轉）。\n\nQA 未解清單：\n${findings.slice(0, 500)}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 產出本輪 QA 原始輸出（resume 或 fresh）：抽成內部函式，好在 transient 失敗時整段重跑一次（比照 deploy-testing）
  const attempt = async () => {
    // diff 基底＝任務切點 ai-dev（非實體 main）。任務分支從 ai-dev 切，而 ai-dev 含 main 全部歷史，
    // 故 `git diff main...task/X` 的 merge-base 落在 main 的 tip → 會把其他已核准、尚未回流 main 的
    // 任務變更算成本任務的 diff，審查對象整個錯掉（第 N 張任務會看到前 N-1 張的全部程式碼）。
    const { AI_BRANCH } = require('./git');
    const baseBranch = AI_BRANCH;
    // 撈最近一筆 QA 未解清單餵給本輪：QA 逐項重驗（修好的掉、沒修的留、新的加），讓迴圈收斂而非每輪重新發散。
    // 新語意下每筆 [QA 未通過] 本身即「當下完整未解清單」，取最新一筆＝最完整，不必串接歷史。
    const { rows: [prev] } = await query(LATEST_QA_FINDINGS_SQL, [taskId]);
    // session 還在、卻撈不到未解清單＝上一輪判了 pass（pass 會寫下分界標記讓這個查詢落空），任務是從
    // deploy／E2E／merge 失敗回流才又進 QA 的。這條路上要驗的是「載入錯誤的修正」，不是推翻自己的舊
    // 結論，而 session 裡的規格與 repo 探索並不因 pass 失效——照樣 resume，只是 prompt 要換一套說法。
    const afterPass = !!task.qa_session_id && !prev;
    const priorFindings = prev ? stripMachineHeader('qa_fail', prev.content)
      : afterPass ? '（上輪審查已通過、清單就此作廢；本輪對最新 diff 重新檢查）'
      : '（首輪，無上輪清單）';
    // 刻意不帶「使用者修正指示」進 QA：那是流程層的話（「已修正」「直接推進」），而放行與否是
    // triage 的 advance 分支在管，QA 沒有做這個決策的資訊（看不到彈跳次數與失敗歷史）。舊版 prompt
    // 還寫著「例如使用者明確要求忽略某項」，等於明文教它把流程指令當放行依據。規格層級的決定不走
    // 這條路——那本來就會經 respec／analysis 進 analysis_yaml，維持單一規格來源。
    // QA 在任務 worktree 父目錄操作（可跨 repo 子目錄讀 diff），只讀不改
    const cwd = worktreeParent(info.root, task.task_id);

    // 重驗走 --resume：上輪 session 已含規格＋審查規則＋repo 探索，本輪只送「重取 diff＋逐項重驗」
    // 的短增量 prompt（比照 coding 的省 token 設計）。首輪／無上輪清單／resume 額度用完 → fresh。
    // 刻意不要求「有上輪未解清單」：pass 後回流時它必為空（見 afterPass），拿它當條件等於把回流那條
    // 路上的 resume 整個擋掉——實測那是每次 8~10 分鐘、$3 的全量重讀，對照 resume 的 19 秒、$0.27。
    const canResume = !!task.qa_session_id && (task.qa_resume_count || 0) < QA_RESUME_LIMIT && task.qa_prompt_ver === qaVer;
    let callResult = null;
    let usedResume = false;
    if (canResume) {
      const retryAgent = loadAgent('qa-retry');
      const prompt = retryAgent.render({
        main_branch: baseBranch,
        git_branch: task.git_branch || '（未設定）',
        repo_paths: buildRepoPaths(info, task.task_id),
        odoo_core_src: coreSourceGuidance(info.odoo_version),
        prior_findings: priorFindings,
        // 放寬 resume 後唯一真正的準確率風險：同一段對話裡它剛說過 pass，要它推翻自己比讓白紙判斷難。
        // 明講「那次判定可能有誤」來對沖，比清掉整個 session 便宜得多。非回流輪必須留空——每輪都印
        // 等於在 fail 重驗輪謊稱上輪判過。
        return_note: afterPass
          ? '⚠ 上一輪你判定通過，但這個任務在下游關卡（部署／合併／E2E）失敗被退回，實作 Agent 已再次修改。\n'
            + '請把那次「通過」當成可能有誤：不要因為自己上輪說過通過就傾向再次通過，本輪重新獨立判斷。\n'
          : ''
      }).trim();
      try {
        callResult = await runClaude(prompt, { cwd, taskId, userId, signal, resumeSessionId: task.qa_session_id, model: retryAgent.model, agentType: 'qa' });
        usedResume = true;
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
        main_branch: baseBranch,
        git_branch: task.git_branch || '（未設定）',
        repo_paths: buildRepoPaths(info, task.task_id),
        odoo_core_src: coreSourceGuidance(info.odoo_version),
        analysis_yaml: task.analysis_yaml || '（無規格）',
        prior_findings: priorFindings,
        project_notes: projectNotes || ''
      }).trim();
      callResult = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, agentType: 'qa' });
      await query('UPDATE tasks SET qa_session_id=$2, qa_resume_count=0, qa_prompt_ver=$3 WHERE id=$1', [taskId, callResult.sessionId || null, qaVer]).catch(() => {});
    }
    // resumed 一起記帳：fresh 與 resume 的耗時／成本差一個量級，事後要判斷「放寬 resume 之後 QA 準不準」
    // 就得先分得出哪一輪是哪種——不記的話只能靠比對 task_events 的 session id 反推。
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'qa', callResult.usage, callResult.durationMs, 'completed', usedResume);
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
  // pass 分支會清掉它（見下方）——這欄位只在 QA↔coding 迴圈內有意義。
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
    // 同時清掉 qa_reviewed_commit：任務就此離開 QA↔coding 迴圈，該欄位的語意（上輪 QA 判 fail 時
    // 審的是哪個 commit）已失效。不清的話，往後 deploy／E2E 失敗把任務踢回 coding、而 coding 判定
    // 「程式沒錯、錯在別關」不提交任何 commit 時，HEAD 仍等於這次 pass 的 sha，上方熔斷會把它誤判成
    // 「QA 僵局」——貼出的還是好幾輪前早已修掉的舊 QA 清單，人工看到的失敗原因與真因完全對不上，
    // 且兩個裁決選項（補修法／跳過 QA）都解不了真正卡住的那一關。
    // 整組計數器一起清，不只 qa_reviewed_commit：pass ＝這一輪 QA↔coding 迴圈結束，retry／resume
    // 次數都只在那個迴圈內有意義。留著的話，任務日後從 deploy／E2E 回流再進 QA 時，是帶著上一輪的
    // 次數起跳的——本來還有額度卻直接觸頂 stopped。
    // 但 qa_session_id 刻意留著：它承載的是規格與 repo 探索，不因這輪判 pass 而失效。清掉的話，回流
    // 重驗必然 fresh 全量重讀（實測 8~10 分鐘、$3，對照 resume 的 19 秒、$0.27），而回流輪要驗的是
    // 「下游失敗的修正」不是推翻舊結論。自我一致偏誤改用 qa-retry 的 return_note 明講來對沖。
    // session 若因久放被 CLI 清掉，resume 會失敗並自動降級 fresh（見上方 session 遺失分支），不必預先清。
    await query(
      `UPDATE tasks SET status='merge_running', qa_reviewed_commit=NULL,
                       qa_retry_count=0, qa_resume_count=0, updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    // 分界標記：下一輪 QA 取「未解清單」時只看這條線之後的紀錄。沒有它的話，回流重驗會撈到好幾輪
    // 前早就修掉的舊清單當成待驗項，QA 對著已經不存在的問題重驗，永遠收斂不了。
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', '[QA 通過] 本輪審查通過，先前的未解清單就此作廢')",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_running' });
    return true;
  }

  if (verdict === 'fail') {
    // 規格歧義分流（規格 §3.1/§3.2）：spec_questions 非空 → 批次問使用者，同輪 code 問題暫存待答完一次補。
    const specQs = Array.isArray(result?.spec_questions)
      ? result.spec_questions.map(s => String(s).trim()).filter(Boolean) : [];
    if (specQs.length) {
      // 迴圈斷路器：已裁決 QA_SPEC_LIMIT 輪還在問規格 → 停下交人工，不再進閘門
      if (specDecisionCount(task.analysis_yaml) >= QA_SPEC_LIMIT) {
        await query(
          "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
          [taskId, `QA 已就規格歧義請你裁決 ${QA_SPEC_LIMIT} 次，本輪仍判規格不明確——再問下去只是無限來回，請人工確認規格內容。\n\n本輪仍未確定：\n${specQs.join('\n')}`]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
        return true;
      }
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
    const nextCount = (task.qa_retry_count || 0) + 1;
    // 這則 log 的標頭列同時是使用者在時間軸上看到的那句人話，所以要等去向定了才寫：三種去向裡有
    // 兩種其實是「任務停下等人」，一律寫「已自動退回開發修正」在那兩種情況下是錯的——而那正是
    // 使用者最需要正確資訊的時刻。去向只放在標頭列的全形括號內，本體一字不動，下一輪 QA 撈回去
    // 由 stripMachineHeader 連同去向一起剝掉，不會混進未解清單被當成待驗項。
    let outcome = '已自動退回開發修正';
    if (nextCount >= QA_LIMIT) {
      outcome = '已連續未通過達上限，任務停下等你處理';
      await query(
        "UPDATE tasks SET status='stopped', qa_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `QA 連續 ${QA_LIMIT} 次未通過，需人工介入。最後問題：${issues.slice(0, 300)}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      const { bumpReentryOrStop } = require('./reentry');
      // retry_feedback／qa_retry_count 必須在斷路器之前落地：觸頂時 bumpReentryOrStop 會直接標
      // stopped，等到下面才寫的話，本輪 QA 找到的問題就留不下來——retry_feedback 會還是 NULL，
      // 事後人工把任務推回 coding 時開發拿不到任何退回原因，只會空手重跑並被同樣的問題再退。
      await query(
        'UPDATE tasks SET qa_retry_count=$2, retry_feedback=$3 WHERE id=$1',
        [taskId, nextCount, `${machineLogHeader('qa_fail')}\n${feedback}`]
      );
      // 帶 diag：觸頂停下時把本輪真正的問題寫進 blocker_content（reentry.js 早就支援，先前沒帶）
      if (await bumpReentryOrStop(taskId, userId, { blockerContent: `本輪 QA 未通過：\n${issues.slice(0, 500)}` })) {
        outcome = '循環次數已達上限，任務停下等你處理';
      } else {
        await query(
          "UPDATE tasks SET status='coding_running', updated_at=NOW() WHERE id=$1",
          [taskId]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
      }
    }
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `${machineLogHeader('qa_fail', outcome)}\n${issues}`]
    );
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
