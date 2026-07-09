const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { pullBranch, ensureMainBranch, ensureWorktreeAtMain } = require('./git');
const { withProjectLock } = require('./project-lock');
const { runClaude, abortError, stopReason } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { assembleTaskContext } = require('./sync');

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

// resume 路徑專用：把 retry_feedback 蒸餾成更精簡的內容，讓已有完整上下文的 session 只收重點（健檢 U3）。
// 回傳 { gate:關卡, body:蒸餾後內容 }。逃生口：保留「完整 log：<路徑>」，蒸餾不足時 resume agent 可自行 Read。
function distillFeedback(raw) {
  const s = String(raw || '').trim();
  if (!s) return { gate: '', body: '' };

  let gate = '', rest = s;
  const tag = s.match(/^\[([^\]]+)\]\s*/); // 開頭的 [QA 未通過] / [部署測試區升級失敗] / [E2E 測試未通過]
  if (tag) { gate = tag[1]; rest = s.slice(tag[0].length); }

  let logRef = '';
  const logM = rest.match(/完整 log：.+$/m);
  if (logM) { logRef = logM[0]; rest = rest.replace(logM[0], '').trim(); }

  let body;
  const tbIdx = rest.indexOf('Traceback (most recent call last)');
  if (tbIdx !== -1) {
    // Python traceback：只留「使用者模組 frame」＋最後例外行，砍掉 framework frames。
    // 可編輯模組一律 idx_ 開頭（新建規則；原生模組禁止修改）→ 以 idx_ 判定使用者 frame。
    const lines = rest.slice(tbIdx).split(/\r?\n/);
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*File .*idx_\w+/.test(lines[i])) {
        kept.push(lines[i].trim());
        if (lines[i + 1] && /^\s+\S/.test(lines[i + 1])) kept.push(lines[i + 1].trim());
      }
    }
    const exc = [...lines].reverse().find(l => {
      const t = l.trim();
      return /^[\w.]+(Error|Exception|Warning|Failed)\b/.test(t) || /^[\w.]+: \S/.test(t);
    });
    if (exc) kept.push(exc.trim());
    body = kept.join('\n') || lines.slice(-3).map(l => l.trim()).join('\n');
  } else {
    body = rest.replace(/\n{3,}/g, '\n\n').trim(); // 自然語言（QA/E2E）：近原樣，只收斂空白
  }

  if (body.length > 400) body = body.slice(0, 400) + '…';
  if (logRef) body += '\n' + logRef;
  return { gate, body };
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

  // 任務 worktree（一個任務一個，analysis 建、coding 沿用、approve 併 main 後才刪）：
  // 持鎖 pull 最新 main 並確保 task 分支 worktree 於最新 main（reset=true，此階段尚無程式變更）。
  // analysis 讀它 → 永遠讀「乾淨 main」，不受別任務把共用主 clone 切到 testing 的污染（健檢 U7）。
  // pull 失敗（origin 不通／本地髒）→ 停下等人工。
  const wtParent = worktreeParent(info.root, task.task_id);
  let setupErr = null;
  await withProjectLock(task.project_id, async () => {
    try {
      for (const repo of info.repos) {
        const base = await ensureMainBranch(repo.local_path);
        await pullBranch(repo.local_path, base);
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
    const analysisResult = await runClaude(built.prompt, { cwd: wtParent, taskId, userId, signal, model: built.model });
    raw = analysisResult.text;
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', analysisResult.usage, analysisResult.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'analysis', err);
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, stopReason('分析 Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal });

  if (result?.status === 'stopped') {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, result.error || '分析 Agent 停止，未回傳原因']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  if (!result?.status || !result?.analysis_yaml) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='分析 Agent 未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  // 未知 status 不再靜默放行成 branch_pending：可能讓「需確認」的任務未經確認就開工（違反 Rule 12）
  if (!['branch_pending', 'confirm_pending'].includes(result.status)) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `分析 Agent 回傳未預期的 status：${result.status}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }
  await query(
    `UPDATE tasks SET status=$2, analysis_yaml=$3, updated_at=NOW() WHERE id=$1`,
    [taskId, result.status, result.analysis_yaml]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: result.status });
  return true;
}

const RESUME_LIMIT = 2; // 每個 session 世代最多 resume 幾次，之後強制 fresh（避免在錯誤方向上一直加碼）

// resume 失敗是否值得 fallback 到 fresh：
// error（session 遺失／CLI 壞掉，快速非零退出）→ 值得重來；
// timeout（已燒久）／aborted（手動暫停）→ 不值得，照原失敗處理
function shouldResumeFallback(err) {
  return err?.claudeStatus === 'error';
}

// 跑一輪 coding。resume=true 用 coding-retry 短 prompt＋--resume 續用前一輪對話（省 token，健檢 U3）；
// 否則用 coding-project 全量 prompt。成功回傳 runClaude 的結果（含 sessionId），失敗 throw。
async function runCodingOnce(task, info, userId, signal, resolution, { resume }) {
  const cwd = worktreeParent(info.root, task.task_id);
  // 被下游退回重跑（resume，或帶著 retry_feedback）→ 升級 opus：同樣的腦袋再猜一次收斂率低，
  // 換更強的腦袋比無差別重跑 sonnet 更省 token 又提高收斂（健檢 F escalate）。
  const escalateModel = (resume || task.retry_feedback) ? 'opus' : null;
  if (resume) {
    const { gate, body } = distillFeedback(task.retry_feedback || '');
    const agent = loadAgent('coding-retry');
    const prompt = agent.render({
      gate,
      retry_feedback: body || '（無細節，請檢視上一輪自己的變更）',
      resolution: resolution || '（無）',
      commit_message: buildCommitMessage(task)
    }).trim();
    return runClaude(prompt, { cwd, taskId: task.id, userId, signal, model: escalateModel || agent.model, resumeSessionId: task.coding_session_id });
  }
  const built = buildCodingPrompt(task, info, resolution, task.retry_feedback || '');
  return runClaude(built.prompt, { cwd, taskId: task.id, userId, signal, model: escalateModel || built.model });
}

async function runTaskCoding(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, source, analysis_yaml, git_branch, project_id, retry_feedback, coding_session_id, coding_resume_count FROM tasks WHERE id = $1',
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

  const ref = { taskId: task.task_id, projectId: task.project_id };
  let raw;
  try {
    const resolution = await latestResolution(taskId);
    // coding_session_id 只在 fresh 成功後寫入 → 它存在＝前一輪 coding 成功過＝這次是被下游退回的重跑。
    // 觸發信號只認 retry_feedback：resolution（latestResolution）永不消費，用它當條件會讓過期舊指示誤觸發
    // resume（feedback 為空時帶著舊指示重跑，可能覆蓋已通過部分）。resolution 仍會在 resume prompt 帶入為輔助。
    const canResume = !!task.coding_session_id
      && (task.coding_resume_count || 0) < RESUME_LIMIT
      && !!task.retry_feedback;

    let codingResult;
    if (canResume) {
      try {
        codingResult = await runCodingOnce(task, info, userId, signal, resolution, { resume: true });
        // resume 成功：計數 +1；--resume 沿用同 session id（init 會回同一個）
        await query(
          'UPDATE tasks SET coding_resume_count = coding_resume_count + 1, coding_session_id = COALESCE($2, coding_session_id) WHERE id=$1',
          [taskId, codingResult.sessionId]
        );
      } catch (err) {
        if (!shouldResumeFallback(err)) throw err; // timeout/aborted → 不 fallback，交給外層 stopped
        // session 遺失／CLI 壞掉 → 記這次失敗帳，清 session 改跑全量 fresh（只 fallback 一次，不遞迴）。
        // 註：resume 失敗＋fresh 也失敗時，coding 會有 2 筆失敗記帳（各對應一次真實呼叫，刻意保留）。
        await logFailedUsage(ref, userId, 'coding', err);
        await query('UPDATE tasks SET coding_session_id=NULL, coding_resume_count=0 WHERE id=$1', [taskId]);
        task.coding_session_id = null;
        codingResult = await runCodingOnce(task, info, userId, signal, resolution, { resume: false });
        await query('UPDATE tasks SET coding_session_id=$2, coding_resume_count=0 WHERE id=$1', [taskId, codingResult.sessionId]);
      }
    } else {
      // fresh：首次／resume 用完（強制新世代）／無 feedback。全量 prompt 仍帶未蒸餾 retry_feedback。
      codingResult = await runCodingOnce(task, info, userId, signal, resolution, { resume: false });
      await query('UPDATE tasks SET coding_session_id=$2, coding_resume_count=0 WHERE id=$1', [taskId, codingResult.sessionId]);
    }

    raw = codingResult.text;
    // 執行成功才算消費、才清空；失敗/逾時/暫停保留給下一次重試，避免盲改（健檢止血 11）
    if (task.retry_feedback) await query('UPDATE tasks SET retry_feedback=NULL WHERE id=$1', [taskId]).catch(() => {});
    await logTokenUsage(ref, userId, 'coding', codingResult.usage, codingResult.durationMs);
  } catch (err) {
    await logFailedUsage(ref, userId, 'coding', err);
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, stopReason('實作 Agent 執行失敗', err)]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = await parseAgentResult(raw, { parse: JSON.parse, signal });
  if (result?.status === 'qa_running') {
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

module.exports = { runTaskAnalysis, runTaskCoding, getProjectInfo, worktreeParent, latestResolution, distillFeedback, shouldResumeFallback };
