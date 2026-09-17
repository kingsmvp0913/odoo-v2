// app/server/tests/ref-guard.test.js
// 意圖：AI 只准動本任務分支。改到 testing／main 的指標＝繞過審核直接進部署，必須還原並讓這一輪失敗。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const g = require('../lib/ref-guard');

let repo;
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'refguard-'));
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1'); git('add', 'a'); git('commit', '-q', '-m', 'base');
  git('branch', 'testing'); git('branch', 'task-1');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

test('只動本任務分支 → 沒有違規', async () => {
  const before = await g.snapshotRefs(repo, { execFile });
  git('checkout', '-q', 'task-1'); fs.writeFileSync(path.join(repo, 'a'), '2'); git('commit', '-q', '-am', 'work');
  const after = await g.snapshotRefs(repo, { execFile });
  expect(g.diffRefs(before, after, new Set(['refs/heads/task-1']))).toEqual([]);
});

test('改 testing 指標、新增分支 → 列為違規並能還原', async () => {
  const before = await g.snapshotRefs(repo, { execFile });
  const evil = git('commit-tree', '-m', 'evil', `${git('rev-parse', 'HEAD')}^{tree}`);
  git('update-ref', 'refs/heads/testing', evil);
  git('branch', 'sneaky');
  const after = await g.snapshotRefs(repo, { execFile });
  const v = g.diffRefs(before, after, new Set(['refs/heads/task-1']));
  expect(v.map(x => x.ref).sort()).toEqual(['refs/heads/sneaky', 'refs/heads/testing']);
  await g.restoreRefs(repo, v, { execFile });
  const restored = await g.snapshotRefs(repo, { execFile });
  expect(restored.get('refs/heads/testing')).toBe(before.get('refs/heads/testing'));
  expect(restored.has('refs/heads/sneaky')).toBe(false);
});
