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

const path = require('path');
const { query } = require('../db');
const { analyzeTask } = require('./analysis');
const { createBranch, checkoutDefault, addWorktree, removeWorktree } = require('./git');
const notify = require('../notify');

const LOOP_LIMIT = 5;
const _inFlight = new Map(); // taskId (number) → AbortController
const RUNNABLE_STATUSES = ['new', 'cs_running', 'analysis_running', 'confirm_answered', 'branch_pending', 'coding_running', 'qa_running', 'merge_running', 'deploy_testing', 'playwright_running', 'wiki_updating'];

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

// 包住需要中斷控制的長時 handler：同一任務防重入，註冊 AbortController 供暫停中止
function withInflight(taskId, fn) {
  if (_inFlight.has(taskId)) return Promise.resolve();
  const ctrl = new AbortController();
  _inFlight.set(taskId, ctrl);
  return Promise.resolve(fn(ctrl.signal)).finally(() => _inFlight.delete(taskId));
}

// new / cs_running：cs-agent 分類（唯一入口）
async function handleCs(task) {
  await withInflight(task.id, (signal) => {
    const { runCsAgent } = require('./cs-agent');
    return runCsAgent(task.id, task.user_id, signal);
  });
}

// analysis_running：專案任務走 task-agent，否則走 analysis.js
async function handleAnalysis(task) {
  await withInflight(task.id, async (signal) => {
    if (task.project_id) {
      const { runTaskAnalysis } = require('./task-agent');
      await runTaskAnalysis(task.id, task.user_id, signal);
    } else {
      await analyzeTask(task.id, signal);
    }
  });
}

// confirm_answered：使用者答完澄清 → 回分析重跑（帶答案）
async function handleConfirmAnswered(task) {
  await query("UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1", [task.id]);
  notify.emitToUser(task.user_id, 'task:updated', { taskId: task.id, status: 'analysis_running' });
}

// branch_pending：專案任務為每個 repo 建 worktree（並行隔離）；否則用 user 的 git_repo_path
async function handleBranch(task, settings) {
  const taskId = task.id;
  const branchName = `task/${task.task_id}`;
  if (task.project_id) {
    const { rows: repos } = await query(
      "SELECT local_path FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
      [task.project_id]
    );
    if (repos.length) {
      const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);
      const created = [];
      try {
        for (const repo of repos) {
          const wtPath = path.join(wtParent, path.basename(repo.local_path));
          // testing 為主 clone 常駐分支（triggerClone 已建）；缺少時 addWorktree 會失敗並進 rollback
          await addWorktree(repo.local_path, wtPath, branchName, 'testing');
          created.push({ mainRepo: repo.local_path, wtPath });
        }
      } catch (err) {
        for (const c of created) await removeWorktree(c.mainRepo, c.wtPath).catch(() => {});
        await query(
          "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
          [taskId, `建立 worktree 失敗：${err.message}`]
        );
        notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
        return;
      }
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
}

// coding_running：task-agent 實作；未綁專案則停止
async function handleCoding(task) {
  await withInflight(task.id, async (signal) => {
    const { runTaskCoding } = require('./task-agent');
    const handled = await runTaskCoding(task.id, task.user_id, signal);
    if (!handled) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_content='任務未綁定專案，無法執行開發', updated_at=NOW() WHERE id=$1",
        [task.id]
      );
      notify.emitToUser(task.user_id, 'task:updated', { taskId: task.id, status: 'stopped' });
    }
  });
}

// qa_running：QA agent 對照 SD 審查 diff（pass→merge_running；fail→退 coding 計數）
async function handleQa(task) {
  await withInflight(task.id, (signal) => {
    const { runQaAgent } = require('./qa-agent');
    return runQaAgent(task.id, task.user_id, signal);
  });
}

// merge_running：把 task 分支併入 testing
async function handleMerge(task) {
  await withInflight(task.id, (signal) => {
    const { runMergeAgent } = require('./merge-agent');
    return runMergeAgent(task.id, task.user_id, signal);
  });
}

// deploy_testing：純程式部署到測試區 + odoo-bin -u 升級
async function handleDeployTesting(task) {
  await withInflight(task.id, (signal) => {
    const { runDeployTesting } = require('./deploy-testing');
    return runDeployTesting(task.id, task.user_id, signal);
  });
}

// wiki_updating：library-agent 更新 wiki → done
async function handleWiki(task) {
  await withInflight(task.id, (signal) => {
    const { runLibraryAgent } = require('./library-agent');
    return runLibraryAgent(task.id, task.user_id, signal);
  });
}

const HANDLERS = {
  new: handleCs,
  cs_running: handleCs,
  analysis_running: handleAnalysis,
  confirm_answered: handleConfirmAnswered,
  branch_pending: handleBranch,
  coding_running: handleCoding,
  qa_running: handleQa,
  merge_running: handleMerge,
  deploy_testing: handleDeployTesting,
  wiki_updating: handleWiki,
  // playwright_running → Task 8
};

async function processTask(task, settings) {
  const handler = HANDLERS[task.status];
  if (handler) await handler(task, settings);
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
