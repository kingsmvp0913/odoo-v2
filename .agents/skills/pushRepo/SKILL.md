---
name: pushRepo
description: Use when pushing this platform repo (odoo-v2) or any per-user PAT repo to GitHub — instead of re-deriving the buildGitEnv/PAT/DATABASE_URL/APP_SECRET flow each time. Avoids symptoms "could not read Username" (no PAT) and "no PostgreSQL user name" (no DATABASE_URL), and hunting for git-identity.js / config.json / the server pid.
---

# pushRepo

## Overview
用平台儲存的 per-user GitHub PAT（`users.github_pat_enc`）push。PAT 由 `git-identity.buildGitEnv` 解密、**只注入該次 git 子行程**（清 `credential.helper`＋`GIT_TERMINAL_PROMPT=0`，不寫進共用 clone 設定）。免去每次重摸認證流程。

## When to use
- 要把平台本體 repo 或任一綁 per-user PAT 的 repo push 到 GitHub。
- 症狀：`could not read Username`（沒帶 PAT）、`no PostgreSQL user name`（沒載 DATABASE_URL）。

## Usage
```bash
node .agents/skills/pushRepo/push.js [--repo <path>] [--branch <name>] [--remote origin] [--user <id>]
```
預設：`repo=$APP_DIR` 或 `/home/odoo/odoo-v2`；`branch`=當前；`remote=origin`；`user=2`（kingsmvp2）。
`DATABASE_URL`／`APP_SECRET` 依序取自 `env → <repo>/data/config.json → 平台 server 進程`。

落 exit code 別經管線（此 repo 已因此誤判過）：
```bash
node .agents/skills/pushRepo/push.js > out 2>&1; echo "EXIT=$?" >> out
```

## Notes
- **只 push，不 commit**。commit 走一般 `git commit`。
- **commit 前逐檔挑選、禁 `git add -A`**——此 repo 常態多股平行工作，盲目 add 會夾帶別人未完成的變更。
- push 前若在非預期分支，先確認：平台主 clone 常駐 `testing`，切分支後要切回。

## Common Mistakes
- 缺 `DATABASE_URL` → `no PostgreSQL user name`：`--repo` 沒指到含 `data/config.json` 的 repo，且平台 server 沒在跑。
- 使用者無 PAT → `NoGitCredentialError`：該 `--user` 的 `users.github_pat_enc` 是空的。
