const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { withProjectLock } = require('./project-lock');
const git = require('./git');
const { resolveConflict, verifyResolvedSyntax } = require('./merge-agent');

// 「在飛且已部署過 testing」的任務狀態：碼已在 testing、尚未 approve，重建時要重併回去。
// approved 任務碼已在 ai-dev（reset 到 ai-dev 自動含入）、其分支已砍，故不列入。
// push_ai_running＝已按核准、正在併入 ai-dev（撞衝突時可能停在 AI 解衝突上數分鐘）：approved_at
// 要併成功才寫、任務分支也還在，這段期間仍算在飛，漏掉它等於把測試區的碼默默抽掉一張任務的份量。
const INFLIGHT_DEPLOYED = ['deploy_testing', 'playwright_running', 'review_pending', 'push_ai_running'];

// 把該任務記錄的衝突解法寫回工作樹對應檔（清掉衝突標記）。有寫入回 true，無記錄回 false。
function applyRecordedResolution(repo, task, file) {
  if (!task.merge_resolutions) return false;
  let map;
  try { map = JSON.parse(task.merge_resolutions); } catch { return false; }
  const content = map && map[repo.label] && map[repo.label][file];
  if (content == null) return false;
  // 記錄的解法可能本身就壞（含衝突標記）——直接寫進 testing 會 commit 出帶 <<<<<<< 的檔，
  // deploy 才以 ParseError 收場並誤歸因為程式問題。有標記＝視同無記錄，落到 agent／人工，不靜默放行。
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(content)) return false;
  fs.writeFileSync(path.join(repo.local_path, file), content);
  return true;
}

// 刪任務後重建 testing 分支：每個主 clone reset 到 ai-dev、再把存活的在飛任務重併回去。
// 回傳警告字串（暫停待人工／fail-open 還原）或 null（乾淨完成）。包在 withProjectLock 內與 pipeline 序列化。
async function rebuildTesting(projectId, userId, signal) {
  return withProjectLock(projectId, () => doRebuild(projectId, userId, signal));
}

// 無鎖版：呼叫端「必須自己已持有 withProjectLock(projectId)」才可呼叫（withProjectLock 不可重入，
// 從已持鎖處再呼叫 rebuildTesting 會死鎖）。供「更新 repo」端點（triggerClone 已在鎖內）等場景使用。
async function doRebuild(projectId, userId, signal) {
  const { rows: repos } = await query(
    "SELECT local_path, label FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [projectId]
  );
  if (!repos.length) return null;

  const { rows: tasks } = await query(
    `SELECT id, git_branch, status, merge_resolutions FROM tasks
     WHERE project_id=$1 AND approved_at IS NULL AND is_hidden=false
       AND status = ANY($2::text[]) AND git_branch IS NOT NULL
     ORDER BY id`,
    [projectId, INFLIGHT_DEPLOYED]
  );

  for (const repo of repos) {
    // 備份現有 testing SHA，供非衝突類失敗時還原
    const backupSha = await git.revParse(repo.local_path, 'testing').catch(() => null);
    try {
      await git.resetTestingToAiBranch(repo.local_path);
    } catch (err) {
      if (backupSha) await git.resetTestingTo(repo.local_path, backupSha).catch(() => {});
      return `testing 重建失敗（${repo.label}）：${err.message}，已還原，未影響刪除`;
    }

    for (const task of tasks) {
      let mergeResult;
      try {
        mergeResult = await git.mergeInto(repo.local_path, 'testing', task.git_branch);
      } catch (err) {
        await git.abortMerge(repo.local_path).catch(() => {});
        if (backupSha) await git.resetTestingTo(repo.local_path, backupSha).catch(() => {});
        return `testing 重建併入失敗（${repo.label}/${task.git_branch}）：${err.message}，已還原`;
      }
      if (!mergeResult.hasConflicts) continue;

      // 逐檔：有記錄解法直接套用；否則交 agent 自動解；都不成則列為未解
      const failed = [];
      for (const file of mergeResult.conflictFiles) {
        if (applyRecordedResolution(repo, task, file)) continue;
        try {
          const ok = await resolveConflict(repo.local_path, file, signal, { taskId: task.id, userId, notify });
          if (!ok) failed.push(file);
        } catch { failed.push(file); }
      }

      // commit 前驗語法：比照 doMerge 的 resolveConflicts，記錄解法／agent 可能「無衝突標記卻語法壞」
      // （剝引號、縮排崩）——不驗就 commitAll 進 testing，deploy 才以 SyntaxError/ParseError 爆並誤歸因為程式問題。
      const resolvedFiles = mergeResult.conflictFiles.filter(f => !failed.includes(f));
      const badSyntax = await verifyResolvedSyntax(repo.local_path, resolvedFiles);
      for (const f of badSyntax) if (!failed.includes(f)) failed.push(f);

      if (failed.length === 0) {
        await git.commitAll(repo.local_path, `[rebuild] ${task.git_branch} → testing`);
        continue;
      }

      // 自動解不掉 → 該在飛任務置 merge_conflict、標記 rebuild 來源與原狀態，停下重建待人工
      await query(
        "UPDATE tasks SET status='merge_conflict', merge_conflict_data=$2, updated_at=NOW() WHERE id=$1",
        [task.id, JSON.stringify({ rebuild: true, prior_status: task.status, repos: [{ repo: repo.label, files: failed }] })]
      );
      notify.emitToUser(userId, 'task:updated', { taskId: task.id, status: 'merge_conflict' });
      return `刪任務觸發 testing 重建：任務 #${task.id} 需人工解衝突（${repo.label}: ${failed.join(', ')}），解完將自動續跑`;
    }
  }
  return null;
}

module.exports = { rebuildTesting, rebuildTestingWithinLock: doRebuild, INFLIGHT_DEPLOYED };
