// scripts/lib/rtk.js — 安裝 rtk（Rust Token Killer）。
// 它是 ~/.claude/settings.json 那條 PreToolUse hook 實際要跑的指令：沒有它，之後每一次
// Bash 呼叫都會去跑一個不存在的執行檔。裝不起來不中斷安裝——接手包會偵測到它不在而略過 hook。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync: realExecFileSync } = require('child_process');

const REPO_URL = 'https://github.com/rtk-ai/rtk';
const RELEASE_BASE = `${REPO_URL}/releases/latest/download`;
// 官方 release 的 tarball 檔名不帶版本號，所以可以固定指向 latest。
const ASSETS = {
  'linux-x64': 'rtk-x86_64-unknown-linux-musl.tar.gz',
  'linux-arm64': 'rtk-aarch64-unknown-linux-gnu.tar.gz',
  'darwin-x64': 'rtk-x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'rtk-aarch64-apple-darwin.tar.gz',
};

function assetFor(platform, arch) {
  return ASSETS[`${platform}-${arch}`] || null;
}

function ensureRtk(deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const home = deps.home || os.homedir();
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const chmodSync = deps.chmodSync || fs.chmodSync;

  try {
    // 同名不同物：reachingforthejack/rtk（Rust Type Kit）沒有 gain 子指令。認錯了之後每次
    // Bash 呼叫都會被 hook 打成錯誤，所以這裡用 gain 當身分驗證，不是只看 rtk 在不在。
    execFileSync('rtk', ['gain'], { stdio: 'pipe' });
    return { name: 'rtk', status: 'skipped', detail: '已安裝' };
  } catch {
    /* 往下裝 */
  }

  const asset = assetFor(platform, arch);
  if (!asset) {
    return { name: 'rtk', status: 'skipped', detail: `${platform}-${arch} 無官方預編譯檔，請自行安裝：${REPO_URL}` };
  }

  const binDir = path.join(home, '.local', 'bin');
  try {
    mkdirSync(binDir, { recursive: true });
    // set -o pipefail：curl 失敗時若不設，tar 讀到空輸入仍會回 0，會裝出一個「成功但沒有檔案」的假象。
    execFileSync('bash', ['-c', `set -o pipefail; curl -fsSL ${RELEASE_BASE}/${asset} | tar -xz -C '${binDir}' rtk`], { stdio: 'pipe' });
    chmodSync(path.join(binDir, 'rtk'), 0o755);
    return { name: 'rtk', status: 'done', detail: `${path.join(binDir, 'rtk')}（確認 ~/.local/bin 在 PATH 內）` };
  } catch (err) {
    return { name: 'rtk', status: 'failed', detail: `安裝失敗（${err.message}）。手動裝：${REPO_URL}；未裝時 Bash hook 會自動略過` };
  }
}

module.exports = { ensureRtk, assetFor, ASSETS, REPO_URL };
