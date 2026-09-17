// app/server/tests/safe-worktree-read.test.js
// 意圖（子專案 0 Task 3.14）：容器在任務 worktree 裡放的符號連結，平台事後在宿主讀檔／打包時
// 絕不能 follow——否則指向 data/config.json 之類宿主機密的連結會被讀出內容再回傳給使用者。
// 用真的暫存目錄與真的 symlink 驗證，不 mock fs：模擬層很容易「以為擋住了」而放過真正的 lstat 行為。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSafeRegularFileInside, readFileInside } = require('../lib/safe-worktree-read');

let root, outside;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swr-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swr-outside-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('一般檔案 → 通過', () => {
  fs.writeFileSync(path.join(root, 'a.py'), 'x');
  expect(isSafeRegularFileInside(path.join(root, 'a.py'), root)).toBe(true);
});

test('指向 root 外的 symlink → 拒絕（即使 target 存在且可讀）', () => {
  const secret = path.join(outside, 'config.json');
  fs.writeFileSync(secret, '{"APP_SECRET":"top-secret"}');
  const link = path.join(root, 'leak.json');
  fs.symlinkSync(secret, link);
  expect(isSafeRegularFileInside(link, root)).toBe(false);
});

test('指向 root 內另一個檔案的 symlink → 也拒絕（不 follow 任何 symlink）', () => {
  fs.writeFileSync(path.join(root, 'real.py'), 'x');
  const link = path.join(root, 'alias.py');
  fs.symlinkSync(path.join(root, 'real.py'), link);
  expect(isSafeRegularFileInside(link, root)).toBe(false);
});

test('rel 帶 `..` 逃出 root → 拒絕', () => {
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  const escaped = path.join(root, '..', path.basename(outside), 'secret.txt');
  expect(isSafeRegularFileInside(escaped, root)).toBe(false);
});

test('目錄 → 拒絕', () => {
  const dir = path.join(root, 'sub');
  fs.mkdirSync(dir);
  expect(isSafeRegularFileInside(dir, root)).toBe(false);
});

test('不存在的檔案 → 拒絕（不丟例外）', () => {
  expect(isSafeRegularFileInside(path.join(root, 'nope.py'), root)).toBe(false);
});

describe('readFileInside', () => {
  test('一般檔案 → 回傳內容', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    await expect(readFileInside(root, 'a.txt', 'utf8')).resolves.toBe('hello');
  });

  test('symlink 指到 root 外 → 丟例外，不讀出內容', async () => {
    const secret = path.join(outside, 'config.json');
    fs.writeFileSync(secret, '{"APP_SECRET":"top-secret"}');
    fs.symlinkSync(secret, path.join(root, 'leak.json'));
    await expect(readFileInside(root, 'leak.json', 'utf8')).rejects.toThrow(/拒絕讀取/);
  });

  test('rel 帶 `..` → 丟例外', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    await expect(readFileInside(root, path.join('..', path.basename(outside), 'secret.txt'), 'utf8'))
      .rejects.toThrow(/拒絕讀取/);
  });
});
