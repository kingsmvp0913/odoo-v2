const fs = require('fs');
const path = require('path');
const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { stripFence } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { mergeInto, commitAll, abortMerge } = require('./git');
const { query } = require('../db');
const notify = require('../notify');

const { withProjectLock } = require('./project-lock');

async function getProjectRepos(projectId) {
  const { rows } = await query(
    `SELECT local_path, label FROM project_repos
     WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL
     ORDER BY is_primary DESC, id`,
    [projectId]
  );
  return rows;
}

async function resolveConflict(repoPath, filePath, signal, opts = {}) {
  const fullPath = path.join(repoPath, filePath);
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return false;
  }
  if (!content.includes('<<<<<<<')) return true;

  const agent = loadAgent('merge');
  let resolveResult;
  try {
    resolveResult = await runClaude(
      agent.render({ file_path: filePath, content }),
      { ...opts, signal, model: agent.model, agentType: 'merge' }
    );
  } catch (err) {
    if (opts.taskId) {
      const { rows: [t] } = await query('SELECT task_id, user_id, project_id FROM tasks WHERE id=$1', [opts.taskId]);
      if (t) await logFailedUsage({ taskId: t.task_id, projectId: t.project_id }, t.user_id, 'merge', err);
    }
    throw err;
  }
  // model 對「直接輸出檔案內容」加 ``` fence 是高頻行為，不剝掉會把 fence 寫進檔案並 commit 進 testing
  const resolved = stripFence(resolveResult.text);
  if (resolveResult.usage && opts.taskId) {
    const { rows: [t] } = await query('SELECT task_id, user_id, project_id FROM tasks WHERE id=$1', [opts.taskId]);
    if (t) await logTokenUsage({ taskId: t.task_id, projectId: t.project_id }, t.user_id, 'merge', resolveResult.usage, resolveResult.durationMs);
  }
  if (!resolved || resolved.includes('<<<<<<<')) return false;
  fs.writeFileSync(fullPath, resolved + '\n');
  return true;
}

async function runMergeAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return;
  // 同專案序列化：一次只放行一個 task 併入 testing
  return withProjectLock(task.project_id, () => doMerge(task, taskId, userId, signal));
}

// 把 task 分支逐 repo 併入 testing（在各主 clone，主 clone 常駐 testing）。
// 有未解衝突 → merge_conflict（記錄哪個 repo 的哪些檔）；否則 → deploy_testing。
async function doMerge(task, taskId, userId, signal) {
  const repos = await getProjectRepos(task.project_id);
  if (!repos.length) {
    await query("UPDATE tasks SET status='deploy_testing', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_testing' });
    return;
  }

  const branch = task.git_branch;
  const conflictByRepo = [];

  for (const repo of repos) {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] ${repo.label}：併入 testing...\n` });

    let mergeResult;
    try {
      mergeResult = await mergeInto(repo.local_path, 'testing', branch);
    } catch (err) {
      // 半套 merge（MERGE_HEAD）留在主 clone 會污染同專案後續任務，先清掉再停
      await abortMerge(repo.local_path).catch(() => {});
      await query(
        `UPDATE tasks SET status='stopped', blocker_type='tech',
         blocker_content=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, `${repo.label} 併入 testing 失敗: ${err.message}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return;
    }

    if (!mergeResult.hasConflicts) {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] ${repo.label}：無衝突\n` });
      continue;
    }

    // 嘗試自動解衝突（逐檔）
    const failed = [];
    for (const file of mergeResult.conflictFiles) {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] ${repo.label} 處理: ${file}\n` });
      try {
        const ok = await resolveConflict(repo.local_path, file, signal, { taskId, userId, notify });
        if (!ok) failed.push(file);
      } catch {
        failed.push(file);
      }
    }

    if (failed.length === 0) {
      try {
        await commitAll(repo.local_path, `[merge] ${branch} → testing (resolve conflicts)`);
        notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] ${repo.label}：衝突已自動解決\n` });
      } catch (err) {
        await abortMerge(repo.local_path).catch(() => {});
        await query(
          `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
          [taskId, `${repo.label} 提交解決衝突失敗: ${err.message}`]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
        return;
      }
    } else {
      conflictByRepo.push({ repo: repo.label, files: failed });
    }
  }

  if (conflictByRepo.length) {
    const summary = conflictByRepo.map(c => `${c.repo}: ${c.files.join(', ')}`).join('；');
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] 需人工解決：${summary}\n` });
    await query(
      `UPDATE tasks SET status='merge_conflict', merge_conflict_data=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, JSON.stringify({ repos: conflictByRepo })]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_conflict' });
    return;
  }

  await query("UPDATE tasks SET status='deploy_testing', updated_at=NOW() WHERE id=$1", [taskId]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_testing' });
}

module.exports = { runMergeAgent, resolveConflict };
