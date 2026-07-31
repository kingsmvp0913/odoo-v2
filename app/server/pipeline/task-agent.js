const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { AI_BRANCH, ensureAiBranch, syncMainIntoAi, ensureWorktreeAtMain, commitResolved, abortMerge } = require('./git');
const { resolveConflicts, SYNC_LABELS } = require('./merge-agent');
const { tryProjectLock } = require('./project-lock');
const { buildGitEnv } = require('../lib/git-identity');
const { runClaude, abortError, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { assembleTaskContext } = require('./sync');
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
    `SELECT p.name, p.odoo_version, pr.local_path, pr.label
     FROM projects p
     JOIN project_repos pr ON pr.project_id = p.id
     WHERE p.id = $1 AND pr.clone_status = 'done' AND pr.local_path IS NOT NULL
     ORDER BY pr.is_primary DESC, pr.id`,
    [projectId]
  );
  if (!rows.length) return null;
  const repos = rows.map(r => ({ label: r.label, local_path: r.local_path, subdir: path.basename(r.local_path) }));
  return {
    name: rows[0].name,
    odoo_version: rows[0].odoo_version,
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
      odoo_version: info.odoo_version,
      work_dir: workDir || info.root,
      repo_list: repoList,
      repo_paths: buildRepoPaths(info, task.task_id),
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

function buildCodingPrompt(task, info, resolution, retryFeedback, baseBranch, projectNotes) {
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
      analysis_yaml: task.analysis_yaml || '（無規格）',
      commit_message: buildCommitMessage(task),
      repo_list: repoList,
      resolution: resolution || '（無）',
      retry_feedback: retryFeedback || '（無）',
      project_notes: projectNotes || ''
    }).trim(),
    model: agent.model
  };
}

async function runTaskAnalysis(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, cs_findings FROM tasks WHERE id = $1',
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
        await ensureWorktreeAtMain(repo.local_path, path.join(wtParent, repo.subdir), `task/${task.task_id}`, AI_BRANCH, true);
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
  try {
    const built = buildAnalysisPrompt(task, info, clarification, wtParent, baseBranch, projectNotes);
    // analysis 讀任務自己的 worktree（cwd=wtParent，內容＝乾淨 main），不持鎖 → 與別任務 merge/deploy 平行。
    // worktree 不在此移除：留給 coding 沿用，approve 併 main 後才清。
    const analysisResult = await runClaude(built.prompt, { cwd: wtParent, taskId, userId, signal, model: built.model, agentType: 'analysis' });
    raw = analysisResult.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', analysisResult.usage, analysisResult.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
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
  await query(`UPDATE tasks SET status=$2, updated_at=NOW() WHERE id=$1`, [taskId, nextStatus]);
  // 規格已成功寫出＝這批留言真的被吸收了，此時才銷帳（理由見上方 absorbUpTo）
  if (absorbUpTo) {
    await query(
      "UPDATE task_messages SET applied_at=NOW() WHERE task_id=$1 AND source='manual' AND applied_at IS NULL AND id <= $2",
      [taskId, absorbUpTo]
    );
  }
  await logAnalysisGate(taskId, result, nextStatus);
  notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  return true;
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
  const built = buildCodingPrompt(task, info, resolution, task.retry_feedback || '', baseBranch, projectNotes);
  return runClaude(built.prompt, { cwd, taskId: task.id, userId, signal, model: built.model, agentType: 'coding', timeoutMs: CODING_TIMEOUT_MS, env: { ...gitEnv } });
}

async function runTaskCoding(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, source, analysis_yaml, git_branch, project_id, retry_feedback FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

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

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal, ref, userId });
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

module.exports = { runTaskAnalysis, runTaskCoding, getProjectInfo, worktreeParent, buildRepoPaths, latestResolution };
