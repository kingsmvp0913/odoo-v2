/**
 * runner.js — Pipeline state machine
 *
 * Scans tasks in runnable statuses for a given user and advances them
 * through the pipeline states sequentially.
 *
 * Exports:
 *   runPipeline(userId)    → Promise<{ processed: number }>
 *   resetLoopCounter(userId) → Promise<void>
 */

const { query } = require('../db');
const { analyzeTask } = require('./analysis');
const { createBranch, checkoutDefault, runDeploy } = require('./git');
const notify = require('../notify');

const LOOP_LIMIT = 5;
const _inFlight = new Map(); // taskId (number) → AbortController
const RUNNABLE_STATUSES = ['analysis_running', 'branch_pending', 'coding_running', 'qa_running', 'merge_running', 'deploy_pending', 'deploy_fixing', 'wiki_updating', 'cs_running'];

function abortTask(taskId) {
  const ctrl = _inFlight.get(Number(taskId));
  if (ctrl) ctrl.abort();
}

function getInflightTaskIds() {
  return [..._inFlight.keys()];
}

async function getLoopCount(userId) {
  const { rows } = await query(
    'SELECT loop_count FROM loop_counter WHERE user_id = $1',
    [userId]
  );
  return rows.length ? rows[0].loop_count : 0;
}

async function incrementLoopCounter(userId) {
  await query(
    `INSERT INTO loop_counter (user_id, loop_count, run_started_at)
     VALUES ($1, 1, NOW())
     ON CONFLICT (user_id) DO UPDATE SET loop_count = loop_counter.loop_count + 1, run_started_at = NOW()`,
    [userId]
  );
}

async function resetLoopCounter(userId) {
  await query(
    `INSERT INTO loop_counter (user_id, loop_count, run_started_at)
     VALUES ($1, 0, NOW())
     ON CONFLICT (user_id) DO UPDATE SET loop_count = 0`,
    [userId]
  );
}

async function getUserSettings(userId) {
  const { rows } = await query('SELECT odoo_settings, deploy_cmd FROM users WHERE id = $1', [userId]);
  if (!rows.length) return {};
  const settings = rows[0].odoo_settings || {};
  return {
    git_repo_path: settings.git_repo_path || '',
    deploy_cmd: rows[0].deploy_cmd || settings.deploy_cmd || ''
  };
}

async function processTask(task, settings) {
  const { id: taskId, task_id, status } = task;

  if (status === 'analysis_running') {
    if (_inFlight.has(taskId)) return;
    const ctrl = new AbortController();
    _inFlight.set(taskId, ctrl);
    try {
      if (task.project_id) {
        const { runTaskAnalysis } = require('./task-agent');
        await runTaskAnalysis(taskId, task.user_id, ctrl.signal);
      } else {
        await analyzeTask(taskId, ctrl.signal);
      }
    } finally {
      _inFlight.delete(taskId);
    }
    return;
  }

  if (status === 'branch_pending') {
    const branchName = `task/${task_id}`;
    if (task.project_id) {
      // Project task: create branch in project repo (not user settings repo)
      const { rows: [repo] } = await query(
        'SELECT local_path FROM project_repos WHERE project_id = $1 AND is_primary = true',
        [task.project_id]
      );
      if (repo?.local_path) {
        await checkoutDefault(repo.local_path);
        await createBranch(repo.local_path, branchName);
      }
    } else if (settings.git_repo_path) {
      await checkoutDefault(settings.git_repo_path);
      await createBranch(settings.git_repo_path, branchName);
    }
    await query(
      "UPDATE tasks SET status = 'coding_running', git_branch = $2, updated_at = NOW() WHERE id = $1",
      [taskId, branchName]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'coding_running' });
    return;
  }

  if (status === 'coding_running') {
    if (_inFlight.has(taskId)) return;
    const ctrl = new AbortController();
    _inFlight.set(taskId, ctrl);
    try {
      const { runTaskCoding } = require('./task-agent');
      const handled = await runTaskCoding(taskId, task.user_id, ctrl.signal);
      if (!handled) {
        await query(
          "UPDATE tasks SET status='stopped', blocker_content='任務未綁定專案，無法執行開發', updated_at=NOW() WHERE id=$1",
          [taskId]
        );
        notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
      }
    } finally {
      _inFlight.delete(taskId);
    }
    return;
  }

  if (status === 'merge_running') {
    if (_inFlight.has(taskId)) return;
    const ctrl = new AbortController();
    _inFlight.set(taskId, ctrl);
    try {
      const { runMergeAgent } = require('./merge-agent');
      await runMergeAgent(taskId, task.user_id, ctrl.signal);
    } finally {
      _inFlight.delete(taskId);
    }
    return;
  }

  if (status === 'qa_running') {
    if (_inFlight.has(taskId)) return;
    const ctrl = new AbortController();
    _inFlight.set(taskId, ctrl);
    try {
      const { runTaskQa } = require('./task-agent');
      if (runTaskQa) {
        const handled = await runTaskQa(taskId, task.user_id, ctrl.signal);
        if (!handled) {
          await query(
            "UPDATE tasks SET status='stopped', blocker_content='任務未綁定專案，無法執行 QA', updated_at=NOW() WHERE id=$1",
            [taskId]
          );
          notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
        }
      }
    } finally {
      _inFlight.delete(taskId);
    }
    return;
  }

  if (status === 'deploy_pending') {
    try {
      await runDeploy(settings.deploy_cmd);
    } catch (deployErr) {
      console.error(`[RUNNER] deploy error task ${taskId}:`, deployErr.message);
      await query(
        `UPDATE tasks SET status = 'deploy_fixing', blocker_content = $2, updated_at = NOW() WHERE id = $1`,
        [taskId, `Deploy failed: ${deployErr.message}`]
      );
      notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'deploy_fixing' });
      return;
    }
    await query(
      "UPDATE tasks SET status = 'wiki_updating', updated_at = NOW() WHERE id = $1",
      [taskId]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'wiki_updating' });
  }

  if (status === 'deploy_fixing') {
    if (_inFlight.has(taskId)) return;
    const ctrl = new AbortController();
    _inFlight.set(taskId, ctrl);
    try {
      const { runDeployFixer } = require('./deploy-fixer');
      const blocker = task.blocker_content || '';
      await runDeployFixer(taskId, task.user_id, blocker, ctrl.signal);
    } finally {
      _inFlight.delete(taskId);
    }
    return;
  }

  if (status === 'wiki_updating') {
    if (_inFlight.has(taskId)) return;
    const ctrl = new AbortController();
    _inFlight.set(taskId, ctrl);
    try {
      const { runLibraryAgent } = require('./library-agent');
      await runLibraryAgent(taskId, task.user_id, ctrl.signal);
    } finally {
      _inFlight.delete(taskId);
    }
    return;
  }

  if (status === 'cs_running') {
    if (_inFlight.has(taskId)) return;
    const ctrl = new AbortController();
    _inFlight.set(taskId, ctrl);
    try {
      const { runCsAgent } = require('./cs-agent');
      await runCsAgent(taskId, task.user_id, ctrl.signal);
    } finally {
      _inFlight.delete(taskId);
    }
    return;
  }
}

async function runPipeline(userId) {
  const loopCount = await getLoopCount(userId);
  if (loopCount > LOOP_LIMIT) {
    notify.emitToUser(userId, 'notify:toast', {
      level: 'warn',
      message: `Pipeline 已達 ${LOOP_LIMIT} 次上限，等待新任務或手動重設`
    });
    return { processed: 0 };
  }

  await incrementLoopCounter(userId);

  const { rows: tasks } = await query(
    `SELECT id, task_id, status, user_id, project_id, blocker_content FROM tasks
     WHERE user_id = $1 AND status = ANY($2::text[]) AND is_paused = false AND is_hidden = false
     ORDER BY updated_at ASC`,
    [userId, RUNNABLE_STATUSES]
  );

  if (tasks.length === 0) return { processed: 0 };

  const settings = await getUserSettings(userId);

  // One-time check per pipeline run: skip Teams overhead if not configured
  let teamsEnabled = false;
  try {
    const { rows } = await query(
      'SELECT tenant_id, client_id, client_secret, team_id, channel_id FROM teams_settings WHERE id = 1'
    );
    const s = rows[0];
    teamsEnabled = !!(s?.tenant_id && s?.client_id && s?.client_secret && s?.team_id && s?.channel_id);
  } catch { /* teams_settings may not exist yet */ }

  let processed = 0;

  for (const task of tasks) {
    const prevStatus = task.status;
    try {
      await processTask(task, settings);
      processed++;
    } catch (err) {
      console.error(`[RUNNER] task ${task.id} error:`, err.message);
    }

    if (teamsEnabled) {
      try {
        const { rows: [updated] } = await query('SELECT status FROM tasks WHERE id = $1', [task.id]);
        if (updated && updated.status !== prevStatus) {
          const { enqueue } = require('../teams');
          enqueue('task', task.id);
          if (updated.status === 'confirm_pending') enqueue('question', task.id);
        }
      } catch (e) {
        console.error('[TEAMS] status check error:', e.message);
      }
    }
  }

  return { processed };
}

module.exports = { runPipeline, resetLoopCounter, abortTask, getInflightTaskIds };
