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
const { createBranch, checkoutDefault, addWorktree, removeWorktree, getMainBranch } = require('./git');
const { withProjectLock } = require('./project-lock');
const notify = require('../notify');

const LOOP_LIMIT = 5;
// 執行歷程階段標記的中文顯示（僅影響顯示文字，status 值與流程判斷不變）
const STAGE_LABELS = {
  new: '待分類', cs_running: '客服處理中', analysis_running: '分析中',
  confirm_answered: '已回覆澄清', branch_pending: '建立分支', coding_running: '開發中',
  qa_running: 'QA 審查中', merge_running: '併入測試中', deploy_testing: '部署測試區',
  playwright_running: 'E2E 測試中', wiki_updating: '更新 Wiki'
};
const _inFlight = new Map(); // taskId (number) → AbortController
const _pipelineRunning = new Set(); // userId → runPipeline 執行中（cron 每分鐘 fire-and-forget，防疊加並行實例）
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
  const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [userId]);
  if (!rows.length) return {};
  const settings = rows[0].odoo_settings || {};
  return {
    git_repo_path: settings.git_repo_path || ''
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
  await withInflight(task.id, async () => {
    await query("UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1", [task.id]);
    notify.emitToUser(task.user_id, 'task:updated', { taskId: task.id, status: 'analysis_running' });
  });
}

// branch_pending：專案任務為每個 repo 建 worktree（並行隔離）；否則用 user 的 git_repo_path
async function handleBranch(task, settings) {
  await withInflight(task.id, () => doBranch(task, settings));
}

async function doBranch(task, settings) {
  const taskId = task.id;
  const branchName = `task/${task.task_id}`;
  if (task.project_id) {
    const { rows: repos } = await query(
      "SELECT local_path FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
      [task.project_id]
    );
    if (repos.length) {
      const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);
      // worktree add/remove 動到共用主 clone 的 refs → 持專案鎖，與 merge/deploy/analysis 序列化（健檢 U7）
      const err = await withProjectLock(task.project_id, async () => {
        const created = [];
        try {
          for (const repo of repos) {
            const wtPath = path.join(wtParent, path.basename(repo.local_path));
            // 任務分支從 main/master 長出（乾淨基底，與其他在途任務隔離）
            const base = await getMainBranch(repo.local_path);
            await addWorktree(repo.local_path, wtPath, branchName, base);
            created.push({ mainRepo: repo.local_path, wtPath });
          }
          return null;
        } catch (e) {
          for (const c of created) await removeWorktree(c.mainRepo, c.wtPath).catch(() => {});
          return e;
        }
      });
      if (err) {
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

// playwright_running：依 SD 產計畫並跑 E2E（pass→review_pending；fail→退 coding 計數）
async function handlePlaywright(task) {
  await withInflight(task.id, (signal) => {
    const { runPlaywrightAgent } = require('./playwright-agent');
    return runPlaywrightAgent(task.id, task.user_id, signal);
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
  playwright_running: handlePlaywright,
  wiki_updating: handleWiki,
};

async function processTask(task, settings) {
  // 快照防護：同輪前面的任務可能 block 數分鐘，這裡的 task.status 是開跑時的舊快照。
  // 派工前重查現況，狀態已推進或被暫停就留給下一輪——用過期快照派工最壞會砍掉進行中 coding 的 worktree。
  const { rows: [cur] } = await query('SELECT status, is_paused FROM tasks WHERE id = $1', [task.id]);
  if (!cur || cur.status !== task.status || cur.is_paused) return;
  const handler = HANDLERS[task.status];
  if (!handler) return;
  // 執行歷程階段標記：只在「真正進入」時寫一次。已 inflight（長階段 claude 仍在跑，
  // 每次 cron tick 都會 re-poll 到同一 *_running 任務）就跳過，避免重複標記洗版。
  if (!_inFlight.has(task.id)) {
    const marker = `\n\x1b[96m▶ ${STAGE_LABELS[task.status] || task.status}\x1b[0m\n`;
    notify.emitToUser(task.user_id, 'terminal:output', { taskId: task.id, data: marker });
    await query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)', [task.id, marker]).catch(() => {});
    // 記錄目前這一關：若此階段失敗轉 stopped，解決阻塞可回到這一關續跑（而非退回 new 重分診）
    await query('UPDATE tasks SET resume_status = $2 WHERE id = $1', [task.id, task.status]).catch(() => {});
  }
  await handler(task, settings);
}

async function runPipeline(userId) {
  // cron 每分鐘 fire-and-forget：同 user 上一輪未結束就跳過本輪，避免並行實例用過期快照互踩
  if (_pipelineRunning.has(userId)) return { processed: 0 };
  _pipelineRunning.add(userId);
  try {
    return await doRunPipeline(userId);
  } finally {
    _pipelineRunning.delete(userId);
  }
}

async function doRunPipeline(userId) {
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

    // 讀取處理後的狀態；若剛轉為 stopped，把阻塞原因寫進執行歷程
    // （否則使用者在執行歷程只看到停下、看不到為什麼——集中一處涵蓋所有 agent 的 stop）
    let updatedStatus = null;
    try {
      const { rows: [u] } = await query('SELECT status, blocker_content FROM tasks WHERE id = $1', [task.id]);
      if (u) {
        updatedStatus = u.status;
        if (u.status === 'stopped' && prevStatus !== 'stopped') {
          const reason = `\n\x1b[91m❌ 失敗：${u.blocker_content || '未提供原因'}\x1b[0m\n`;
          notify.emitToUser(task.user_id, 'terminal:output', { taskId: task.id, data: reason });
          await query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)', [task.id, reason]).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[RUNNER] post-status check error:', e.message);
    }

    if (teamsEnabled && updatedStatus && updatedStatus !== prevStatus) {
      try {
        const { enqueue } = require('../teams');
        enqueue('task', task.id);
        if (updatedStatus === 'confirm_pending') enqueue('question', task.id);
      } catch (e) {
        console.error('[TEAMS] status check error:', e.message);
      }
    }
  }

  return { processed };
}

module.exports = { runPipeline, resetLoopCounter, abortTask, getInflightTaskIds };
