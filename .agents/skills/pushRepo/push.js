#!/usr/bin/env node
// 用平台儲存的 per-user GitHub PAT push，免去每次重摸 buildGitEnv／DATABASE_URL／APP_SECRET。
// PAT 只注入該次 git 子行程（git-identity.buildGitEnv：清 credential.helper＋GIT_TERMINAL_PROMPT=0，
// 不寫進共用 clone 設定）。
//
// 用法: node push.js [--repo <path>] [--branch <name>] [--remote origin] [--user <id>]
//   預設 repo=$APP_DIR 或 /home/odoo/odoo-v2；branch=當前分支；remote=origin；user=2（kingsmvp2）
//
// DATABASE_URL＋APP_SECRET（buildGitEnv 連平台 DB 取 PAT、crypto 解密用）依序取自：
//   process.env → <repo>/data/config.json → 平台 server 進程（pgrep app/server/index.js，pid 會變故動態找）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const repo = path.resolve(arg('repo', process.env.APP_DIR || '/home/odoo/odoo-v2'));
const remote = arg('remote', 'origin');
const userId = parseInt(arg('user', '2'), 10);

function need() { return !process.env.DATABASE_URL || !process.env.APP_SECRET; }
function ensurePlatformEnv() {
  if (!need()) return;
  // 1) data/config.json（穩定來源，不依賴 server 在跑）
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'data', 'config.json'), 'utf8'));
    process.env.DATABASE_URL = process.env.DATABASE_URL || cfg.DATABASE_URL;
    process.env.APP_SECRET = process.env.APP_SECRET || cfg.APP_SECRET;
  } catch { /* 沒有就往下退 */ }
  if (!need()) return;
  // 2) 退路：從平台 server 進程繼承（pid 會變，動態找）
  try {
    const pid = execFileSync('pgrep', ['-f', 'app/server/index.js'], { encoding: 'utf8' }).trim().split('\n')[0];
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const j = kv.indexOf('=');
      if (j < 0) continue;
      const k = kv.slice(0, j);
      if ((k === 'DATABASE_URL' || k === 'APP_SECRET') && !process.env[k]) process.env[k] = kv.slice(j + 1);
    }
  } catch { /* 進程不在就算了，下面 fail loud */ }
}

ensurePlatformEnv();
if (!process.env.DATABASE_URL) { console.error('[push] 缺 DATABASE_URL（找不到平台 DB 連線；試 --repo 指到含 data/config.json 的 repo）'); process.exit(1); }

const { buildGitEnv } = require(path.join(repo, 'app/server/lib/git-identity'));

(async () => {
  const branch = arg('branch', execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim());
  const gitEnv = await buildGitEnv(userId); // 無 PAT → NoGitCredentialError
  execFileSync('git', ['-C', repo, 'push', remote, branch], { env: { ...process.env, ...gitEnv }, stdio: 'inherit' });
  console.log(`[push] OK → ${remote} ${branch}`);
})().catch(e => { console.error('[push] FAIL:', e.message); process.exit(1); });
