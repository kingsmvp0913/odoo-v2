#!/usr/bin/env node
// 用平台儲存的 per-user GitHub PAT push，免去每次重摸 buildGitEnv／DATABASE_URL／APP_SECRET。
// PAT 只注入該次 git 子行程（git-identity.buildGitEnv：清 credential.helper＋GIT_TERMINAL_PROMPT=0，
// 不寫進共用 clone 設定）。
//
// 用法: node push.js [--repo <path>] [--branch <name>] [--remote origin] [--user <id>]
//   預設 repo=$APP_DIR 或 /home/odoo/odoo-v2；branch=當前分支；remote=origin
//   --user 未帶時取管理頁「CLI 推送身分」（teams_settings.cli_push_user_id）；那也沒設就
//   列出可用帳號並中止。刻意不寫死預設 id——本機與正式機各有各的 users 表，寫死任何一個
//   數字都會在另一邊指到不存在的人，而 NoGitCredentialError 讀起來像「這個人沒設 PAT」。
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
const userArg = arg('user', null);

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

// 沒帶 --user 時的身分來源：管理頁「CLI 推送身分」。找不到就把可用帳號列出來——
// 這裡 fail loud 比猜一個 id 好：猜錯拿到的錯誤訊息指向的是「PAT 沒設」，不是真因。
async function resolveUserId() {
  const { query } = require(path.join(repo, 'app/server/db'));
  const { rows } = await query('SELECT cli_push_user_id FROM teams_settings WHERE id = 1');
  if (rows[0] && rows[0].cli_push_user_id) return rows[0].cli_push_user_id;
  const { rows: users } = await query(
    `SELECT id, username, (github_pat_enc IS NOT NULL AND github_pat_enc <> '') AS has_pat
     FROM users ORDER BY id ASC`
  );
  const list = users.map(u => `  --user ${u.id}\t${u.username}${u.has_pat ? '' : '（未設 PAT，選了會失敗）'}`).join('\n');
  throw new Error(`未指定 --user，管理頁也沒設「CLI 推送身分」。可用帳號：\n${list || '  （users 表是空的）'}`);
}

(async () => {
  const branch = arg('branch', execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim());
  const userId = userArg != null ? parseInt(userArg, 10) : await resolveUserId();
  const gitEnv = await buildGitEnv(userId); // 無 PAT → NoGitCredentialError
  execFileSync('git', ['-C', repo, 'push', remote, branch], { env: { ...process.env, ...gitEnv }, stdio: 'inherit' });
  console.log(`[push] OK → ${remote} ${branch}`);
})().catch(e => { console.error('[push] FAIL:', e.message); process.exit(1); });
