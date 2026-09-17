// app/server/tests/platform-worktree.test.js
// 意圖：內部 AI 看平台碼只能看「git 裡有的檔」，不能看到工作目錄裡沒進版控的祕密（data/config.json）。
// 用真的暫存 git repo 驗：worktree 裡沒有 untracked 檔、刪除只動 ro-* 不會誤刪 nightly 的 fix-*。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const pw = require('../lib/platform-worktree');

let repo;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-wt-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'tracked.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(repo, 'data'));
  fs.writeFileSync(path.join(repo, 'data', 'config.json'), '{"APP_SECRET":"leak"}');
  fs.writeFileSync(path.join(repo, '.gitignore'), '/data/config.json\n');
  execFileSync('git', ['add', 'tracked.js', '.gitignore'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
const deps = () => ({ repoRoot: repo, execFile });

test('建出的 worktree 只有 tracked 檔，沒有 data/config.json', async () => {
  const wt = await pw.createPlatformCleanWorktree('abc123', deps());
  expect(wt).toBe(path.join(pw.worktreeRootFor(repo), 'ro-abc123'));
  expect(fs.existsSync(path.join(wt, 'tracked.js'))).toBe(true);
  expect(fs.existsSync(path.join(wt, 'data', 'config.json'))).toBe(false);
  await pw.removePlatformCleanWorktree(wt, deps());
  expect(fs.existsSync(wt)).toBe(false);
  expect(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })).not.toContain('ro-abc123');
});

test('runId 不是 hex → 丟例外（名字會進路徑）', async () => {
  await expect(pw.createPlatformCleanWorktree('../x', deps())).rejects.toThrow();
});

test('移除非 ro-* 或不在 worktree 根目錄底下的路徑 → 丟例外（不誤刪 nightly 的 fix-*）', async () => {
  const fix = path.join(pw.worktreeRootFor(repo), 'fix-9');
  fs.mkdirSync(fix, { recursive: true });
  await expect(pw.removePlatformCleanWorktree(fix, deps())).rejects.toThrow();
  await expect(pw.removePlatformCleanWorktree(repo, deps())).rejects.toThrow();
  expect(fs.existsSync(fix)).toBe(true);
});

test('啟動清殘留：只清 ro-*', async () => {
  await pw.createPlatformCleanWorktree('dead01', deps());
  await pw.createPlatformCleanWorktree('dead02', deps());
  const n = await pw.removeStalePlatformWorktrees(deps());
  expect(n).toBe(2);
  const left = fs.readdirSync(pw.worktreeRootFor(repo));
  expect(left).toContain('fix-9');
  expect(left.filter(x => x.startsWith('ro-'))).toEqual([]);
});
