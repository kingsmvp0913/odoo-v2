const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../db');
const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildGitEnv } = require('../lib/git-identity');

const execFileAsync = promisify(execFile);

/**
 * finding-fix.js — 健檢提案的「修這條」
 *
 * 平台自己的修正**不走客戶任務那條 pipeline**：那 15 關有一半是為客戶的 Odoo 設計的（裝模組、
 * 開測試區、跑畫面測試），對 Node 平台碼完全用不上；而且 agent-loader 會把 CLAUDE.md 的 Odoo
 * 開發規則整份注入 analysis／coding，拿去指導改 app/server 是系統性誤導。
 *
 * 這裡是最小可行的替代：獨立工作區改碼 → 自己跑測試 → **逐檔檢查動到哪裡** → diff 給人審 →
 * 人點頭才提交 → 再按一次才推上 GitHub。三段分開，任何一段都可以停在那裡不往前。
 *
 * ⚠ 這是「平台自己改自己」。最陰險的失敗方式是把測試改成永遠通過、或放寬健檢自己的判準——
 * 兩者在指標上都看不出異常。所以範圍檢查寫在**程式裡**（下面的 ALLOW／DENY），不是只寫在提示詞
 * 裡靠 agent 自律：提示詞是請求，程式檢查才是防線。
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const WORKTREE_ROOT = process.env.FIX_WORKTREE_DIR || path.join(REPO_ROOT, '.claude', 'worktrees');

// 可以動的路徑（POSIX 斜線比對）
const ALLOW = [
  /^app\/server\//,
  /^app\/public\//,
  /^\.claude\/agents\/[^/]+\.md$/,
];
// 一律不准動，優先於 ALLOW
const DENY = [
  { re: /^\.claude\/agents\/health-/, why: '健檢自己的提示詞（放寬自己的判準不會有任何訊號）' },
  { re: /^\.claude\/skills\/healthCheck\//, why: '健檢判準（同上）' },
];

// git status --porcelain 的一行 → { code, file }。重新命名（R）會有 "old -> new"，取新的那個。
function parseStatusLine(line) {
  const code = line.slice(0, 2);
  let file = line.slice(3).trim();
  const arrow = file.indexOf(' -> ');
  if (arrow !== -1) file = file.slice(arrow + 4);
  return { code, file: file.replace(/^"|"$/g, '') };
}

/**
 * 逐檔裁決。回傳 { files, violations }。
 * 既有測試檔只能新增不能改：`??`（未追蹤）與 `A`（已加入索引）算新增，其餘（M／D／R）算修改。
 */
function classifyChanges(porcelain) {
  const files = [];
  const violations = [];
  for (const raw of String(porcelain || '').split('\n')) {
    if (!raw.trim()) continue;
    const { code, file } = parseStatusLine(raw);
    files.push(file);
    const denied = DENY.find(d => d.re.test(file));
    if (denied) { violations.push(`${file}：${denied.why}`); continue; }
    if (/^app\/server\/tests\//.test(file)) {
      const isNew = code.trim() === '??' || code[0] === 'A';
      if (!isNew) violations.push(`${file}：不得修改或刪除既有測試（新增可以）`);
      continue;
    }
    if (!ALLOW.some(re => re.test(file))) violations.push(`${file}：超出可修改範圍`);
  }
  return { files, violations };
}

const git = (cwd, args, opts = {}) =>
  execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, ...opts });

async function setStatus(fixId, status, extra = {}) {
  const cols = Object.keys(extra);
  const set = ['status=$2', ...cols.map((c, i) => `${c}=$${i + 3}`)].join(', ');
  await query(
    `UPDATE finding_fixes SET ${set}, finished_at = CASE WHEN $2='running' THEN NULL ELSE NOW() END WHERE id=$1`,
    [fixId, status, ...cols.map(c => extra[c])]
  );
}

// 工作區的 node_modules 走 junction 指回主 repo：新開的 worktree 沒有相依，測試根本跑不起來，
// 而重裝一份要好幾分鐘也佔幾百 MB。Windows 的 directory junction 不需要管理員權限。
// 清理時**先手動移除這個連結再刪工作區**——讓 git 去刪一個指向主 repo 的連結太危險。
function linkNodeModules(worktree) {
  const target = path.join(REPO_ROOT, 'app', 'node_modules');
  const link = path.join(worktree, 'app', 'node_modules');
  if (!fs.existsSync(target) || fs.existsSync(link)) return;
  try { fs.symlinkSync(target, link, 'junction'); }
  catch (err) { console.error('[FIX] node_modules link:', err.message); }
}

function unlinkNodeModules(worktree) {
  const link = path.join(worktree, 'app', 'node_modules');
  try {
    if (!fs.existsSync(link)) return;
    // 不用 recursive：對 junction 而言那會是「跟著連結刪到主 repo 的相依」。
    fs.rmSync(link, { recursive: false, force: true });
  } catch {
    try { fs.unlinkSync(link); } catch (err) { console.error('[FIX] unlink node_modules:', err.message); }
  }
}

async function removeWorktree(worktree) {
  if (!worktree) return;
  unlinkNodeModules(worktree);
  await git(REPO_ROOT, ['worktree', 'remove', '--force', worktree]).catch(err =>
    console.error('[FIX] worktree remove:', err.message));
}

/**
 * 跑一次修正嘗試（fire-and-forget，比照健檢）。
 */
async function runFix(fixId, { findingId, startedBy = null } = {}) {
  let worktree = null;
  try {
    const { rows: [f] } = await query(
      `SELECT id, agent_label, diagnosis, rationale, layer, evidence, target_metric, metric_baseline
         FROM health_check_findings WHERE id=$1`, [findingId]);
    if (!f) return setStatus(fixId, 'failed', { reject_reason: '提案不存在' });

    const branch = `fix/finding-${findingId}-${fixId}`;
    worktree = path.join(WORKTREE_ROOT, `fix-${fixId}`);
    fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
    // 從 HEAD 長出獨立分支：主 checkout 常有別股平行工作的未提交變更，絕不能在那上面動手。
    await git(REPO_ROOT, ['worktree', 'add', '-B', branch, worktree, 'HEAD']);
    await setStatus(fixId, 'running', { branch, worktree });
    linkNodeModules(worktree);

    const agent = loadAgent('platform-fix');
    const prompt = agent.render({
      title: f.agent_label || '(無標題)',
      layer: f.layer || '未分類',
      detail: f.diagnosis || '',
      evidence: f.evidence || '（無）',
      action: f.rationale || '（未提供）',
      target_metric: f.target_metric || '（未填）',
      metric_baseline: f.metric_baseline || '—'
    });

    let text = '';
    try {
      const r = await runClaude(prompt, { model: agent.model, agentType: 'platform_fix', cwd: worktree });
      text = r.text;
      await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'platform_fix', r.usage, r.durationMs);
    } catch (err) {
      await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'platform_fix', err);
      await removeWorktree(worktree);
      return setStatus(fixId, 'failed', { reject_reason: `執行失敗：${err.message}`, worktree: null });
    }

    const { inner: notesBlock, cleaned } = extractTaggedBlock(text, 'notes');
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
    const notes = (notesBlock || '').trim() || (parsed && parsed.notes) || '';
    const tests = String((parsed && parsed.tests) || '').trim().toLowerCase();

    const { stdout: porcelain } = await git(worktree, ['status', '--porcelain', '-uall']);
    const { files, violations } = classifyChanges(porcelain);

    // 什麼都沒改是合法結果——提示詞明說「認為不該做就不要硬做」。工作區沒有價值，直接收掉。
    if (!files.length) {
      await removeWorktree(worktree);
      return setStatus(fixId, 'no_change', { notes, test_result: tests || 'skip', worktree: null });
    }
    // 超出範圍：整份作廢。留著 notes 讓人看得到它想幹嘛，但工作區收掉，避免半套改動被誤採用。
    if (violations.length) {
      await removeWorktree(worktree);
      return setStatus(fixId, 'rejected', {
        notes, test_result: tests || 'skip', worktree: null,
        reject_reason: `動到不該動的檔案：\n${violations.join('\n')}`
      });
    }

    // 全部收進索引再取 diff：未追蹤的新檔（新增的測試、新模組）不進索引就不會出現在 diff 裡，
    // 人會以為那些檔案不存在。commit 也用同一批。
    await git(worktree, ['add', '-A']);
    const { stdout: diff } = await git(worktree, ['diff', '--cached']);
    await setStatus(fixId, 'ready', { notes, test_result: tests || 'unknown', diff });
  } catch (err) {
    console.error('[FIX]', err.message);
    await removeWorktree(worktree).catch(() => {});
    await setStatus(fixId, 'failed', { reject_reason: err.message, worktree: null }).catch(() => {});
  }
}

// 採用＝在該分支上提交。刻意**不**併回 master：主 checkout 常有別股平行工作，替他們決定要不要
// 合併不是這支功能的職責。提交完工作區就可以收掉，分支留著（推上去或人工合併都行）。
async function adoptFix(fixId, userId) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  if (fix.status !== 'ready') throw new Error(`此狀態不能採用：${fix.status}`);
  const { rows: [f] } = await query('SELECT agent_label FROM health_check_findings WHERE id=$1', [fix.finding_id]);
  const gitEnv = await buildGitEnv(userId).catch(() => ({}));
  const msg = `[Health]: ${(f && f.agent_label) || '健檢提案'}\n\n依系統健檢提案 #${fix.finding_id} 修正。`;
  await git(fix.worktree, ['commit', '-m', msg], { env: { ...process.env, ...gitEnv } });
  const { stdout: sha } = await git(fix.worktree, ['rev-parse', 'HEAD']);
  await removeWorktree(fix.worktree);
  await setStatus(fixId, 'adopted', { commit_sha: sha.trim(), worktree: null });
  return { branch: fix.branch, commit: sha.trim() };
}

// 推上 GitHub 是**另外一顆按鈕**：採用（進本機分支）與公開（進 origin）是兩個不同的決定。
// 推的是分支不是 master——要不要併進 master 由人在 GitHub 上決定。
async function pushFix(fixId, userId) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  if (fix.status !== 'adopted') throw new Error(`此狀態不能推送：${fix.status}`);
  const gitEnv = await buildGitEnv(userId);
  await git(REPO_ROOT, ['push', 'origin', fix.branch], { env: { ...process.env, ...gitEnv } });
  await setStatus(fixId, 'pushed');
  return { branch: fix.branch };
}

async function discardFix(fixId) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  await removeWorktree(fix.worktree);
  if (fix.branch) await git(REPO_ROOT, ['branch', '-D', fix.branch]).catch(() => {});
  await setStatus(fixId, 'failed', { reject_reason: '已由人工捨棄', worktree: null });
}

module.exports = { runFix, adoptFix, pushFix, discardFix, classifyChanges };
