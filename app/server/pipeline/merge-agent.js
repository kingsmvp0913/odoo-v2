const fs = require('fs');
const path = require('path');
const { callClaude } = require('./claude-runner');
const { syncWithMain, commitAll } = require('./git');
const { query } = require('../db');
const notify = require('../notify');

async function getProjectRepo(projectId) {
  const { rows } = await query(
    `SELECT pr.local_path FROM project_repos pr
     WHERE pr.project_id = $1 AND pr.is_primary = true`,
    [projectId]
  );
  return rows[0] || null;
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

  const { text: resolved } = await callClaude(
    `以下是有 Git 合併衝突的檔案：${filePath}\n` +
    `請解決所有衝突，只輸出最終正確的檔案內容，不要包含 <<<<<<<、=======、>>>>>>> 等衝突標記，也不要有任何說明文字，直接輸出檔案內容：\n\n${content}`,
    signal, opts
  );
  if (!resolved || resolved.includes('<<<<<<<')) return false;
  fs.writeFileSync(fullPath, resolved);
  return true;
}

async function runMergeAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return;

  const repo = await getProjectRepo(task.project_id);
  if (!repo?.local_path) {
    await query("UPDATE tasks SET status='deploy_ready', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_ready' });
    return;
  }

  notify.emitToUser(userId, 'terminal:output', { taskId, data: '[MERGE] 正在同步主線...\n' });

  let syncResult;
  try {
    syncResult = await syncWithMain(repo.local_path);
  } catch (err) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_type='tech',
       blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `同步主線失敗: ${err.message}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  if (!syncResult.hasConflicts) {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: '[MERGE] 同步成功，無衝突\n' });
    await query("UPDATE tasks SET status='deploy_ready', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_ready' });
    return;
  }

  notify.emitToUser(userId, 'terminal:output', {
    taskId,
    data: `[MERGE] 發現 ${syncResult.conflictFiles.length} 個衝突檔案，嘗試自動解決...\n`
  });

  const failedFiles = [];
  for (const file of syncResult.conflictFiles) {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] 處理: ${file}\n` });
    try {
      const ok = await resolveConflict(repo.local_path, file, signal, { taskId, userId, notify });
      if (!ok) failedFiles.push(file);
    } catch {
      failedFiles.push(file);
    }
  }

  if (failedFiles.length === 0) {
    try {
      await commitAll(repo.local_path, '[merge] resolve conflicts with main');
      notify.emitToUser(userId, 'terminal:output', { taskId, data: '[MERGE] 衝突已自動解決\n' });
      await query("UPDATE tasks SET status='deploy_ready', updated_at=NOW() WHERE id=$1", [taskId]);
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_ready' });
    } catch (err) {
      await query(
        `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, `提交解決衝突失敗: ${err.message}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    }
  } else {
    notify.emitToUser(userId, 'terminal:output', {
      taskId,
      data: `[MERGE] 以下檔案需人工解決：${failedFiles.join(', ')}\n`
    });
    await query(
      `UPDATE tasks SET status='merge_conflict', merge_conflict_data=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, JSON.stringify({ conflictFiles: failedFiles })]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'merge_conflict' });
  }
}

module.exports = { runMergeAgent };
