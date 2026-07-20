const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { pullBranch, ensureMainBranch, ensureWorktreeAtMain } = require('./git');
const { withProjectLock } = require('./project-lock');
const { buildGitEnv } = require('../lib/git-identity');
const { runClaude, abortError, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { assembleTaskContext } = require('./sync');
const yaml = require('js-yaml');
const { determineNextStatus, REQUIRED_FIELDS, logAnalysisGate } = require('./analysis');

function buildCommitMessage(task) {
  const title = (task.title || '').trim() || task.task_id;
  if (task.source === 'service') {
    // Title stored as "IDX-2026060098: 修正發票計算問題" → "修正發票計算問題 (IDX-2026060098)"
    const colonIdx = title.indexOf(': ');
    if (colonIdx > 0) {
      const idx = title.slice(0, colonIdx);
      const subject = title.slice(colonIdx + 2);
      return `${subject} (${idx})`;
    }
    return title;
  }
  return title;
}

// 回傳專案根目錄與所有已 clone 完成的 repo 清單（不再只取 primary 單一路徑）。
// root = repos/<專案>/（所有 repo 主 clone 的父目錄）；供 analysis 讀全 repo、coding 衍生 worktree 父目錄。
async function getProjectInfo(projectId) {
  const { rows } = await query(
    `SELECT p.name, p.odoo_version, pr.local_path, pr.label
     FROM projects p
     JOIN project_repos pr ON pr.project_id = p.id
     WHERE p.id = $1 AND pr.clone_status = 'done' AND pr.local_path IS NOT NULL
     ORDER BY pr.is_primary DESC, pr.id`,
    [projectId]
  );
  if (!rows.length) return null;
  const repos = rows.map(r => ({ label: r.label, local_path: r.local_path, subdir: path.basename(r.local_path) }));
  return {
    name: rows[0].name,
    odoo_version: rows[0].odoo_version,
    root: path.dirname(repos[0].local_path),
    repos
  };
}

// 任務 worktree 父目錄：<專案根>/.worktrees/<task_id>/（coding agent 的 cwd）
function worktreeParent(root, taskId) {
  return path.join(root, '.worktrees', taskId);
}

function buildAnalysisPrompt(task, info, clarification, workDir) {
  const agent = loadAgent('analysis-project');
  const repoList = (info.repos || []).map(r => `- ${r.subdir}/`).join('\n') || '（無 repo）';
  return {
    prompt: agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      work_dir: workDir || info.root,
      repo_list: repoList,
      original_text: task.original_text || '（無內容）',
      task_id: task.task_id,
      clarification: clarification || '（無）'
    }).trim(),
    model: agent.model
  };
}

// 取最近一筆「修正指示」（失敗處理時使用者輸入）；供 resume 後的階段帶入 prompt，讓指示真的生效
async function latestResolution(taskId) {
  const { rows } = await query(
    "SELECT content FROM task_logs WHERE task_id = $1 AND role = 'user' AND content LIKE '[修正指示]%' ORDER BY created_at DESC LIMIT 1",
    [taskId]
  );
  if (!rows.length) return '';
  return rows[0].content.replace(/^\[修正指示\]\s*/, '').trim();
}

function buildCodingPrompt(task, info, resolution, retryFeedback) {
  const agent = loadAgent('coding-project');
  const repoList = (info.repos || []).map(r => `- ${r.subdir}/`).join('\n') || '（無 repo）';
  return {
    prompt: agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      work_dir: worktreeParent(info.root, task.task_id),
      git_branch: task.git_branch || '（未設定）',
      analysis_yaml: task.analysis_yaml || '（無規格）',
      commit_message: buildCommitMessage(task),
      repo_list: repoList,
      resolution: resolution || '（無）',
      retry_feedback: retryFeedback || '（無）'
    }).trim(),
    model: agent.model
  };
}

async function runTaskAnalysis(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;
  task.original_text = await assembleTaskContext(taskId);

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='專案未設定任何已完成 clone 的 Repo，請至專案設定新增 Repo', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 每人自己的 GitHub PAT：analysis pull 前先解出該任務發起人的 git 注入 env；
  // 未設 PAT → 停任務等使用者去設定填 PAT，不得拿 pipeline 共用身分硬幹。
  let gitEnv;
  try {
    gitEnv = await buildGitEnv(userId);
  } catch (e) {
    if (e.code === 'NO_GIT_CRED') {
      await query(
        `UPDATE tasks SET status='stopped', blocker_type='git_cred', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, '請先到設定填個人 GitHub PAT，任務才能存取 GitHub。']
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return true;
    }
    throw e;
  }

  // 任務 worktree（一個任務一個，analysis 建、coding 沿用、approve 併 main 後才刪）：
  // 持鎖 pull 最新 main 並確保 task 分支 worktree 於最新 main（reset=true，此階段尚無程式變更）。
  // analysis 讀它 → 永遠讀「乾淨 main」，不受別任務把共用主 clone 切到 testing 的污染（健檢 U7）。
  // pull 失敗（origin 不通／本地髒）→ 停下等人工。
  const wtParent = worktreeParent(info.root, task.task_id);
  let setupErr = null;
  await withProjectLock(task.project_id, async () => {
    try {
      for (const repo of info.repos) {
        const base = await ensureMainBranch(repo.local_path, gitEnv);
        await pullBranch(repo.local_path, base, gitEnv);
        await ensureWorktreeAtMain(repo.local_path, path.join(wtParent, repo.subdir), `task/${task.task_id}`, base, true);
      }
    } catch (e) { setupErr = e; }
  });
  if (setupErr) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `分析前更新 main 失敗（請確認 origin 可連線且本地無未提交變更）：${setupErr.message}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 回帶先前澄清問答的使用者回覆，供 confirm_answered 重跑時參考
  const { rows: logs } = await query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 10", [taskId]
  );
  const clarification = logs.reverse().filter(l => l.role === 'user').map(l => l.content).join('\n');

  let raw;
  try {
    const built = buildAnalysisPrompt(task, info, clarification, wtParent);
    // analysis 讀任務自己的 worktree（cwd=wtParent，內容＝乾淨 main），不持鎖 → 與別任務 merge/deploy 平行。
    // worktree 不在此移除：留給 coding 沿用，approve 併 main 後才清。
    const analysisResult = await runClaude(built.prompt, { cwd: wtParent, taskId, userId, signal, model: built.model, agentType: 'analysis' });
    raw = analysisResult.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', analysisResult.usage, analysisResult.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, stopReason('分析 Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 契約（analysis-project.md）：<result> 內「裸 YAML」。
  // 舊契約要 agent 把整份 YAML 做 JSON 逃逸再包 JSON——多欄位含引號時逃逸極易出錯；
  // 改裸 YAML，下一狀態由 server 端 determineNextStatus 推導（與 analysis.js 單一真相）。
  const result = await parseAgentResult(raw, {
    parse: s => yaml.load(s, { schema: yaml.CORE_SCHEMA }), signal,
    ref: { taskId: task.task_id, projectId: task.project_id }, userId
  });

  if (result && typeof result === 'object' && result.stopped_reason) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, String(result.stopped_reason)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  if (!result || typeof result !== 'object') {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='分析 Agent 未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 必要欄位缺漏不得放行：殘缺 SD 進 coding 會拿垃圾規格燒 token（Rule 12 fail-loud）
  const missing = REQUIRED_FIELDS.filter(f => result[f] == null || result[f] === '');
  if (missing.length > 0) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `分析結果缺少必要欄位：${missing.join(', ')}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const nextStatus = determineNextStatus(result); // branch_pending | confirm_pending | spec_review
  await query(
    `UPDATE tasks SET status=$2, analysis_yaml=$3, updated_at=NOW() WHERE id=$1`,
    [taskId, nextStatus, yaml.dump(result)]
  );
  await logAnalysisGate(taskId, result, nextStatus);
  notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  return true;
}

// coding 是最長的階段（探索＋實作＋逐檔驗證＋commit），共用預設 600s 常不夠；
// 逾時＝整輪報廢重跑（比放寬上限更貴），故獨立放寬、可用 env 調整
const CODING_TIMEOUT_MS = parseInt(process.env.PIPELINE_CODING_TIMEOUT_MS || '1800000', 10);

// 跑一輪 coding：無狀態，一律用 coding-project 統一 prompt（不 --resume）。
// 省 token 靠 prompt cache（實測 coding 全價 input 僅佔 0.28%，重送規則/spec 幾乎免費），
// 不再靠 session 記憶——每輪都讀 worktree 既有碼做增量修正（見 coding-project.md），避免 session drift 與整包重寫。
// retry_feedback 存在＝被下游退回的修正輪 → 升級 opus（同腦袋再猜收斂率低）。
async function runCodingOnce(task, info, userId, signal, resolution, gitEnv) {
  const cwd = worktreeParent(info.root, task.task_id);
  const escalateModel = task.retry_feedback ? 'opus' : null;
  const built = buildCodingPrompt(task, info, resolution, task.retry_feedback || '');
  return runClaude(built.prompt, { cwd, taskId: task.id, userId, signal, model: escalateModel || built.model, agentType: 'coding', timeoutMs: CODING_TIMEOUT_MS, env: { ...gitEnv } });
}

async function runTaskCoding(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, source, analysis_yaml, git_branch, project_id, retry_feedback FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.root) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='專案未設定任何已完成 clone 的 Repo，請至專案設定新增 Repo', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 每人自己的 GitHub PAT：coding 呼叫 claude 前先解出該任務發起人的 git 注入 env
  // （子行程內的 git commit/push 靠這組身分／PAT），未設 PAT → 停任務等使用者去設定填 PAT。
  let gitEnv;
  try {
    gitEnv = await buildGitEnv(userId);
  } catch (e) {
    if (e.code === 'NO_GIT_CRED') {
      await query(
        `UPDATE tasks SET status='stopped', blocker_type='git_cred', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
        [taskId, '請先到設定填個人 GitHub PAT，任務才能存取 GitHub。']
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return true;
    }
    throw e;
  }

  const ref = { taskId: task.task_id, projectId: task.project_id };
  let raw;
  try {
    const resolution = await latestResolution(taskId);
    // 無狀態：一律 fresh 跑統一 prompt（不 resume；靠 prompt cache 省 input）。coding 每輪讀 worktree 既有碼做增量。
    const codingResult = await runCodingOnce(task, info, userId, signal, resolution, gitEnv);
    // 記本輪 session id 當「已開工」marker（供 respec 等判斷；不再用於 resume）
    await query('UPDATE tasks SET coding_session_id=$2 WHERE id=$1', [taskId, codingResult.sessionId]).catch(() => {});
    raw = codingResult.text;
    await logTokenUsage(ref, userId, 'coding', codingResult.usage, codingResult.durationMs);
  } catch (err) {
    await logFailedUsage(ref, userId, 'coding', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, stopReason('實作 Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal, ref, userId });
  if (result?.status === 'qa_running') {
    // 走到「確定推進」才消費 retry_feedback；解析失敗轉 stopped 時保留，
    // 讓之後分診放回 coding 仍有上一輪失敗上下文可 resume（避免盲改，健檢止血 11）
    if (task.retry_feedback) await query('UPDATE tasks SET retry_feedback=NULL WHERE id=$1', [taskId]).catch(() => {});
    await query(`UPDATE tasks SET status='qa_running', updated_at=NOW() WHERE id=$1`, [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'qa_running' });
  } else {
    const errorMsg = result?.error || '實作 Agent 未回傳有效結果，請檢查 terminal 輸出';
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, errorMsg]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  }
  return true;
}

module.exports = { runTaskAnalysis, runTaskCoding, getProjectInfo, worktreeParent, latestResolution };
