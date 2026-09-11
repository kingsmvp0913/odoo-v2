// 意圖：共用 checkout 上用「私有 GIT_INDEX_FILE」提交（避免夾帶別人暫存的檔），最後漏了同步共用
// index 那一步，git status 就會出現一批「已暫存」——其實只是 index 還停在提交前的那棵樹，工作區內容
// 早就跟 HEAD 一模一樣。applyFix 把它當成「有人 git add 了東西」而拒絕合併，2026-09-11 實際卡住兩條
// 已修好、已過審的修正整晚沒併進去。
// 這支用**真的 git** 照那份做法重現一次（mock 出來的 status 證明不了 git 真的會長這樣），釘住兩件事：
// 殘影要能自己清掉；真的有人暫存的東西一個都不能碰。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: async () => ({}) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const { resyncGhostStaged } = require('../pipeline/finding-fix');

// 這台沒有全域 git identity，commit 要自己帶
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
let repo;
const g = (args, env = ENV) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
const write = (f, s) => fs.writeFileSync(path.join(repo, f), s);
const read = f => fs.readFileSync(path.join(repo, f), 'utf8');
const stagedFiles = () => g(['status', '--porcelain', '-uno']).split('\n')
  .filter(l => l.length > 3 && l[0] !== ' ' && l[0] !== '?')
  .map(l => l.slice(3)).sort();

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostidx-'));
  g(['init', '-q']);
  write('keep.txt', 'v1\n');
  write('gone.txt', 'bye\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

// 照私有 index 的提交做法走一遍，刻意漏掉最後的 `git reset`。改、增、刪三種形狀各一個——
// 2026-09-11 那次正好三種都有（package.json 改、jest.setup.js 增），刪的形狀 git status 又長得不一樣。
function commitViaPrivateIndexWithoutResync() {
  write('keep.txt', 'v2\n');
  write('new.txt', 'hello\n');
  fs.unlinkSync(path.join(repo, 'gone.txt'));
  const env = { ...ENV, GIT_INDEX_FILE: path.join(repo, '.git', 'private-index') };
  g(['read-tree', 'HEAD'], env);
  g(['add', '--', 'keep.txt', 'new.txt', 'gone.txt'], env);
  const tree = g(['write-tree'], env).trim();
  const parent = g(['rev-parse', 'HEAD']).trim();
  const commit = g(['commit-tree', tree, '-p', parent, '-m', 'private'], env).trim();
  const branch = g(['symbolic-ref', 'HEAD']).trim();
  g(['update-ref', branch, commit]);
}

test('私有 index 提交漏了同步：改／增／刪三種殘影都自己清掉，檔案內容一個字不動', async () => {
  commitViaPrivateIndexWithoutResync();
  // 前提：真的重現出「看起來有人暫存了三個檔」——這一行不成立的話，下面全綠也證明不了什麼
  expect(stagedFiles()).toEqual(['gone.txt', 'keep.txt', 'new.txt']);

  const real = await resyncGhostStaged(repo, stagedFiles());

  expect(real).toEqual([]);
  expect(stagedFiles()).toEqual([]);
  expect(read('keep.txt')).toBe('v2\n');
  expect(read('new.txt')).toBe('hello\n');
  expect(fs.existsSync(path.join(repo, 'gone.txt'))).toBe(false);
});

test('混著真的暫存改動：只點名真的那個，而且整個暫存區都不動（不是清掉殘影、留下真的）', async () => {
  commitViaPrivateIndexWithoutResync();
  write('work.txt', 'someone is working\n');
  g(['add', '--', 'work.txt']);
  const before = g(['status', '--porcelain', '-uno']);

  const real = await resyncGhostStaged(repo, stagedFiles());

  expect(real).toEqual(['work.txt']);
  // 不往下合併就不該有副作用：暫存區是別人的現場，停手時原樣留給人看
  expect(g(['status', '--porcelain', '-uno'])).toBe(before);
});

test('暫存後工作區又改了（MM 但內容≠HEAD）是真的改動，不能當殘影清掉', async () => {
  write('keep.txt', 'staged\n');
  g(['add', '--', 'keep.txt']);
  write('keep.txt', 'staged then edited\n');

  const real = await resyncGhostStaged(repo, stagedFiles());

  expect(real).toEqual(['keep.txt']);
  expect(stagedFiles()).toEqual(['keep.txt']);
});
