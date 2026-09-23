---
name: push-with-stored-pat
description: 本環境 push GitHub 沒有 gh/credential-helper，直接用平台 DB 存的 per-user PAT 經 buildGitEnv 推，不要問使用者
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c92cdb16-061f-42df-8c97-67e18791c58f
---

在此環境 `git push` 到 GitHub（https remote，無 `gh`、無 credential.helper）失敗時，**不要問使用者拿 PAT**——平台 DB `users.github_pat_enc` 已存 per-user PAT（APP_SECRET 加密）。直接用現成的 `app/server/lib/git-identity.js` 的 `buildGitEnv(userId)` 產生注入 env（含 GIT_ASKPASS shim、清空 credential.helper、GIT_TERMINAL_PROMPT=0），再 spawn git push。

**kingsmvp2 = `users.id=2`**（github_login `kingsmvp0913`＝repo owner，git_name `kingsmvp2`，有 PAT）。使用者(2026-08-04)指定「用 kingsmvp2 的 PAT 推，下次不要再問」。

做法（在 `app/` 下跑）：
```
node -e '
const cfg=require("../data/config.json");
process.env.APP_SECRET=cfg.APP_SECRET; process.env.DATABASE_URL=cfg.DATABASE_URL;
const {buildGitEnv}=require("./server/lib/git-identity");
const {spawnSync}=require("child_process");
(async()=>{const env={...process.env,...await buildGitEnv(2)};
const r=spawnSync("git",["push","origin","master"],{cwd:"/home/odoo/odoo-v2",env,encoding:"utf8"});
process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exit(r.status||0);})();'
```

**症狀→成因**（2026-08-04 重推時各踩一次）：`could not read Username for 'https://github.com'` = 裸 git 無憑證，要走上面的 PAT 注入；`no PostgreSQL user name specified in startup packet` = 忘了先載 DATABASE_URL，buildGitEnv 的 DB 查詢連不上。**跑之前先把本體看全，別只讀 MEMORY.md 索引就自己重推。**

**Why**：省掉每次卡在認證問使用者。**How to apply**：commit 照舊（逐檔挑選、禁 add -A，見 always.md rule 4），push 這步自動用上述 PAT 注入，PAT 只進該次子行程 env、不寫共用設定（infra.md rule 149）。其他 user 換 id 即可。相關 [[vpn-sibling-mount-homomorphic]]。

**2026-09-18 新症狀：`relation "companies" does not exist`。** 多租戶那批 commit 進 master 之後，
`buildGitEnv` 改成 `users LEFT JOIN companies`（個人 PAT → 公司 PAT 的退回鏈）。**rebase／pull 完但平台還沒重啟時**，
工作目錄的碼是新的、DB 還沒跑 `migrate()`，於是連 push 都動不了——而訊息完全不指向真因。
繞法：一次性腳本只查 `users.github_pat_enc`＋`decrypt`＋`hardenGitEnv`，不碰 companies（實測推成功）。
平台重啟建好表之後 `pushRepo` 就恢復正常，不需要改那支 skill。
