const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { stripFence } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { mergeInto, commitResolved, abortMerge } = require('./git');
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

// 每個衝突 hunk 附帶的前後文行數：解衝突需要局部語境（import、所在 function），但不需要整份檔案
const CONFLICT_CTX_LINES = parseInt(process.env.MERGE_CONFLICT_CTX_LINES || '30', 10);

// 找出所有成對的 <<<<<<< … >>>>>>> 區塊（行號範圍，含頭尾標記行）
function findConflictBlocks(lines) {
  const blocks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<<')) start = i;
    else if (start !== -1 && lines[i].startsWith('>>>>>>>')) { blocks.push({ start, end: i }); start = -1; }
  }
  return blocks;
}

// 逐 hunk 解衝突：只把「衝突區塊±前後文」餵給 agent，不再整份檔案進 prompt——
// 大檔（長 view XML／大 model）整份進 prompt 是 merge 關卡最貴的單點，且要求 model
// 原樣回寫整檔也放大抄寫錯誤面。由後往前替換，前面 hunk 的行號不位移。
async function resolveConflict(repoPath, filePath, signal, opts = {}) {
  const fullPath = path.join(repoPath, filePath);
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return false;
  }
  if (!content.includes('<<<<<<<')) return true;

  const lines = content.split('\n');
  const blocks = findConflictBlocks(lines);
  if (!blocks.length) return false; // 有標記卻無成對區塊（畸形）→ 交人工

  const agent = loadAgent('merge');
  // 記帳歸屬只查一次（如今每 hunk 一次呼叫，避免重複查詢）
  let ref = null, refUser = null;
  if (opts.taskId) {
    const { rows: [t] } = await query('SELECT task_id, user_id, project_id FROM tasks WHERE id=$1', [opts.taskId]);
    if (t) { ref = { taskId: t.task_id, projectId: t.project_id }; refUser = t.user_id; }
  }

  for (let b = blocks.length - 1; b >= 0; b--) {
    const { start, end } = blocks[b];
    const prompt = agent.render({
      file_path: filePath,
      before_context: lines.slice(Math.max(0, start - CONFLICT_CTX_LINES), start).join('\n') || '（檔案開頭）',
      conflict_block: lines.slice(start, end + 1).join('\n'),
      after_context: lines.slice(end + 1, Math.min(lines.length, end + 1 + CONFLICT_CTX_LINES)).join('\n') || '（檔案結尾）'
    });
    let resolveResult;
    try {
      resolveResult = await runClaude(prompt, { ...opts, signal, model: agent.model, agentType: 'merge' });
    } catch (err) {
      if (ref) await logFailedUsage(ref, refUser, 'merge', err);
      throw err;
    }
    if (resolveResult.usage && ref) {
      await logTokenUsage(ref, refUser, 'merge', resolveResult.usage, resolveResult.durationMs);
    }
    // model 對「直接輸出內容」加 ``` fence 是高頻行為，不剝掉會把 fence 寫進檔案並 commit 進 testing
    const resolved = stripFence(resolveResult.text);
    if (!resolved || /^(<<<<<<<|=======|>>>>>>>)/m.test(resolved)) return false;
    lines.splice(start, end - start + 1, ...resolved.split('\n'));
  }

  fs.writeFileSync(fullPath, lines.join('\n'));
  return true;
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

// commit 進 testing 前驗 AI 解衝突結果的語法：.py→py_compile，.xml→xmllint。
// AI 常把縮排／語法解壞，產出「無衝突標記卻壞掉」的檔——直接 commit 進 testing 會讓
// deploy 升級以 IndentationError/ParseError 收場並誤歸因為程式問題。回傳語法壞掉的檔清單。
// 驗證工具本身不在環境（ENOENT）時略過該檔——無法驗 ≠ 壞，不因缺 linter 誤擋合併。
async function verifyResolvedSyntax(repoPath, files) {
  const bad = [];
  for (const f of files) {
    const abs = path.join(repoPath, f);
    if (!fs.existsSync(abs)) continue;
    try {
      if (f.endsWith('.py')) await execFileP('python', ['-m', 'py_compile', abs], { cwd: repoPath });
      else if (f.endsWith('.xml')) await execFileP('xmllint', ['--noout', abs], { cwd: repoPath });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      bad.push(f);
    }
  }
  return bad;
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

  // 主 clone 殘留 in-progress merge（MERGE_HEAD）防護：
  // - 同專案另有任務停在 merge_conflict ＝ 人工正在該 clone 上解衝突（mark-conflict-resolved 才會了結），
  //   此時進場 merge 必撞牆被誤標 stopped → 改為本輪不動作（狀態留 merge_running），等下一 tick 再試。
  // - 否則屬殘留（前一任務崩潰未清）→ abortMerge 自癒後繼續。
  for (const repo of repos) {
    if (!fs.existsSync(path.join(repo.local_path, '.git', 'MERGE_HEAD'))) continue;
    const { rows: [pending] } = await query(
      "SELECT 1 FROM tasks WHERE project_id=$1 AND status='merge_conflict' AND id<>$2 LIMIT 1",
      [task.project_id, taskId]
    );
    if (pending) {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] ${repo.label}：另一任務衝突待人工解決中，本輪暫緩併入\n` });
      return;
    }
    await abortMerge(repo.local_path).catch(() => {});
  }

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

    // commit 進 testing 前驗語法：AI 解衝突把縮排／語法解壞的檔不得進 testing（否則 deploy 才爆、
    // 又被誤歸因為程式問題）。壞檔改列入 failed 交人工，未 stage → 仍屬未解衝突，人工收尾能擋住。
    const resolvedFiles = mergeResult.conflictFiles.filter(f => !failed.includes(f));
    const badSyntax = await verifyResolvedSyntax(repo.local_path, resolvedFiles);
    for (const f of badSyntax) {
      failed.push(f);
      notify.emitToUser(userId, 'terminal:output', { taskId, data: `[MERGE] ${repo.label} 解衝突後語法仍壞（未通過 py_compile／xmllint），交人工: ${f}\n` });
    }

    if (failed.length === 0) {
      try {
        await commitResolved(repo.local_path, mergeResult.conflictFiles, `[merge] ${branch} → testing (resolve conflicts)`);
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

module.exports = { runMergeAgent, resolveConflict, verifyResolvedSyntax };
