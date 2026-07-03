const path = require('path');
const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');
const { logTokenUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');

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

function parseResult(text) {
  const OPEN = '---RESULT-JSON---';
  const CLOSE = '---END-RESULT---';
  const start = text.lastIndexOf(OPEN);
  if (start === -1) return null;
  const end = text.lastIndexOf(CLOSE);
  const jsonStr = (end !== -1 ? text.slice(start + OPEN.length, end) : text.slice(start + OPEN.length)).trim();
  try { return JSON.parse(jsonStr); } catch { return null; }
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

function spawnClaude(prompt, { cwd, taskId, userId, timeoutMs = 600000, signal, model }) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let resultText = '', stderr = '', done = false;
    let usage = null, durationMs = null, lineBuffer = '';

    const timer = setTimeout(() => {
      if (!done) { child.kill(); reject(new Error('claude subprocess timed out')); }
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        if (!done) { clearTimeout(timer); done = true; child.kill('SIGTERM'); reject(new Error('aborted')); }
      }, { once: true });
    }

    child.stdout.on('data', d => {
      lineBuffer += d.toString();
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl).trim();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message?.content) {
            let out = '';
            for (const blk of ev.message.content) {
              if (blk.type === 'text') out += blk.text;
            }
            if (out && taskId && userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: out });
          }
          if (ev.type === 'result') {
            resultText = ev.result || resultText;
            usage      = ev.usage       || null;
            durationMs = ev.duration_ms || null;
          }
        } catch {
          if (taskId && userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: line + '\n' });
        }
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdin.write(prompt);
    child.stdin.end();

    child.on('close', code => {
      clearTimeout(timer);
      done = true;
      if (taskId && userId) notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      if (code !== 0 && code !== null) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      else resolve({ text: resultText.trim(), usage, durationMs });
    });
    child.on('error', err => { clearTimeout(timer); done = true; reject(err); });
  });
}

function buildAnalysisPrompt(task, info) {
  const agent = loadAgent('analysis-project');
  return {
    prompt: agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      original_text: task.original_text || '（無內容）',
      task_id: task.task_id
    }).trim(),
    model: agent.model
  };
}

function buildCodingPrompt(task, info) {
  const agent = loadAgent('coding-project');
  const repoList = (info.repos || []).map(r => `- ${r.subdir}/`).join('\n') || '（無 repo）';
  return {
    prompt: agent.render({
      project_name: info.name,
      odoo_version: info.odoo_version,
      git_branch: task.git_branch || '（未設定）',
      analysis_yaml: task.analysis_yaml || '（無規格）',
      commit_message: buildCommitMessage(task),
      repo_list: repoList
    }).trim(),
    model: agent.model
  };
}

async function runTaskAnalysis(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, original_text, project_id FROM tasks WHERE id = $1',
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

  let raw;
  try {
    const built = buildAnalysisPrompt(task, info);
    // analysis 在專案根讀取所有 repo（此時尚未建 worktree）
    const analysisResult = await spawnClaude(built.prompt, { cwd: info.root, taskId, userId, signal, model: built.model });
    raw = analysisResult.text;
    await logTokenUsage({ taskId: task.task_id }, userId, 'analysis', analysisResult.usage, analysisResult.durationMs);
  } catch (err) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `分析 Agent 執行失敗：${err.message}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = parseResult(raw);

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

  const nextStatus = ['branch_pending', 'confirm_pending'].includes(result.status) ? result.status : 'branch_pending';
  await query(
    `UPDATE tasks SET status=$2, analysis_yaml=$3, updated_at=NOW() WHERE id=$1`,
    [taskId, nextStatus, result.analysis_yaml]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  return true;
}

async function runTaskCoding(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, source, analysis_yaml, git_branch, project_id FROM tasks WHERE id = $1',
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

  let raw;
  try {
    const built = buildCodingPrompt(task, info);
    // coding 在任務 worktree 父目錄操作（跨所有 repo 子目錄）
    const codingResult = await spawnClaude(built.prompt, { cwd: worktreeParent(info.root, task.task_id), taskId, userId, signal, model: built.model });
    raw = codingResult.text;
    await logTokenUsage({ taskId: task.task_id }, userId, 'coding', codingResult.usage, codingResult.durationMs);
  } catch (err) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `實作 Agent 執行失敗：${err.message}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = parseResult(raw);
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

module.exports = { runTaskAnalysis, runTaskCoding };
