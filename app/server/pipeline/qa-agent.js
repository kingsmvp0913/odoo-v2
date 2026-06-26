const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

async function runQaAgent(taskId, userId, signal) {
  const { rows: taskRows } = await query(
    'SELECT task_id, git_branch, project_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!taskRows.length) return;
  const task = taskRows[0];

  const { rows: userRows } = await query(
    'SELECT qa_cmd, odoo_settings FROM users WHERE id = $1',
    [userId]
  );
  if (!userRows.length) return;
  const { qa_cmd, odoo_settings } = userRows[0];

  if (!qa_cmd) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='qa_cmd 未設定，請在個人設定中配置測試指令', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  const repoPath = odoo_settings?.git_repo_path || process.cwd();
  const env = {
    ...process.env,
    TASK_ID: task.task_id,
    GIT_BRANCH: task.git_branch || '',
    REPO_PATH: repoPath
  };

  const proc = spawn(qa_cmd, [], { shell: true, cwd: repoPath, env });

  if (signal) {
    signal.addEventListener('abort', () => {
      proc.kill('SIGTERM');
    }, { once: true });
  }

  await new Promise((resolve) => {
    proc.stdout?.on('data', (data) => {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: data.toString() });
    });
    proc.stderr?.on('data', (data) => {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: data.toString() });
    });

    proc.on('error', async (err) => {
      console.error(`[QA-AGENT] spawn error task ${taskId}:`, err.message);
      try {
        await query(
          `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
          [taskId, `Spawn error: ${err.message}`]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
        notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: -1 });
      } catch (qErr) {
        console.error(`[QA-AGENT] error handler query failed:`, qErr.message);
      } finally {
        resolve();
      }
    });

    proc.on('close', async (code) => {
      try {
        if (code === 0) {
          const nextStatus = task.project_id ? 'merge_running' : 'deploy_pending';
          await query(`UPDATE tasks SET status=$2, updated_at=NOW() WHERE id=$1`, [taskId, nextStatus]);
          notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
        } else {
          await query(
            `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
            [taskId, `QA agent exited with code ${code ?? 'signal'}`]
          );
          notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
        }
        notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      } catch (err) {
        console.error(`[QA-AGENT] task ${taskId} close handler error:`, err.message);
      } finally {
        resolve();
      }
    });
  });
}

module.exports = { runQaAgent };
