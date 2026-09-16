// 意圖：容器可寫主 clone 的 .git（commit 要寫 objects），唯一擋住「在 hooks 放腳本、等平台在主機跑 git 時執行」
// 的是 config／hooks 唯讀掛載；這裡是第二道：平台自己跑的 git 根本不執行 hook。用真的 git 驗，
// 並先證明「不加固時 hook 確實會跑」，否則這個測試永遠綠也證明不了什麼。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { hardenGitEnv, HARDEN_PAIRS } = require('../lib/git-hardening');

function repoWithHook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-harden-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const marker = path.join(dir, 'hook-ran');
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  return { dir, marker };
}
const commit = (dir, env) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: dir, env });

test('對照組：不加固時 hook 會執行（證明測試有鑑別力）', () => {
  const { dir, marker } = repoWithHook();
  const env = { ...process.env }; delete env.GIT_CONFIG_COUNT;
  commit(dir, env);
  expect(fs.existsSync(marker)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加固後 hook 不執行', () => {
  const { dir, marker } = repoWithHook();
  const env = { ...process.env }; delete env.GIT_CONFIG_COUNT;
  commit(dir, hardenGitEnv(env));
  expect(fs.existsSync(marker)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('保留既有的 GIT_CONFIG_* 設定，接在後面追加', () => {
  const out = hardenGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
  expect(out.GIT_CONFIG_COUNT).toBe(String(1 + HARDEN_PAIRS.length));
  expect(out.GIT_CONFIG_KEY_0).toBe('credential.helper');
  expect(out.GIT_CONFIG_KEY_1).toBe('core.hooksPath');
  expect(out.GIT_CONFIG_VALUE_1).toBe('/dev/null');
  expect(out.GIT_CONFIG_KEY_2).toBe('core.fsmonitor');
  expect(out.GIT_CONFIG_VALUE_2).toBe('false');
});

test('冪等：已加固過的 env 再套一次不重複追加', () => {
  const once = hardenGitEnv({});
  expect(hardenGitEnv(once)).toEqual(once);
});
