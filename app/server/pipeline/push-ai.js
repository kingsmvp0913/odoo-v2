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
  const { mergeToAiBranch, concludeAiMerge, deleteBranchLocal, removeWorktree, refExists } = require('./git');
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

  await query(
    "UPDATE tasks SET status='wiki_updating', approved_at=NOW(), merge_conflict_data=NULL, updated_at=NOW() WHERE id=$1",
    [taskId]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'wiki_updating' });
}

async function stop(taskId, userId, reason) {
  await query(
    "UPDATE tasks SET status='stopped', blocker_type='tech', blocker_content=$2, updated_at=NOW() WHERE id=$1",
    [taskId, reason]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

module.exports = { runPushAi, PUSH_AI_LABELS };
