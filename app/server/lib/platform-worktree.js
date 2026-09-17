/**
 * platform-worktree.js — 內部 AI（健檢、審碼、統整）看平台碼用的乾淨唯讀 worktree（子專案 0 §4.5；總覽 D7）
 * detached HEAD、只含 tracked 檔；容器唯讀掛入；執行結束即刪。與 nightly 的 fix-* 同一個根目錄，名字以 ro- 區分。
 */
const fs = require('fs');
const path = require('path');
const { execFile: realExecFile } = require('child_process');

const PLATFORM_RO_PREFIX = 'ro-';
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function worktreeRootFor(repoRoot) {
  return process.env.FIX_WORKTREE_DIR || path.join(repoRoot, '.claude', 'worktrees');
}

function git(execFile, cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { message: `${err.message}\n${stderr || ''}`.trim() }));
      resolve(String(stdout || ''));
    });
  });
}

function assertOwned(wt, root) {
  const rel = path.relative(root, wt);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || !rel.startsWith(PLATFORM_RO_PREFIX)) {
    throw new Error(`拒絕移除：${wt} 不是 ${root}/${PLATFORM_RO_PREFIX}*`);
  }
}

async function createPlatformCleanWorktree(runId, deps = {}) {
  const repoRoot = deps.repoRoot || DEFAULT_REPO_ROOT;
  const execFile = deps.execFile || realExecFile;
  if (!/^[a-f0-9]+$/.test(String(runId))) throw new Error(`runId 不合法：${runId}`);
  const root = worktreeRootFor(repoRoot);
  fs.mkdirSync(root, { recursive: true });
  const wt = path.join(root, `${PLATFORM_RO_PREFIX}${runId}`);
  await git(execFile, repoRoot, ['worktree', 'add', '--detach', wt, 'HEAD']);
  return wt;
}

async function removePlatformCleanWorktree(wt, deps = {}) {
  const repoRoot = deps.repoRoot || DEFAULT_REPO_ROOT;
  const execFile = deps.execFile || realExecFile;
  assertOwned(wt, worktreeRootFor(repoRoot));
  try { await git(execFile, repoRoot, ['worktree', 'remove', '--force', wt]); }
  catch {
    await git(execFile, repoRoot, ['worktree', 'prune']).catch(() => {});
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

async function removeStalePlatformWorktrees(deps = {}) {
  const repoRoot = deps.repoRoot || DEFAULT_REPO_ROOT;
  const root = worktreeRootFor(repoRoot);
  let names = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  let n = 0;
  for (const name of names.filter(x => x.startsWith(PLATFORM_RO_PREFIX))) {
    await removePlatformCleanWorktree(path.join(root, name), deps);
    n++;
  }
  return n;
}

module.exports = { PLATFORM_RO_PREFIX, worktreeRootFor, createPlatformCleanWorktree, removePlatformCleanWorktree, removeStalePlatformWorktrees };
