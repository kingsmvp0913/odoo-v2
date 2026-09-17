/**
 * push-ai.js — push_ai_running：人工審核通過後，把任務分支併入 ai-dev 並推遠端。
 *
 * 這段原本寫在 approve 路由裡同步執行，於是「撞衝突」只有兩種下場：push 階段的競態進得了裁決
 * 閘門，本機併分支撞到的衝突（前一張任務已核准進 ai-dev、兩張改同一行）則直接回 500——任務留在
 * review_pending、主 clone 留著半殘 merge，畫面上只有一行紅字（task 132）。
 *
 * 改成 pipeline 一關的理由是解衝突要呼叫 AI（逐 hunk，實測數分鐘），不能塞在 HTTP 請求裡等。
 * 因此本關的流程與 merge 關對稱：撞衝突 → merge agent 自動解 → 解得掉就了結 merge 續推，
 * 解不掉才轉 merge_conflict 交人工裁決（push_ai 變體，解完自動回到本關續推）。
 */
const { query } = require('../db');
const notify = require('../notify');
const { tryProjectLock } = require('./project-lock');
const { buildGitEnv } = require('../lib/git-identity');

// 併 ai-dev 的兩側標籤：ours＝ai-dev 現況（含前面已核准的任務），theirs＝本任務。
// 沿用 merge 關的預設標籤會把 ai-dev 講成「testing 現況」，裁決卡片的說明與按鈕就對不上。
const PUSH_AI_LABELS = { oursLabel: 'ai-dev（已核准的成果）', theirsLabel: '本任務（新版）' };

async function runPushAi(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, user_id, approved_by FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;
  // 專案鎖被 merge/deploy 佔著就本輪不做（本關含 AI 解衝突，排隊等會綁死派工額度）：
  // 狀態留 push_ai_running，下一 tick 冪等重試。
  const r = await tryProjectLock(task.project_id, () => doPushAi(task, taskId, userId, signal));
  if (!r.locked) {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: '[PUSH-AI] 專案忙碌中，稍後重試併入 ai-dev\n' });
  }
}

async function doPushAi(task, taskId, userId, signal) {
  const { rows: repos } = await query(
    "SELECT local_path, label FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [task.project_id]
  );
  if (!repos.length) return stop(taskId, userId, '專案未設定任何已完成 clone 的 Repo');

  // push 歸屬到按下審核通過的人（approved_by）；舊任務沒有這欄則退回發起人。
  let gitEnv;
  try {
    gitEnv = await buildGitEnv(task.approved_by || task.user_id);
  } catch (err) {
    return stop(taskId, userId, `取不到 Git 憑證（請到設定填個人 GitHub PAT）：${err.message}`);
  }

  const path = require('path');
  const { mergeToAiBranch, concludeAiMerge, deleteBranchLocal, removeWorktree, refExists, symlinkChanges, AI_BRANCH } = require('./git');
  const { resolveConflicts } = require('./merge-agent');
  const conflictByRepo = [];

  for (const repo of repos) {
    // repo 清單是「此刻」查的，任務開跑後才加進專案的 repo 也在裡面，但它沒有 worktree 也沒有任務
    // 分支——硬 merge 一條不存在的分支只會拿到 "not something we can merge"，且不帶 conflictFiles
    // → 直接 stop，整張任務卡死在最後一關。沒有任務分支＝這個 repo 沒參與這張任務，跳過即可
    // （它要真的參與，得等下一張任務的 analysis 幫它建 worktree）。留聲不靜默。
    if (!await refExists(repo.local_path, `refs/heads/${task.git_branch}`)) {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: `[PUSH-AI] ${repo.label}：本張任務未在此 repo 產生變更，跳過\n` });
      continue;
    }
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[PUSH-AI] ${repo.label}：併入 ai-dev...\n` });
    let conflictFiles;
    try {
      // 09-17 R13：併入 ai-dev 前先擋符號連結（同一把尺，見 merge-agent.js）。不帶 conflictFiles
      // 就會落到下面「真失敗」分支，直接 stop 任務，不會被誤導進裁決閘門。
      // D2：任務分支的物件可能還在任務物件庫（容器寫的），先驗證搬進共用庫
      await require('../lib/agent-objects').importTaskObjects({ repoPath: repo.local_path, branch: task.git_branch });
      const symlinks = await symlinkChanges(repo.local_path, AI_BRANCH, task.git_branch);
      if (symlinks.length) throw new Error(`任務分支含符號連結（不允許）：${symlinks.join(', ')}`);
      await mergeToAiBranch(repo.local_path, task.git_branch, gitEnv);
      continue;
    } catch (err) {
      // 帶 conflictFiles ＝可解可裁決（本機併分支或 push 撞遠端皆然）；其餘（權限／網路／分支不見）
      // 是真失敗，不能丟進裁決閘門變成一張沒有內容的空卡片。
      if (!Array.isArray(err.conflictFiles) || !err.conflictFiles.length) {
        return stop(taskId, userId, `${repo.label} 併入 ai-dev 失敗: ${err.message}`);
      }
      conflictFiles = err.conflictFiles;
    }

    const r = await resolveConflicts(
      repo.local_path, conflictFiles,
      { taskId, userId, label: repo.label, ...PUSH_AI_LABELS },
      signal
    );
    if (r.aborted) return; // 手動暫停：狀態原地不動，等使用者恢復

    if (r.failed.length) {
      conflictByRepo.push({ repo: repo.label, files: r.failed, details: r.details });
      continue;
    }
    try {
      await concludeAiMerge(repo.local_path, conflictFiles, `[merge] ${task.git_branch} → ai-dev (resolve conflicts)`, gitEnv);
      notify.emitToUser(userId, 'terminal:output', { taskId, data: `[PUSH-AI] ${repo.label}：衝突已自動解決\n` });
    } catch (err) {
      // 了結／續推階段又撞遠端競態（另一實例剛推進）→ 交人工，MERGE_HEAD 留原地
      if (Array.isArray(err.conflictFiles) && err.conflictFiles.length) {
        conflictByRepo.push({ repo: repo.label, files: err.conflictFiles, details: {} });
        continue;
      }
      return stop(taskId, userId, `${repo.label} 完成併入 ai-dev 失敗: ${err.message}`);
    }
  }

  if (conflictByRepo.length) {
    const summary = conflictByRepo.map(c => `${c.repo}: ${c.files.join(', ')}`).join('；');
    await query(
      "UPDATE tasks SET status='merge_conflict', merge_conflict_data=$2, updated_at=NOW() WHERE id=$1",
      [taskId, JSON.stringify({ push_ai: true, prior_status: 'push_ai_running', repos: conflictByRepo })]
    );
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'system', $2)",
      [taskId, `[合併衝突] 併入 ai-dev 時有檔案 AI 解不掉，需選擇保留哪一版 — ${summary}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_conflict' });
    return;
  }

  // 併完才清理：worktree 與任務分支消失後就回不去了，衝突未決時不能動（best-effort，不阻斷）
  const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);
  for (const repo of repos) {
    await removeWorktree(repo.local_path, path.join(wtParent, path.basename(repo.local_path))).catch(() => {});
    await deleteBranchLocal(repo.local_path, task.git_branch).catch(() => {});
  }
  await require('../lib/agent-objects').removeTaskObjectDir({ repoPath: repos[0].local_path, branch: task.git_branch }).catch(() => {});

  await deployToTestEnv(task, taskId, userId);

  await query(
    "UPDATE tasks SET status='wiki_updating', approved_at=NOW(), merge_conflict_data=NULL, updated_at=NOW() WHERE id=$1",
    [taskId]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'wiki_updating' });
}

// 自動部署到客戶測試區。刻意放在所有 repo 都成功併入 ai-dev 之後：
// 碼進了 ai-dev 是既成事實，部署失敗不回頭改 git 狀態，也不讓整張任務失敗——
// 那會讓使用者以為程式根本沒併進去。
//
// 已在 tryProjectLock 之內，runDeploy 自己不取鎖，不會 deadlock。
// 每一種「沒做」都印一行：靜默跳過最難查，使用者會以為部署了，其實沒有。
async function deployToTestEnv(task, taskId, userId) {
  const say = (msg) => notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] ${msg}\n` });
  // 每一行都同時進任務對話：socket 訊息不落 DB，重整就沒了——實測 task 262 的自動部署
  // 死在 git fetch，畫面與資料庫都查不到任何痕跡，看起來就像「核准完什麼都沒發生」。
  const lines = [];
  const both = (msg) => { say(msg); lines.push(msg); };
  try {
    const { isAutoDeployEnabled } = require('../lib/auto-deploy-switch');
    // 這一種刻意不進對話：沒開自動部署是多數專案的常態，每張任務都寫一行只是噪音。
    // 上正式那條相反（開關關著也寫），因為那是使用者主動按下去、等著看客戶機有沒有更新。
    if (!await isAutoDeployEnabled(task.project_id)) return say('此專案未啟用自動部署，略過');

    const { rows: targets } = await query(
      "SELECT * FROM project_deploy_targets WHERE project_id = $1 AND env = 'test' AND enabled = true ORDER BY id",
      [task.project_id]
    );
    // 開關開著卻沒有目標＝設定不全，這個要讓人看到
    if (!targets.length) { both('略過：此專案沒有啟用中的測試區部署目標。'); return await flush(); }

    const { runDeployGroup } = require('../lib/deploy-run');
    const { groupTargets } = require('../lib/deploy-cmd');
    const { describeResults } = require('../lib/deploy-text');
    // 掛在同一個容器／服務上的多個資料庫合成一輪，客戶只被斷一次線
    for (const ids of groupTargets(targets)) {
      // userId 維持 null（這是系統觸發，不歸屬到人）；但 fetch 私有 repo 要憑證，
      // 用與 push 同一個人的 PAT。
      const results = await runDeployGroup(ids, {
        trigger: 'auto_test', taskId: task.id, userId: null,
        gitUserId: task.approved_by || task.user_id,
      });
      for (const line of describeResults(results, targets, '客戶測試區')) both(line);
    }
  } catch (e) {
    // 部署出事不可以讓任務卡住。留聲，不靜默。
    both(`自動部署發生例外：${e.message}`);
  }
  await flush();

  // 一次部署在對話裡就是一則，不是散成五則，所以收尾才寫。
  // 寫對話本身失敗不可以反過來卡住任務——碼已經在 ai-dev 上了。
  async function flush() {
    if (!lines.length) return;
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[客戶測試區部署]\n${lines.join('\n')}`]
    ).catch(() => {});
  }
}

async function stop(taskId, userId, reason) {
  await query(
    "UPDATE tasks SET status='stopped', blocker_type='tech', blocker_content=$2, updated_at=NOW() WHERE id=$1",
    [taskId, reason]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

module.exports = { runPushAi, PUSH_AI_LABELS };
