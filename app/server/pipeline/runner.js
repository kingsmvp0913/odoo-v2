/**
 * runner.js — Pipeline state machine
 *
 * Scans tasks in runnable statuses for a given user and advances them
 * through the pipeline states sequentially.
 *
 * Exports:
 *   runPipeline(userId)     → Promise<{ dispatched: number }>（併發派工，不 await 任務完成）
 *   whenIdle()              → Promise<void>（等所有在飛任務結束，測試用）
 *   abortTask / getInflightTaskIds
 */

const path = require('path');
const { query } = require('../db');
const { analyzeTask } = require('./analysis');
const { createBranch, checkoutDefault, ensureWorktreeAtMain, getMainBranch } = require('./git');
const { withProjectLock } = require('./project-lock');
const notify = require('../notify');

// 執行歷程階段標記的中文顯示（僅影響顯示文字，status 值與流程判斷不變）
const STAGE_LABELS = {
  new: '待分類', cs_running: '客服處理中', analysis_running: '分析中',
  confirm_answered: '已回覆澄清', branch_pending: '建立分支', coding_running: '開發中',
  qa_running: 'QA 審查中', merge_running: '併入測試中', deploy_testing: '部署測試區',
  playwright_running: 'E2E 測試中', wiki_updating: '更新 Wiki',
  reject_triage: '分診中', resolve_triage: '分診中'
};
// taskId (number) → { ctrl:AbortController, userId, promise }。派工時同步佔位，完成時移除。
const _inFlight = new Map();
const _pipelineRunning = new Set(); // userId → 掃描中（防同 user 重複掃描派工）
const RUNNABLE_STATUSES = ['new', 'cs_running', 'analysis_running', 'confirm_answered', 'branch_pending', 'coding_running', 'qa_running', 'merge_running', 'deploy_testing', 'playwright_running', 'wiki_updating', 'reject_triage', 'resolve_triage'];

// 併發上限：每人同時可跑幾個任務、全機總量（保護機器；claude CLI 很吃資源）
const MAX_PER_USER = parseInt(process.env.PIPELINE_MAX_PER_USER || '5', 10);
const MAX_GLOBAL = parseInt(process.env.PIPELINE_MAX_GLOBAL || '30', 10);

function abortTask(taskId) {
  const entry = _inFlight.get(Number(taskId));
  if (entry) entry.ctrl.abort();
}

function getInflightTaskIds() {
  return [..._inFlight.keys()];
}

// 真正在飛（有活著的 process）的任務資訊，供 admin 監控頁判斷「真正推進中」。
// startedAt 為 dispatch 當下時間戳，用來算「這一輪已跑多久」（tasks.updated_at 執行中不更新，不可靠）。
function getInflightInfo() {
  return [..._inFlight.entries()].map(([taskId, e]) => ({ taskId, userId: e.userId, startedAt: e.startedAt }));
}

// 等待目前所有在飛任務結束，含 runTask 內自動續跑串連派工的任務（供測試斷言 handler 效果；正式運作不需呼叫）
async function whenIdle() {
  while (_inFlight.size > 0) {
    await Promise.all([..._inFlight.values()].map(e => e.promise.catch(() => {})));
  }
}

async function getUserSettings(userId) {
  const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [userId]);
  if (!rows.length) return {};
  const settings = rows[0].odoo_settings || {};
  return {
    git_repo_path: settings.git_repo_path || ''
  };
}

// 各 handler 收 dispatchTask 傳入的 signal（_inFlight 佔位／回收由 dispatchTask 統一管理）

// new / cs_running：cs-agent 分類（唯一入口）
async function handleCs(task, settings, signal) {
  const { runCsAgent } = require('./cs-agent');
  await runCsAgent(task.id, task.user_id, signal);
}

// analysis_running：專案任務走 task-agent，否則走 analysis.js
async function handleAnalysis(task, settings, signal) {
  if (task.project_id) {
    const { runTaskAnalysis } = require('./task-agent');
    await runTaskAnalysis(task.id, task.user_id, signal);
  } else {
    await analyzeTask(task.id, signal);
  }
}

// confirm_answered：使用者答完澄清 → 回分析重跑（帶答案）
async function handleConfirmAnswered(task) {
  await query("UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1", [task.id]);
  notify.emitToUser(task.user_id, 'task:updated', { taskId: task.id, status: 'analysis_running' });
}

// branch_pending：專案任務為每個 repo 建 worktree（並行隔離）；否則用 user 的 git_repo_path
async function handleBranch(task, settings) {
  await doBranch(task, settings);
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
      // worktree 動到共用主 clone → 持專案鎖，與 merge/deploy/analysis 序列化（健檢 U7）。
      // 冪等（reset=false）：analysis 通常已建好此 worktree，這裡沿用不重建、不動已有內容。
      const err = await withProjectLock(task.project_id, async () => {
        try {
          for (const repo of repos) {
            const wtPath = path.join(wtParent, path.basename(repo.local_path));
            const base = await getMainBranch(repo.local_path);
            await ensureWorktreeAtMain(repo.local_path, wtPath, branchName, base, false);
          }
          return null;
        } catch (e) {
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
    // 這裡不接錯誤的話會被 runTask 的 catch 吞掉、狀態停在 branch_pending → cron 每分鐘無限重試同樣失敗；
    // 比照專案路徑：git 失敗直接 stopped 留下原因，等人工處理
    try {
      await checkoutDefault(settings.git_repo_path);
      await createBranch(settings.git_repo_path, branchName);
    } catch (e) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, `建立分支失敗：${e.message}`]
      );
      notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
      return;
    }
  }
  await query(
    "UPDATE tasks SET status = 'coding_running', git_branch = $2, updated_at = NOW() WHERE id = $1",
    [taskId, branchName]
  );
  notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'coding_running' });
}

// coding_running：task-agent 實作；未綁專案則停止
async function handleCoding(task, settings, signal) {
  const { runTaskCoding } = require('./task-agent');
  const handled = await runTaskCoding(task.id, task.user_id, signal);
  if (!handled) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='任務未綁定專案，無法執行開發', updated_at=NOW() WHERE id=$1",
      [task.id]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId: task.id, status: 'stopped' });
  }
}

// qa_running：QA agent 對照 SD 審查 diff（pass→merge_running；fail→退 coding 計數）
async function handleQa(task, settings, signal) {
  const { runQaAgent } = require('./qa-agent');
  await runQaAgent(task.id, task.user_id, signal);
}

// merge_running：把 task 分支併入 testing
async function handleMerge(task, settings, signal) {
  const { runMergeAgent } = require('./merge-agent');
  await runMergeAgent(task.id, task.user_id, signal);
}

// deploy_testing：純程式部署到測試區 + odoo-bin -u 升級
async function handleDeployTesting(task, settings, signal) {
  const { runDeployTesting } = require('./deploy-testing');
  await runDeployTesting(task.id, task.user_id, signal);
}

// playwright_running：E2E via Odoo 原生 tour（pass→review_pending；fail→退 coding 計數）
async function handlePlaywright(task, settings, signal) {
  const { runTourStage } = require('./playwright-agent');
  await runTourStage(task.id, task.user_id, signal);
}

// wiki_updating：library-agent 更新 wiki → done
async function handleWiki(task, settings, signal) {
  const { runLibraryAgent } = require('./library-agent');
  await runLibraryAgent(task.id, task.user_id, signal);
}

// reject_triage（人工審核退回）／resolve_triage（卡關填修正指示）：共用通用分診員，
// 讀 diff/log＋使用者的話判 resume/advance/fix/respec 決定下一步。
async function handleRejectTriage(task, settings, signal) {
  const { runRejectTriage } = require('./reject-triage');
  await runRejectTriage(task.id, task.user_id, signal);
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
  reject_triage: handleRejectTriage,
  resolve_triage: handleRejectTriage,
};

// 執行一個任務：狀態重查（防過期快照）→ 寫階段標記 → 跑 handler → 失敗原因落地／Teams。
// signal 由 dispatchTask 傳入；此函式不管 _inFlight 佔位/回收。
async function runTask(task, settings, signal) {
  const prevStatus = task.status;
  try {
    // 快照防護：撈出到執行之間，任務可能被暫停或狀態被 API（resolve-blocker 等）改動 → 留給下一輪
    const { rows: [cur] } = await query('SELECT status, is_paused FROM tasks WHERE id = $1', [task.id]);
    if (!cur || cur.status !== task.status || cur.is_paused) return;
    const handler = HANDLERS[task.status];
    if (!handler) return;

    // 階段標記（每次進入一關寫一次；派工已排除在飛任務，不會重複）
    const marker = `\n\x1b[96m▶ ${STAGE_LABELS[task.status] || task.status}\x1b[0m\n`;
    notify.emitToUser(task.user_id, 'terminal:output', { taskId: task.id, data: marker });
    await query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)', [task.id, marker]).catch(() => {});
    // 記錄目前這一關：若此階段失敗轉 stopped，解決阻塞可回到這一關續跑（而非退回 new 重分診）。
    // 例外：分診關（reject_triage／resolve_triage）本身的 resume_status 是「真正的原關」資料（由 route 保留供分診讀取，
    // 見 tasks-routes.js），不可蓋成分診自己——否則分診 resume 會回到自己，無限重進分診。
    if (task.status !== 'reject_triage' && task.status !== 'resolve_triage') {
      await query('UPDATE tasks SET resume_status = $2 WHERE id = $1', [task.id, task.status]).catch(() => {});
    }

    await handler(task, settings, signal);
  } catch (err) {
    console.error(`[RUNNER] task ${task.id} error:`, err.message);
  }

  // 處理後狀態：剛轉 stopped → 把阻塞原因寫進執行歷程（集中一處涵蓋所有 agent 的 stop）
  try {
    const { rows: [u] } = await query('SELECT status, blocker_content FROM tasks WHERE id = $1', [task.id]);
    if (!u) return;
    if (u.status === 'stopped' && prevStatus !== 'stopped') {
      const reason = `\n\x1b[91m❌ 失敗：${u.blocker_content || '未提供原因'}\x1b[0m\n`;
      notify.emitToUser(task.user_id, 'terminal:output', { taskId: task.id, data: reason });
      await query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)', [task.id, reason]).catch(() => {});
    }
    if (u.status !== prevStatus) {
      try {
        const { rows: [ts] } = await query('SELECT tenant_id, client_id, client_secret, team_id, channel_id FROM teams_settings WHERE id = 1');
        if (ts?.tenant_id && ts?.client_id && ts?.client_secret && ts?.team_id && ts?.channel_id) {
          const { enqueue } = require('../teams');
          enqueue('task', task.id);
          if (u.status === 'confirm_pending' || u.status === 'reject_confirm_pending') enqueue('question', task.id);
        }
      } catch { /* teams 未設定或不可用 */ }
    }
  } catch (e) {
    console.error('[RUNNER] post-status check error:', e.message);
  }
}

// 任務跑完、佔位釋出後：狀態若真的推進到下一個可跑關卡就立刻續跑該 user 的掃描，
// 不必等下一次 cron tick（最多延遲 1 分鐘）。狀態沒變（含 handler 沒動 DB 的例外）不重掃，
// 避免卡住不動的狀態被瞬間打成無限迴圈；必須放在 _inFlight.delete 之後，續跑掃描才能重新派到同一個任務。
async function continuePipelineIfAdvanced(task) {
  try {
    const { rows: [cur] } = await query('SELECT status FROM tasks WHERE id = $1', [task.id]);
    if (cur && cur.status !== task.status && RUNNABLE_STATUSES.includes(cur.status)) {
      await runPipeline(task.user_id);
    }
  } catch (err) {
    console.error('[RUNNER] auto-continue error:', err.message);
  }
}

// 同步佔位派工：_inFlight.set 在任何 await 之前完成（單執行緒保證不會兩個 tick 搶同一任務），
// 之後 fire-and-forget 執行，完成時自動移除。回傳是否成功佔位。
function dispatchTask(task, settings) {
  if (_inFlight.has(task.id)) return false;
  // 全域上限即時核對：slots 是掃描開頭的快照，跨 user 併發掃描（cron 每 user fire-and-forget）
  // 會各自對同一份 _inFlight.size 算預算而超派；在此同步佔位點即時擋，讓所有掃描共用同一原子檢查。
  if (_inFlight.size >= MAX_GLOBAL) return false;
  const ctrl = new AbortController();
  const promise = runTask(task, settings, ctrl.signal).finally(() => {
    _inFlight.delete(task.id);
    return continuePipelineIfAdvanced(task);
  });
  _inFlight.set(task.id, { ctrl, userId: task.user_id, promise, startedAt: Date.now() });
  return true;
}

// 掃描該 user 可跑任務，在併發上限內派工（不 await 任務完成 → 下一 tick 隨槽位釋出續派）。
// 取代舊的循序 for-loop ＋ loop_counter 節流（健檢 U8）。
async function runPipeline(userId) {
  if (_pipelineRunning.has(userId)) return { dispatched: 0 }; // 掃描鎖：防同 user 重複掃描
  _pipelineRunning.add(userId);
  try {
    const perUser = [..._inFlight.values()].filter(e => e.userId === userId).length;
    const slots = Math.min(MAX_PER_USER - perUser, MAX_GLOBAL - _inFlight.size);
    if (slots <= 0) return { dispatched: 0 };

    const { rows: tasks } = await query(
      `SELECT id, task_id, status, user_id, project_id, blocker_content FROM tasks
       WHERE user_id = $1 AND status = ANY($2::text[]) AND is_paused = false AND is_hidden = false
       ORDER BY updated_at ASC`,
      [userId, RUNNABLE_STATUSES]
    );
    if (tasks.length === 0) return { dispatched: 0 };

    const settings = await getUserSettings(userId);
    let dispatched = 0;
    for (const task of tasks) {
      if (dispatched >= slots) break;
      if (_inFlight.size >= MAX_GLOBAL) break;   // 全機滿載，本輪停止派工（即時，跨 user 併發共用）
      if (_inFlight.has(task.id)) continue;      // 已在飛，不重複派
      if (dispatchTask(task, settings)) dispatched++;
    }
    return { dispatched };
  } finally {
    _pipelineRunning.delete(userId);
  }
}

module.exports = { runPipeline, abortTask, getInflightTaskIds, getInflightInfo, whenIdle };
