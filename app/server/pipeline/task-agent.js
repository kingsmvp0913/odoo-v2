const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent, promptVersion } = require('./agent-loader');
const { AI_BRANCH, ensureAiBranch, syncMainIntoAi, ensureWorktreeAtMain, commitResolved, abortMerge, revParse } = require('./git');
const { ensureWorktreeSkills } = require('./worktree-skills');
const { resolveConflicts, SYNC_LABELS } = require('./merge-agent');
const { tryProjectLock } = require('./project-lock');
const { buildGitEnv } = require('../lib/git-identity');
const { coreSourceGuidance } = require('../lib/odoo-core-src');
const { resolveEnterprisePath } = require('../lib/enterprise-sources');
const { runClaude, abortError, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { assembleTaskContext, taskAttachmentNote } = require('./sync');
const yaml = require('js-yaml');
const { determineNextStatus, REQUIRED_FIELDS, logAnalysisGate } = require('./analysis');
const { getProjectNotes } = require('./project-notes');
const { loadConversation } = require('./clarify-chat');

function buildCommitMessage(task) {
  const title = (task.title || '').trim() || task.task_id;
  if (task.source === 'service') {
    // Title stored as "IDX-2026060098: 修正發票計算問題" → "修正發票計算問題 (IDX-2026060098)"
    const colonIdx = title.indexOf(': ');
    if (colonIdx > 0) {
      const idx = title.slice(0, colonIdx);
      const subject = title.slice(colonIdx + 2);
      return `${subject} (${idx})`;
    }
    return title;
  }
  return title;
}

// 回傳專案根目錄與所有已 clone 完成的 repo 清單（不再只取 primary 單一路徑）。
// root = repos/<專案>/（所有 repo 主 clone 的父目錄）；供 analysis 讀全 repo、coding 衍生 worktree 父目錄。
async function getProjectInfo(projectId) {
  const { rows } = await query(
    `SELECT p.name, p.folder_name, p.odoo_version, p.edition, pr.local_path, pr.label
     FROM projects p
     JOIN project_repos pr ON pr.project_id = p.id
     WHERE p.id = $1 AND pr.clone_status = 'done' AND pr.local_path IS NOT NULL
     ORDER BY pr.is_primary DESC, pr.id`,
    [projectId]
  );
  if (!rows.length) return null;
  const repos = rows.map(r => ({ label: r.label, local_path: r.local_path, subdir: path.basename(r.local_path) }));
  // 企業版專案才解企業版 addons 目錄，交給 coreSourceGuidance 寫進 prompt。
  // 解不到（管理員還沒設定／目錄不見了）就當沒有：這裡只影響「agent 查不查得到企業版原始碼」，
  // 不該讓組 prompt 失敗——真正必須 fail loud 的是建測試區那條路徑（env-agent 的 enterpriseError）。
  let enterpriseSrc = null;
  if (rows[0].edition === 'enterprise') {
    const ent = await resolveEnterprisePath(rows[0].odoo_version).catch(() => null);
    if (ent && ent.ok) enterpriseSrc = ent.path;
  }
  return {
    name: rows[0].name,
    // folder_name 供 /ai/wiki 的 project 參數用（端點是 folder_name=$1 OR name=$1）。
    // 專案名可能是中文（鴻久／北群醫／慈雲寶塔），未編碼的中文放進 URL 會被 Node 的 HTTP
    // parser 直接判 400——連 Express 都到不了，agent 只會看到「查不到 wiki」。
    folder_name: rows[0].folder_name,
    odoo_version: rows[0].odoo_version,
    edition: rows[0].edition,
    enterprise_src: enterpriseSrc,
    root: path.dirname(repos[0].local_path),
    repos
  };
}

// 任務 worktree 父目錄：<專案根>/.worktrees/<task_id>/（coding agent 的 cwd）
function worktreeParent(root, taskId) {
  return path.join(root, '.worktrees', taskId);
}

// 本任務各 repo 的 worktree 絕對路徑清單：供 source-routing 注入，讓 agent 直接 `git -C <路徑>`／限定探索範圍，
// 不用 pwd/ls 探路、不用猜子目錄名（歷程實測 97 次探路、59 次猜 repo 名）。
function buildRepoPaths(info, taskId) {
  const wt = worktreeParent(info.root, taskId);
  return (info.repos || []).map(r => `- ${path.join(wt, r.subdir)}`).join('\n') || '（無 repo）';
}

function buildAnalysisPrompt(task, info, clarification, workDir, baseBranch, projectNotes) {
  const agent = loadAgent('analysis-project');
  const repoList = (info.repos || []).map(r => `- ${r.subdir}/`).join('\n') || '（無 repo）';
  return {
    prompt: agent.render({
      project_name: info.name,
      // /ai/* 端點的 project 參數：端點是 folder_name=$1 OR name=$1，但中文專案名進網址要編碼，
      // 所以一律給編過的 folder_name（比照 cs-agent）。placeholder 有值才不會渲染成空字串——
      // 那會讓 agent 拿到 `project=` 的空網址，查無結果卻不會報錯。
      project_slug: encodeURIComponent(info.folder_name || info.name),
      odoo_version: info.odoo_version,
      work_dir: workDir || info.root,
      repo_list: repoList,
      repo_paths: buildRepoPaths(info, task.task_id),
      odoo_core_src: coreSourceGuidance(info.odoo_version, info.enterprise_src),
      main_branch: baseBranch || 'main',
      git_branch: task.git_branch || `task/${task.task_id}`,
      original_text: task.original_text || '（無內容）',
      task_id: task.task_id,
      clarification: clarification || '（無）',
      cs_findings: task.cs_findings ? task.cs_findings.trim() : '（無）',
      project_notes: projectNotes || ''
    }).trim(),
    model: agent.model
  };
}

// 取最近一筆「修正指示」（失敗處理時使用者輸入）；供 resume 後的階段帶入 prompt，讓指示真的生效。
// 帶上送出時間：這段話沒有失效機制，會被往後每一輪 coding 讀到，而它可能是「繼續」「已修正」
// 這種只對當時那次卡關有意義的流程指令。agent 沒有時間就無從判斷它是否還適用，只能從字面猜。
async function latestResolution(taskId) {
  const { rows } = await query(
    "SELECT content, created_at FROM task_logs WHERE task_id = $1 AND role = 'user' AND content LIKE '[修正指示]%' ORDER BY created_at DESC LIMIT 1",
    [taskId]
  );
  if (!rows.length) return '';
  const text = rows[0].content.replace(/^\[修正指示\]\s*/, '').trim();
  if (!text) return '';
  const at = rows[0].created_at ? new Date(rows[0].created_at).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }) : '（時間不明）';
  return `（送出時間：${at}）\n${text}`;
}

function buildCodingPrompt(task, info, resolution, retryFeedback, baseBranch, projectNotes, attachments) {
  const agent = loadAgent('coding-project');
  const repoList = (info.repos || []).map(r => `- ${r.subdir}/`).join('\n') || '（無 repo）';
  return {
    prompt: agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      work_dir: worktreeParent(info.root, task.task_id),
      git_branch: task.git_branch || '（未設定）',
      main_branch: baseBranch || 'main',
      repo_paths: buildRepoPaths(info, task.task_id),
      odoo_core_src: coreSourceGuidance(info.odoo_version, info.enterprise_src),
      analysis_yaml: task.analysis_yaml || '（無規格）',
      commit_message: buildCommitMessage(task),
      repo_list: repoList,
      resolution: resolution || '（無）',
      retry_feedback: retryFeedback || '（無）',
      // 審核者退回時夾帶的截圖：規格與退回意見都只是圖的說明文字，真正要改什麼畫在圖上
      attachments: attachments || '',
      project_notes: projectNotes || ''
    }).trim(),
    model: agent.model
  };
}

// 分析 session 每個世代最多續接幾次（比照 QA_RESUME_LIMIT）：同一條 session 續太多輪，規格會在裡面
// 累積漂移而沒有任何一輪回頭核對過原始程式碼；撞頂就強制 fresh 重讀一次。
const ANALYSIS_RESUME_LIMIT = 2;
// 指紋綁 fresh＋retry 兩支 agent：resume 輪生效的規則同時來自 session 內的 fresh prompt 與本輪的
// retry prompt，只綁一個會讓另一個改了不重來（比照 with-resume.js:11-12，那裡點名 qa-agent 的既有缺口）。
function analysisPromptVersion() {
  return `${promptVersion('analysis-project')}.${promptVersion('analysis-retry')}`;
}

async function runTaskAnalysis(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, cs_findings, analysis_yaml, analysis_session_id, analysis_prompt_ver, analysis_resume_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;
  task.original_text = await assembleTaskContext(taskId);
  // assembleTaskContext 不看 applied_at、會把所有留言讀進 original_text，所以「analysis 跑完並寫出
  // 規格」才是留言真正被吸收的時點。記下當下這批的最大 id，成功後才銷帳（比照 respec-agent 的
  // id <= maxId 寫法，patch 期間新進的留言留給下一個檢查點）。
  // 分診的 respec 分支原本在跳關前就先銷帳，但 analysis 這輪可能失敗、被中止或使用者中途插手，
  // 第二輪分診改判 fix／advance 時留言已被標成已吸收＝需求永久消失，而且證據被自己刪掉。
  const { rows: [pendMax] } = await query(
    "SELECT MAX(id) AS max_id FROM task_messages WHERE task_id=$1 AND source='manual' AND applied_at IS NULL",
    [taskId]
  );
  const absorbUpTo = pendMax?.max_id || null;

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='專案未設定任何已完成 clone 的 Repo，請至專案設定新增 Repo', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 每人自己的 GitHub PAT：analysis pull 前先解出該任務發起人的 git 注入 env；
  // 未設 PAT → 停任務等使用者去設定填 PAT，不得拿 pipeline 共用身分硬幹。
  let gitEnv;
  try {
    gitEnv = await buildGitEnv(userId);
  } catch (e) {
    if (e.code === 'NO_GIT_CRED') {
      await query(
        `UPDATE tasks SET status='stopped', blocker_type='git_cred', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, '請先到設定填個人 GitHub PAT，任務才能存取 GitHub。']
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return true;
    }
    throw e;
  }

  // 任務 worktree（一個任務一個，analysis 建、coding 沿用、approve 併 ai-dev 後才刪）：
  // 持鎖確保 ai-dev 存在 → 把實體 main 的新 commit 帶進來 → 在 ai-dev 上長出 task 分支 worktree
  // （reset=true，此階段尚無程式變更）。切點是 ai-dev 而非 main：後面的任務才看得到前面已核准
  // 但尚未進 main 的成果，不會反覆撞同一個檔。
  const wtParent = worktreeParent(info.root, task.task_id);
  let setupErr = null;
  let syncConflict = null;
  let syncAborted = false;
  let syncBlockedBy = null;
  // 取不到鎖就早退（不排隊）：本段的 resolveConflicts 每個 hunk 一次 runClaude，可持鎖數分鐘，
  // 排隊者會白佔一個派工槽。sync 本身冪等，下一 tick 再試零成本。
  const { locked } = await tryProjectLock(task.project_id, async () => {
    // 主 clone 殘留 in-progress merge（MERGE_HEAD）防護（比照 merge-agent.js doMerge 同名守衛）：
    // - 同專案另有任務停在 merge_conflict＝人工正在該 clone 上解衝突（裁決端點的 concludeMerge 才會了結），
    //   此時進場同步必撞牆被誤標 stopped → 本輪不動作，留在 analysis_running 等下一 tick 再試。
    // - 否則屬殘留（前一輪 abort／崩潰未清）→ abortMerge 自癒後繼續。
    for (const repo of info.repos) {
      if (!fs.existsSync(path.join(repo.local_path, '.git', 'MERGE_HEAD'))) continue;
      const { rows: [pending] } = await query(
        "SELECT id FROM tasks WHERE project_id=$1 AND status='merge_conflict' AND id<>$2 LIMIT 1",
        [task.project_id, taskId]
      );
      if (pending) {
        notify.emitToUser(userId, 'terminal:output', { taskId, data: `[SYNC] ${repo.label}：另一任務衝突待人工解決中，本輪暫緩同步\n` });
        syncBlockedBy = pending.id;
        return;
      }
      await abortMerge(repo.local_path).catch(() => {});
    }

    let repo; // 記本輪同步到哪個 repo，供 catch 清半套 merge 用（無 const 遮蔽，供下方 catch 讀取）
    try {
      for (repo of info.repos) {
        await ensureAiBranch(repo.local_path, gitEnv);
        const sync = await syncMainIntoAi(repo.local_path, gitEnv);
        if (sync.hasConflicts) {
          // 工程師直接改 main 的碼與 AI 改過的地方撞到了。複用 merge 那套三層：
          // 自動解 → 語法驗證 → 解不掉才停下來跳裁決卡片給人。
          // 兩側標籤要傳 SYNC_LABELS：這裡 ours＝ai-dev（AI 的碼）、theirs＝main（工程師的碼），
          // 與併 testing 的預設語意相反，不換會讓 merge-explain 的說明與建議整個反過來。
          const r = await resolveConflicts(repo.local_path, sync.conflictFiles, { taskId, userId, label: repo.label, ...SYNC_LABELS }, signal);
          if (r.aborted) {
            // 手動暫停：resolveConflicts 中斷在半套 merge，主 clone 卡 MERGE_HEAD，先清掉再原地不動，
            // 否則解除暫停後重跑會在 syncMainIntoAi 的 checkout main 撞牆、被誤標 stopped。
            await abortMerge(repo.local_path).catch(() => {});
            syncAborted = true;
            return;
          }
          if (r.failed.length) { syncConflict = { repo: repo.label, files: r.failed, details: r.details }; return; } // 留 MERGE_HEAD 給裁決端點的 concludeMerge 收尾，不可 abortMerge
          await commitResolved(repo.local_path, sync.conflictFiles, `[sync] main → ${AI_BRANCH} (resolve conflicts)`);
        }
        await ensureWorktreeAtMain(repo.local_path, path.join(wtParent, repo.subdir), `task/${task.task_id}`, AI_BRANCH, true, gitEnv);
      }
    } catch (e) {
      // 半套 merge（MERGE_HEAD）留在主 clone 會污染同專案後續任務，先清掉再停（比照 merge-agent.js:360-361）
      // repo 為 undefined（info.repos 為空）時 `repo.local_path` 是同步 TypeError，.catch 攔不到，
      // 例外會逃出鎖的 callback 繞過下面整套錯誤處理（setupErr → stopped）→ 先判有值才清。
      if (repo) await abortMerge(repo.local_path).catch(() => {});
      setupErr = e;
    }
  });
  if (!locked) return true; // 同專案另有工作持鎖：本輪完全不動作，下一 tick 再試（sync 冪等）
  if (syncBlockedBy) {
    // 原地不動（狀態不改），但卡住原因要落地：socket 事件是瞬時的，沒開著終端面板就永遠看不到，
    // 任務在列表上只是「分析中」卻可能掛好幾天。寫進 blocker_content 讓它重整後仍看得見。
    await query(
      "UPDATE tasks SET blocker_type='sync_wait', blocker_content=$2 WHERE id=$1",
      [taskId, `等待任務 #${syncBlockedBy} 的同步衝突處理完成（同一 Repo 一次只能有一組衝突在解）`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
    return true; // 本輪不動作：留在 analysis_running，等下一 tick 再試
  }
  // 擋住的原因已不成立 → 清掉等待訊息（只清自己寫的那種，別動真正的 blocker）
  await query("UPDATE tasks SET blocker_type=NULL, blocker_content=NULL WHERE id=$1 AND blocker_type='sync_wait'", [taskId]);
  if (syncAborted) return true; // 手動暫停：非失敗，狀態原地不動，解除暫停後從這一關重跑
  if (syncConflict) {
    // prior_status 記 analysis_running：裁決完回到這一關重跑。此時 sync 的 merge 已 commit，
    // 重跑 syncMainIntoAi 會得到 Already up to date，冪等。
    await query(
      "UPDATE tasks SET status='merge_conflict', merge_conflict_data=$2, updated_at=NOW() WHERE id=$1",
      [taskId, JSON.stringify({ sync: true, prior_status: 'analysis_running', repos: [syncConflict] })]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_conflict' });
    return true;
  }
  if (setupErr) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `分析前同步 ${AI_BRANCH} 失敗（請確認 origin 可連線且本地無未提交變更）：${setupErr.message}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 回帶先前澄清問答，供 confirm_answered 重跑時參考。
  // 必須含 role='ai'：只帶 user 會讓 agent 看不到自己上一輪問過什麼，於是換個角度把同一件事重問一次
  // （正式站 task 5 連問三輪都在問「項次要不要自動重編」）。比照 spec-review 的對話組裝。
  const clarification = await loadConversation(taskId);

  // base 分支＝任務切點 ai-dev：供 source-routing 給出正確 diff 基底。
  // 用 main 會讓 agent 把其他已核准任務的變更誤認為自己的 diff。
  const baseBranch = AI_BRANCH;
  const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
  let raw;
  let analysisSessionId = null;
  let resumed = false;
  const anaVer = analysisPromptVersion();
  // 重跑（退回改規格／澄清答覆／衝突裁決後回來）走 --resume：上輪 session 已含這包 code 的探索結果
  // 與 Odoo 規則，本輪只送「新資訊＋現行規格」的短 prompt。省的不是 prompt 長度，是「把整包 code
  // 再讀一遍」那段工具迴圈——spec_tour resume 同一個 session 的實測是十分鐘裡省掉前七分鐘。
  // 首輪（無 session）／prompt 改版／額度用完 → 一律 fresh。
  const canResume = !!task.analysis_session_id
    && (task.analysis_resume_count || 0) < ANALYSIS_RESUME_LIMIT
    && task.analysis_prompt_ver === anaVer;
  try {
    let analysisResult = null;
    if (canResume) {
      // 上一輪讀過碼卻沒留下規格＝它是被執行時限砍斷的（成功輪必定連同 analysis_yaml 一起落地），
      // 此時要的是「收斂」不是「增量改」：analysis-retry 的 body 通篇假設上一輪產出過規格
      // （「沒被新資訊動到的部分維持原樣」），餵給逾時輪會拿到「新資訊(無)＋既有規格(無)」的空洞指令。
      // 註：舊規格已存在、之後某輪才逾時的情形仍走 analysis-retry——它的「不要重新探索整包 code」
      // 已涵蓋主要痛點，只少了「矛盾要停下來問」那段強調，不值得為此另立旗標欄位。
      const timedOutMidway = !task.analysis_yaml;
      const retryAgent = loadAgent(timedOutMidway ? 'analysis-timeout-resume' : 'analysis-retry');
      // 只送增量：規格全文仍要帶，因為 analysis_yaml 可能已被規格關卡（respec-patch／spec-review）
      // 在**別的 session** 改過，session 記憶裡的版本會是舊的。
      const retryPrompt = retryAgent.render({
        clarification: clarification || '（無）',
        analysis_yaml: task.analysis_yaml || '（無既有規格）',
        // 附件清單每輪重算：fresh 輪之後才補上的截圖（人工退回夾帶的最多）只存在於 DB，
        // session 記憶裡沒有。不重帶，這一輪就會像 task 150 那樣回報「沒有【任務附件】區塊」而失敗。
        attachments: await taskAttachmentNote(taskId)
      }).trim();
      try {
        analysisResult = await runClaude(retryPrompt, {
          cwd: wtParent, taskId, userId, signal,
          resumeSessionId: task.analysis_session_id, model: retryAgent.model, agentType: 'analysis'
        });
        resumed = true;
        await query('UPDATE tasks SET analysis_resume_count = COALESCE(analysis_resume_count,0) + 1 WHERE id=$1', [taskId]).catch(() => {});
      } catch (err) {
        if (err.aborted) throw err;  // 手動暫停：交下方既有 catch 原樣處理，session 留著解除後續用
        // session 遺失／CLI 壞掉：清掉 stale session 並歸零計數，下次進來自然 fresh 重讀。
        // 逾時是例外——那條 session 是活的（只是這一輪沒做完），清掉等於逼下一輪從零重讀整包 code、
        // 再逾時一次。留著交下方 catch 依 err.sessionId 續存並累加計數。
        if (!(err.claudeStatus === 'timeout' && err.sessionId)) {
          await query('UPDATE tasks SET analysis_session_id=NULL, analysis_resume_count=0 WHERE id=$1', [taskId]).catch(() => {});
        }
        // 逾時不在同輪重跑：同一份輸入再跑一次極可能再逾時，只是讓使用者多等一輪（比照 qa-agent.js:120）
        if (err.claudeStatus === 'timeout') throw err;
        // 其餘：記帳後這輪改跑 fresh，使用者仍拿得到規格
        await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', err);
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
          [taskId, `[分析] 續接上一輪分析失敗（${String(err.message).slice(0, 120)}），改以完整規格重跑`]
        ).catch(() => {});
        analysisResult = null;
      }
    }
    if (!analysisResult) {
      ensureWorktreeSkills(wtParent);   // Odoo 參考知識按需載入（見 worktree-skills.js）
      const built = buildAnalysisPrompt(task, info, clarification, wtParent, baseBranch, projectNotes);
      // analysis 讀任務自己的 worktree（cwd=wtParent，內容＝乾淨 main），不持鎖 → 與別任務 merge/deploy 平行。
      // worktree 不在此移除：留給 coding 沿用，approve 併 main 後才清。
      analysisResult = await runClaude(built.prompt, { cwd: wtParent, taskId, userId, signal, model: built.model, agentType: 'analysis' });
    }
    raw = analysisResult.text;
    // 記本輪 session：規格 tour 靠它 --resume 續寫（脈絡已在，不必重讀 code 也不必重述規格）。
    // 落地在下方與 status 同一次 UPDATE——writeSpecTour 已搬到 runner 的 doBranch，那裡讀不到這個區域變數。
    // resume 輪回不出 sessionId 時退回舊值（CLI 偶爾不吐；此時對話仍延續在同一條 session 上），
    // 否則會把還活著的 session 清成 NULL、下一輪白白重讀整包 code。fresh 輪維持直接指派，理由見下方 UPDATE。
    analysisSessionId = analysisResult.sessionId || (resumed ? task.analysis_session_id : null);
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', analysisResult.usage, analysisResult.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    // 逾時／崩潰的那一輪已經把整包 code 讀進 session（runClaude 失敗時一併帶出 sessionId）。存下來，
    // 下次進來就能 --resume 接著收斂，不必從零重讀——task 180 的分析關正是讀到一半被 600s 砍掉、
    // 600 秒探索全數作廢，重跑必然再逾時一次。語意與下方成功路徑一致：它記的是「最後一個**讀過本任務
    // 程式碼**的 session」，逾時輪完全符合。
    // 計數在此累加（成功輪的 +1 在 resume 分支內）：逾時輪不累加的話，人每按一次「繼續」就無條件再
    // resume 一輪、永遠撞不到 ANALYSIS_RESUME_LIMIT，同一個卡點可無限重演（健檢 U2 的教訓）。
    if (err.sessionId) {
      await query(
        `UPDATE tasks SET analysis_session_id=$2, analysis_prompt_ver=$3,
         analysis_resume_count = COALESCE(analysis_resume_count,0) + 1 WHERE id=$1`,
        [taskId, err.sessionId, anaVer]
      ).catch(() => {});
    }
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, stopReason('分析 Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 契約（analysis-project.md）：<result> 內「裸 YAML」。
  // 舊契約要 agent 把整份 YAML 做 JSON 逃逸再包 JSON——多欄位含引號時逃逸極易出錯；
  // 改裸 YAML，下一狀態由 server 端 determineNextStatus 推導（與 analysis.js 單一真相）。
  const result = await parseAgentResult(raw, {
    parse: s => yaml.load(s, { schema: yaml.CORE_SCHEMA }), signal,
    ref: { taskId: task.task_id, projectId: task.project_id }, userId
  });

  if (result && typeof result === 'object' && result.stopped_reason) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, String(result.stopped_reason)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  if (!result || typeof result !== 'object') {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='分析 Agent 未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 必要欄位缺漏不得放行：殘缺 SD 進 coding 會拿垃圾規格燒 token（Rule 12 fail-loud）
  const missing = REQUIRED_FIELDS.filter(f => result[f] == null || result[f] === '');
  if (missing.length > 0) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `分析結果缺少必要欄位：${missing.join(', ')}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const nextStatus = determineNextStatus(result); // branch_pending | confirm_pending | spec_review
  // 規格經由 writeAnalysisYaml 落地（主防線：一併清 spec_session_id／spec_prompt_ver，理由見該函式
  // 定義處——這裡是真正「規格重產」發生的地方，reject-triage.js 的 goto 只是備援）。
  // status／updated_at 不屬於它的語意範圍，另開一次 UPDATE 補上。
  const { writeAnalysisYaml } = require('./runner');
  await writeAnalysisYaml(taskId, result);
  // analysis_session_id 只由這裡寫入——它的語意是「最後一個**讀過本任務程式碼**的 session」，
  // 而規格關卡（respec／spec-review）刻意不重讀整包 code（見 respec-patch.md 的 description），
  // 讓它們也寫進來的話，凡是經過澄清或規格問答的任務，欄位裡就會換成一個沒有 code 記憶的 session，
  // writeSpecTour resume 到它等於白 resume（仍得重讀模組，實測那是 spec_tour 十分鐘裡的前七分鐘）。
  // fresh 輪直接指派而非 COALESCE：那代表規格已換一份、也換了一條沒有舊包袱的 session，
  // 殘留的舊 session 比沒有更糟（resume 輪的取值另有處置，見上方 analysisSessionId 賦值處）。
  // 一併記 prompt 版本指紋供下輪 resume 前比對；fresh＝新世代，resume 計數歸零重新起算。
  const sessionSets = ['status=$2', 'analysis_session_id=$3', 'analysis_prompt_ver=$4', 'updated_at=NOW()'];
  if (!resumed) sessionSets.push('analysis_resume_count=0');
  await query(
    `UPDATE tasks SET ${sessionSets.join(', ')} WHERE id=$1`,
    [taskId, nextStatus, analysisSessionId, anaVer]
  );
  // 規格已成功寫出＝這批留言真的被吸收了，此時才銷帳（理由見上方 absorbUpTo）
  if (absorbUpTo) {
    await query(
      "UPDATE task_messages SET applied_at=NOW() WHERE task_id=$1 AND source='manual' AND applied_at IS NULL AND id <= $2",
      [taskId, absorbUpTo]
    );
  }
  await logAnalysisGate(taskId, result, nextStatus);
  // 規格 tour 不在這裡寫：nextStatus 可能是 confirm_pending／spec_review，acceptance 還會變。
  // 一律等任務真正進入 branch_pending，由 runner 的 doBranch 統一呼叫 runSpecTourGate（單一寫入點）。
  notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  return true;
}

// writeSpecTour 的統一入口：所有「任務進入 branch_pending」的路徑都走這裡，確保只有一個寫入點
// （多個寫入點就會疊加出多份 tour，新舊一起被 --test-tags 跑到）。
// best-effort，但失敗要留聲——分析關那邊靜默吞掉的話，「規格 tour 沒產出」就沒有任何人看得到，
// 而下游的 playwright 關只能靠實測檔案存在與否去猜。
async function runSpecTourGate(taskId, userId, signal, branchName) {
  try {
    await writeSpecTour(taskId, userId, signal, branchName);
  } catch (e) {
    console.warn(`[writeSpecTour] task ${taskId} 產出規格 tour 失敗：${e.message}`);
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[規格 tour] 產出失敗，本任務將由 E2E 關自行產生 tour（先定稿的效果本次不生效）：${String(e.message).slice(0, 300)}`]
    ).catch(() => {});
  }
}

// 寫 tour 與 E2E 關產 tour 是同一件事，卻曾各拿一半時間：playwright 關明寫 1200s，本關漏帶
// timeoutMs 於是吃 runClaude 的 600s 預設，實測就是在寫檔前一刻被砍（task 106）。對齊上限，可用 env 調整。
const SPEC_TOUR_TIMEOUT_MS = parseInt(process.env.PIPELINE_SPEC_TOUR_TIMEOUT_MS || '1200000', 10);

// 依定稿規格寫 E2E tour，排在 coding **之前**——現行順序是 coding 完才產 tour，等於先寫答案再
// 出考題，測試會遷就實作；先定稿則是開發者要讓考題通過，且 coding 進 worktree 時就看得到驗收
// selector。專案層開關，預設關閉（行為與現況完全相同）。
//
// 呼叫時機是「任務真正進入 branch_pending」＝規格已定稿，**不是**分析關收尾。分析關算出的
// nextStatus 可能是 confirm_pending（agent 還有問題要問）或 spec_review（要人看過規格），這兩種
// 狀態下 acceptance 都還不是定稿：照著寫出來的 tour 會斷言「使用者答案推翻掉的行為」，而澄清
// 答完後分析會完整重跑再產一份，舊的那份又因為 ensureWorktreeAtMain 對已領先 base 的分支走 merge
// 不 reset 而留在模組裡，最後 --test-tags /<module> 把新舊兩份一起跑，舊的必失敗 → 退 coding，
// 而 coding 被禁止改測試檔 → 三輪後 stopped。
//
// --resume 分析 session（analysis_session_id）：本關要寫的是「這個模組的 tour」，而分析關剛剛才把
// 同一個 worktree 的碼讀過一遍。曾一度改成無狀態，理由是「規格閘門可能隔數小時才被核准，cache 早過期，
// resume 等於全價重播整段 analysis 對話」——但實測（task 106）打臉了這個取捨：fresh 版把十分鐘裡的
// 前七分鐘花在重讀 idx_hj 的模組結構，正是 analysis session 裡現成的東西，最後跑滿逾時零產出。
// 重播 input token 貴但快，重新探索是慢又貴。resume 失敗（session 已被 CLI 回收）時降級 fresh，
// 不讓 tour 因此整份消失。
//
// 整段 best-effort：tour 是加值產物，任何失敗都不該讓已經產出的規格或關卡推進跟著壞掉。失敗時
// 會留一筆 task_logs（見呼叫端），且 playwright 關會實測 tour 檔是否存在、查無就自行產生。
async function writeSpecTour(taskId, userId, signal, branchName) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, analysis_yaml, git_branch, analysis_session_id FROM tasks WHERE id=$1', [taskId]
  );
  if (!task) return;
  // 出考題與考試是同一個開關的兩半（原本是 spec_tour_enabled／e2e_disabled 兩個獨立旗標，
  // 四種組合裡有兩種是垃圾——「出考題但沒人考」實測讓鴻久每張任務固定燒滿一個逾時寫永遠不會
  // 執行的 tour）。合併之後那個狀態在資料上就無法表達，不再需要程式守衛去擋。
  const { rows: [proj] } = await query('SELECT e2e_disabled FROM projects WHERE id=$1', [task.project_id]);
  if (!proj || proj.e2e_disabled) return;
  if (!task.analysis_yaml) return;                      // 沒有規格就沒有 acceptance，無從出考題

  let moduleName = '';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; } catch { /* 解析失敗照樣往下，讓 agent 自己從規格找 */ }

  const info = await getProjectInfo(task.project_id);
  // 沒有已 clone 完成的 repo 就不能跑：agent 帶 --dangerously-skip-permissions，
  // fallback 到 process.cwd() 會把測試檔寫進平台自身的 repo。
  if (!info?.root) return;

  const agent = loadAgent('playwright-spec');
  const { E2E_LOGIN } = require('./e2e-account');
  const prompt = agent.render({
    analysis_yaml: task.analysis_yaml,
    module: String(moduleName).trim() || '（見規格 module 欄位）',
    test_url: '（測試環境，由系統於部署後執行；此處不需連線）',
    login: E2E_LOGIN,
    // source-routing 片段的四個佔位（比照 playwright 關）。少了 repo_paths 它只拿得到模組名、
    // 拿不到模組在哪，實測會 `find / -iname "<module>"` 掃整個檔案系統。
    // git_branch：本關跑在 runner 寫入 tasks.git_branch **之前**（runner.js doBranch），
    // DB 這時還是 NULL，故由呼叫端把已算好的 branchName 傳進來。
    repo_paths: buildRepoPaths(info, task.task_id),
    odoo_core_src: coreSourceGuidance(info.odoo_version, info.enterprise_src),
    main_branch: AI_BRANCH,
    git_branch: branchName || task.git_branch || '（未設定）'
  });
  const gitEnv = await buildGitEnv(userId).catch(() => ({}));
  const cwd = worktreeParent(info.root, task.task_id);
  ensureWorktreeSkills(cwd);

  // 自己的階段 marker：runner 只在派工時依 task.status 寫一次（runner.js:349），而本關的 status
  // 是 branch_pending＝「建立分支」，於是這一整段 AI 執行都被歸在那個標籤底下。實際成分是
  // 「幾秒的 git ＋ 幾百秒的 agent」，看歷程的人只會看到「建立分支跑了 8 分鐘」。
  // 這個混淆已經騙過兩次：pipeline 流程圖曾把它畫成獨立 status（見 pipeline-flow.test.js:15），
  // 2026-08-10 查 token 時也把 112 次工具呼叫誤算在建分支頭上。
  // 修法刻意不是改 STAGE_LABELS 的字面——那在停用 E2E 的專案反而變成另一種騙人。
  // 寫在所有 early return 之後：旗標關掉、無規格、無 repo 時根本不會走到這裡，自然不留痕。
  const marker = `\n\x1b[96m▶ 先寫 E2E 考題\x1b[0m\n`;
  notify.emitToUser(userId, 'terminal:output', { taskId, data: marker });
  await query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)', [taskId, marker]).catch(() => {});

  // agentType／stage 用獨立的 spec_tour，不可沿用 'playwright'：這一次發生在分析與 coding 之間，
  // 掛到 playwright 名下會讓「這關重跑幾次、花多少」全部算錯，而健檢正是拿那些數字判該不該檢討，
  // 也就無從量測「規格 tour 模式到底省不省」。
  // 失敗也要記帳：這關 best-effort（外層 runSpecTourGate 吞掉例外照樣推進），但不記的話最貴的
  // 情境完全隱形——實測 task_service_3907 這關跑滿 600s 逾時被砍、126 個工具呼叫，token_usage
  // 裡連一列都沒有，報表上等於沒發生過（比照 analysis／cs 的 logFailedUsage 慣例）。
  const runOpts = {
    cwd, taskId, userId, signal, model: agent.model, agentType: 'spec_tour',
    timeoutMs: SPEC_TOUR_TIMEOUT_MS, env: { ...gitEnv }
  };
  let res;
  try {
    res = await runClaude(prompt, { ...runOpts, resumeSessionId: task.analysis_session_id || undefined });
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'spec_tour', err);
    // resume 專屬的降級：session 被 CLI 回收／失效時，fresh 仍然寫得出 tour（只是要自己重讀模組）。
    // 排除 aborted（使用者暫停，狀態原地不動）與 timeout（同一份輸入再跑一次極可能再逾時，只是讓
    // 使用者多等一輪；比照 with-resume.js:39-44）。沒有 session 可接時不重跑——那就是純失敗。
    if (!task.analysis_session_id || err.aborted || err.claudeStatus === 'timeout') {
      throw err;   // 外層照舊寫「產出失敗」的 task_logs 並讓任務推進
    }
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[規格 tour] 續接分析對話失敗（${String(err.message).slice(0, 120)}），改以完整規格重跑`]
    ).catch(() => {});
    try {
      res = await runClaude(prompt, runOpts);
    } catch (err2) {
      await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'spec_tour', err2);
      throw err2;
    }
  }
  await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'spec_tour', res.usage, res.durationMs);
  // 只留一行摘要，不塞 agent 的整段輸出：task_logs 會被分診／respec 每輪讀進 prompt，
  // 那是每輪都要付的固定 token 稅，而 tour 的內容看 worktree 裡的檔案才準。
  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `[規格 tour] 已依 acceptance 於實作前產出 ${moduleName || '模組'} 的 E2E tour 測試`]
  );
}

// coding 是最長的階段（探索＋實作＋逐檔驗證＋commit），共用預設 600s 常不夠；
// 逾時＝整輪報廢重跑（比放寬上限更貴），故獨立放寬、可用 env 調整
const CODING_TIMEOUT_MS = parseInt(process.env.PIPELINE_CODING_TIMEOUT_MS || '1800000', 10);

// 跑一輪 coding：無狀態，一律用 coding-project 統一 prompt（不 --resume）。
// 省 token 靠 prompt cache（實測 coding 全價 input 僅佔 0.28%，重送規則/spec 幾乎免費），
// 不再靠 session 記憶——每輪都讀 worktree 既有碼做增量修正（見 coding-project.md），避免 session drift 與整包重寫。
// 一律用 coding agent 預設模型（不再依 retry_feedback 升級 opus）：升更貴的腦袋對 deploy/E2E
// 這類非邏輯失敗（環境/污染/暫時性）無助益，且燒錢；改由總循環上限（MAX_REENTRY）超過即 stopped 交人工。
// retry_feedback 仍保留、餵回 coding prompt 當失敗說明，只是不再拿它決定模型。
async function runCodingOnce(task, info, userId, signal, resolution, gitEnv) {
  const cwd = worktreeParent(info.root, task.task_id);
  // base 分支＝任務切點 ai-dev：供 source-routing 給出正確 diff 基底。
  // 用 main 會讓 agent 把其他已核准任務的變更誤認為自己的 diff。
  const baseBranch = AI_BRANCH;
  const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
  ensureWorktreeSkills(cwd);
  const built = buildCodingPrompt(task, info, resolution, task.retry_feedback || '', baseBranch, projectNotes, await taskAttachmentNote(task.id));
  return runClaude(built.prompt, { cwd, taskId: task.id, userId, signal, model: built.model, agentType: 'coding', timeoutMs: CODING_TIMEOUT_MS, env: { ...gitEnv } });
}

// 本任務各 repo worktree 的 HEAD 快照：比對 coding 前後即知這輪有沒有真的 commit 東西。
// 讀不到（worktree 尚未建立／unborn HEAD）該 repo 記 null，整段失敗則回空物件——兩者都代表
// 「無法確認」，由呼叫端當作沒有證據、不得據以阻擋（見下方 unchanged 的判定）。
// 本函式永不拋出：HEAD 快照只是防呆的輔助資訊，不該有能力弄掛整個 coding 關。
async function readHeads(info, taskId) {
  try {
    const wt = worktreeParent(info.root, taskId);
    const heads = {};
    for (const r of info.repos || []) {
      heads[r.subdir] = await revParse(path.join(wt, r.subdir), 'HEAD').catch(() => null);
    }
    return heads;
  } catch { return {}; }
}

// 「這張單繞了幾輪」的總計數上限。既有的 reentry／deploy_retry 都會被歸零——分診 advance 主動歸零
// deploy_retry（reject-triage.js:300）、goto 預設歸零 reentry、人工介入那輪刻意不吃額度——三條各自
// 都有道理，疊起來卻讓使用者每按一次「先修正」就把計數清空：實測 task 152 跑了 6 輪 coding、$19.4，
// 畫面上的計數器全是 0/1，沒有任何機制察覺它在鬼打牆。token_usage 是唯一不被任何歸零邏輯碰到的
// 記帳來源，拿它當「跨人工介入的總輪次」。
const MAX_CODING_RUNS = parseInt(process.env.PIPELINE_MAX_CODING_RUNS || '4', 10);

// 累計輪次熔斷：擋的目的不是攔住使用者（他本來就會再按繼續），是讓他在**知道累計數字**的前提下
// 決定要不要繼續——現在按「先修正」時畫面上看不到任何累計量。
// 逃生路徑靠 task_logs 裡自己留下的熔斷紀錄筆數推導額度（上限 = MAX × (已熔斷次數 + 1)）：不加欄位、
// 不需要任何恢復路徑主動清旗標，而且天生沒有死鎖——被擋一次就自動放行下一批 MAX 輪。
// 只加欄位不寫 task_logs 的話任務一往前走那個面板就消失（rules/pipeline.md 77），而這裡剛好兩者同源。
async function codingRunwayCheck(taskId, businessTaskId) {
  const { cost } = require('../lib/token-cost').costSql('');
  const { rows: [u] } = await query(
    `SELECT SUM(CASE WHEN agent_type='coding' THEN 1 ELSE 0 END) AS coding_runs,
            COUNT(*) AS total_calls,
            COALESCE(SUM(${cost}), 0) AS cost_usd,
            COALESCE(SUM(duration_ms), 0) AS ms
       FROM token_usage WHERE task_id = $1`,
    [businessTaskId]
  );
  const runs = Number(u?.coding_runs) || 0;
  const { rows: [b] } = await query(
    "SELECT COUNT(*) AS n FROM task_logs WHERE task_id = $1 AND content LIKE '[輪次熔斷]%'",
    [taskId]
  );
  const limit = MAX_CODING_RUNS * ((Number(b?.n) || 0) + 1);
  if (runs < limit) return null;
  return {
    runs,
    limit,
    calls: Number(u?.total_calls) || 0,
    usd: Math.round((Number(u?.cost_usd) || 0) * 100) / 100,
    minutes: Math.round((Number(u?.ms) || 0) / 60000)
  };
}

async function runTaskCoding(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, source, analysis_yaml, git_branch, project_id, retry_feedback FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const runaway = await codingRunwayCheck(taskId, task.task_id).catch(() => null);
  if (runaway) {
    const msg = `[輪次熔斷] 這張任務已累計跑了 ${runaway.runs} 輪實作、共 ${runaway.calls} 次 AI 呼叫，`
      + `約 $${runaway.usd}、機器時間 ${runaway.minutes} 分鐘，仍未收斂。`;
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, msg + '\n\n反覆退回同一個地方，多半代表規格本身還有沒講清楚的部分，'
        + '或這個做法在 Odoo 上有繞不過的限制——繼續前先看一下前幾輪的退回理由是不是同一件事。\n'
        + `若確認要繼續，照常填修正指示即可（下次會在累計 ${runaway.limit + MAX_CODING_RUNS} 輪時再提醒一次）。`]
    );
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, msg]).catch(() => {});
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='專案未設定任何已完成 clone 的 Repo，請至專案設定新增 Repo', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 每人自己的 GitHub PAT：coding 呼叫 claude 前先解出該任務發起人的 git 注入 env
  // （子行程內的 git commit/push 靠這組身分／PAT），未設 PAT → 停任務等使用者去設定填 PAT。
  let gitEnv;
  try {
    gitEnv = await buildGitEnv(userId);
  } catch (e) {
    if (e.code === 'NO_GIT_CRED') {
      await query(
        `UPDATE tasks SET status='stopped', blocker_type='git_cred', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, '請先到設定填個人 GitHub PAT，任務才能存取 GitHub。']
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return true;
    }
    throw e;
  }

  const ref = { taskId: task.task_id, projectId: task.project_id };
  const headsBefore = await readHeads(info, task.task_id);
  let raw;
  try {
    const resolution = await latestResolution(taskId);
    // 無狀態：一律 fresh 跑統一 prompt（不 resume；靠 prompt cache 省 input）。coding 每輪讀 worktree 既有碼做增量。
    const codingResult = await runCodingOnce(task, info, userId, signal, resolution, gitEnv);
    // 記本輪 session id 當「已開工」marker（供 respec 等判斷；不再用於 resume）
    await query('UPDATE tasks SET coding_session_id=$2 WHERE id=$1', [taskId, codingResult.sessionId]).catch(() => {});
    raw = codingResult.text;
    await logTokenUsage(ref, userId, 'coding', codingResult.usage, codingResult.durationMs);
  } catch (err) {
    await logFailedUsage(ref, userId, 'coding', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, stopReason('實作 Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // schemaHint 與 coding-project.md 的輸出契約同字面：raw 整段沒有 <result> 時（agent 收尾漏掉），
  // 補救 agent 不知道要產什麼鍵名就只能亂猜，等於白跑一次 haiku（實測 task 152）。
  let result = await parseAgentResult(raw, {
    parse: JSON.parse,
    schemaHint: '{"status":"qa_running","summary":"本輪實際做了什麼"} '
      + '或（做不下去時）{"status":"stopped","error":"停下的原因"}',
    signal, ref, userId
  });

  // 補救仍解析不出結果時，不能讓整輪報廢：commit 在不在是客觀事實，比 agent 的收尾自述可靠得多。
  // 有新 commit ⇒ 本輪確實做出東西，照樣進 QA——QA 本來就審 diff 對規格，格式抖動造成的誤放行由
  // 它擋；反過來把 18 分鐘／1M tokens 的成果丟掉、還要人工介入才推得動，代價大得多（實測 task 152：
  // 已 commit 6 個檔，只因最後吐的是中文摘要而非 <result> 就 stopped）。
  // 只兜「解析不出來」這一種：agent 明講 {"status":"stopped"} 是它的判斷，必須照辦，不得覆蓋。
  if (result == null) {
    const headsAfterParseFail = await readHeads(info, task.task_id);
    const repos = Object.keys(headsAfterParseFail);
    const advanced = repos.length > 0
      && repos.some(k => headsAfterParseFail[k] && headsAfterParseFail[k] !== headsBefore[k]);
    if (advanced) {
      result = { status: 'qa_running', summary: '' };
      // agent 的收尾自述常帶著 QA／使用者需要知道的取捨（task 152 就在這段講了「管理者會看到兩個
      // 同名選單」的已知副作用）。它沒進 <result>，只活在 task_events 的終端串流裡——這裡補一份到
      // task_logs，任務往前走之後仍看得到。截斷比照下方：task_logs 會被分診／respec 讀進 prompt。
      const tail = String(raw || '').trim().slice(-300);
      if (tail) {
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
          [taskId, `[實作] 收尾格式不符契約，已依實際 commit 推進。它最後的說明是：${tail}`]
        ).catch(() => {});
      }
    }
  }

  // 帶著失敗回饋進來、卻一個 commit 都沒產生 ⇒ 這輪什麼也沒改。放行進 QA 只會讓 QA 判「same diff、
  // 已審過」照樣 pass，再部署一次必然重現同一個失敗，白燒整條 pipeline 還多吃一次彈跳計數
  //（實測 task 109）。推進與否由結構決定，不靠 agent 自律。retry_feedback 刻意不消費：續跑時
  // 仍要讀得到原始失敗訊息，否則又回到「空輸入→空轉」的原點。
  // 只在有 retry_feedback 時才擋——分診判 resume 放回本關時本就可能無事可做，那沒有失敗在等著重現。
  if (result?.status === 'qa_running' && task.retry_feedback) {
    // 「無變更」必須是**確證**：每個 repo 都讀得到 HEAD 且前後相同。任一側讀不到（快照失敗／
    // worktree 不存在／unborn HEAD）就是無法確認，一律放行——空物件的 every() 恆為 true，
    // 若不擋這個空集合，快照一失敗就會把每一輪 coding 都誤判成沒改東西而卡死。
    const headsAfter = await readHeads(info, task.task_id);
    const repos = Object.keys(headsAfter);
    const unchanged = repos.length > 0
      && repos.every(k => headsAfter[k] && headsBefore[k] && headsAfter[k] === headsBefore[k]);
    if (unchanged) {
      // agent 對「為什麼沒改」通常有精準判斷（實測 task 114：「三項規格都已滿足，剩下是部署環境
      // 是否真的裝上 PyPDF2」＝該往環境層查），但它只活在 task_events 的終端串流裡。blocker 寫死
      // 固定字串等於把那段診斷蓋掉，每張任務長得一模一樣，使用者無從判斷下一步（他的原話是
      // 「為什麼原因寫得那麼模糊」）。擋不擋仍由結構決定（rules/pipeline.md 60），這裡只換訊息來源。
      const agentSay = String(result.summary || '').trim();
      await query(
        `UPDATE tasks SET status='stopped', blocker_type='code', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, agentSay
          ? `實作 Agent 本輪未產生任何程式變更，但上一關是失敗退回。它自述的原因是：\n${agentSay}\n\n` +
            '若這個判斷成立，請直接照它指的方向處理；否則補充具體的修正方向後再繼續。'
          : '實作 Agent 本輪未產生任何程式變更，但上一關是失敗退回——直接推進會重現同一個失敗。' +
            '請確認失敗原因是否已在別處處理，或補充具體的修正方向後再繼續。']
      );
      // 只寫 blocker_content 的話，任務一往前走那個面板就消失＝對使用者等同不存在（rules/pipeline.md 77）。
      // 截斷是因為 task_logs 會被分診／respec 每輪讀進 prompt，不能塞 agent 的整段輸出。
      if (agentSay) {
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
          [taskId, `[實作] 本輪未產生程式變更，判斷是：${agentSay.slice(0, 300)}`]
        ).catch(() => {});
      }
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return true;
    }
  }

  if (result?.status === 'qa_running') {
    // 走到「確定推進」才消費 retry_feedback；解析失敗轉 stopped 時保留，
    // 讓之後分診放回 coding 仍有上一輪失敗上下文可 resume（避免盲改，健檢止血 11）
    if (task.retry_feedback) await query('UPDATE tasks SET retry_feedback=NULL WHERE id=$1', [taskId]).catch(() => {});
    await query(`UPDATE tasks SET status='qa_running', updated_at=NOW() WHERE id=$1`, [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'qa_running' });
  } else {
    const errorMsg = result?.error || '實作 Agent 未回傳有效結果，請檢查 terminal 輸出';
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, errorMsg]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  }
  return true;
}

module.exports = { runTaskAnalysis, runTaskCoding, getProjectInfo, worktreeParent, buildRepoPaths, latestResolution, runSpecTourGate };
