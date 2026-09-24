#!/usr/bin/env node
/**
 * git-pull.js — 帶平台儲存的 GitHub PAT 拉最新程式碼（給 upgrade.sh 用）。
 *
 * 為什麼需要：**私有 repo 的 `git pull` 會停下來問帳密**。公開 repo 不用登入就抓得到，
 * 所以 upgrade.sh 裡那句光禿禿的 `git pull --ff-only` 在公開時期一直都能動——這個坑會在
 * 「把 repo 轉成私有」或「搬到私有 repo」的那一天才出現，而且症狀是更新流程卡在第一步。
 *
 * 而且那時候輸入帳密也過不了：GitHub 2021-08 就停用密碼登入 git 了，**不管輸入誰的密碼
 * 都不會過**（實測訊息是 `could not read Username`）。密碼欄位要的是 PAT，
 * 而 PAT 平台已經有一份（users.github_pat_enc）。
 *
 * 2026-09-24 搬到 Ideaxpress-odoo/odoo_ai_dev（私有）時實際撞到，故補上這支。
 * 程式本身與 repo 無關——只認 `origin`，公開私有、新舊 repo 都適用。
 *
 * 憑證處理完全比照 .claude/skills/pushRepo/push.js：PAT 由 git-identity.buildGitEnv 解密，
 * **只注入這一次 git 子行程**（清 credential.helper＋GIT_TERMINAL_PROMPT=0），不寫進
 * ~/.git-credentials、不寫進共用 clone 的設定。不另開第二條存憑證的路——多一個地方就多一個
 * 會過期、會忘記輪替、而且沒人知道它存在的東西。
 *
 * 失敗一律 fail loud 並講得出下一步：這支跑在更新流程的第一步，靜默失敗的話後面
 * 「重啟了但還是舊碼」會被歸因到別的地方去。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const repo = path.resolve(process.env.APP_DIR || path.join(__dirname, '..'));

// DATABASE_URL／APP_SECRET（連平台 DB 取 PAT、crypto 解密用）依序取自：
// process.env → <repo>/data/config.json → 平台 server 進程。與 push.js 同一套順序，
// 因為 upgrade.sh 執行時 server 可能還在跑、也可能已經被關掉。
function need() { return !process.env.DATABASE_URL || !process.env.APP_SECRET; }
if (need()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'data', 'config.json'), 'utf8'));
    process.env.DATABASE_URL = process.env.DATABASE_URL || cfg.DATABASE_URL;
    process.env.APP_SECRET = process.env.APP_SECRET || cfg.APP_SECRET;
  } catch { /* 沒有就往下退 */ }
}
if (need()) {
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
if (!process.env.DATABASE_URL) {
  console.error('[pull] 缺 DATABASE_URL：找不到平台 DB 連線（預期在 data/config.json）。');
  console.error('[pull] 這支需要平台 DB 才拿得到 GitHub PAT。PostgreSQL 沒起來的話先把它起來。');
  process.exit(1);
}

const { buildGitEnv } = require(path.join(repo, 'app/server/lib/git-identity'));
const { query } = require(path.join(repo, 'app/server/db'));

// 身分來源：管理頁的「CLI 推送身分」（teams_settings.cli_push_user_id）。
// 刻意不寫死任何 user id——本機與正式機各有各的 users 表，寫死的數字會在另一邊指到
// 不存在的人，而那時的錯誤訊息讀起來像「這個人沒設 PAT」，不是真因。
async function resolveUserId() {
  const { rows } = await query('SELECT cli_push_user_id FROM teams_settings WHERE id = 1');
  if (rows[0] && rows[0].cli_push_user_id) return rows[0].cli_push_user_id;
  const { rows: users } = await query(
    `SELECT id, username FROM users
      WHERE github_pat_enc IS NOT NULL AND github_pat_enc <> '' ORDER BY id`);
  console.error('[pull] 沒有設定「CLI 推送身分」（管理員設定頁）。有 PAT 的帳號：');
  for (const u of users) console.error(`         ${u.id}  ${u.username}`);
  if (!users.length) console.error('         （一個都沒有——請先在「設定」頁存入 GitHub PAT）');
  process.exit(1);
}

(async () => {
  const userId = await resolveUserId();
  let env;
  try {
    env = await buildGitEnv(userId);
  } catch (err) {
    console.error(`[pull] 取不到 GitHub 憑證（userId=${userId}）：${err.message}`);
    console.error('[pull] 該帳號的 PAT 沒設或解不開。到平台「設定」頁重新存一次。');
    process.exit(1);
  }
  const r = spawnSync('git', ['pull', '--ff-only'], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error('[pull] git pull 失敗。常見原因：本機有未提交的變更（--ff-only 不硬併）、'
      + '或這把 PAT 對 origin 指向的 repo 沒有讀取權限。');
  }
  process.exit(r.status === null ? 1 : r.status);
})().catch((err) => {
  console.error('[pull] 失敗：', err.message);
  process.exit(1);
});
