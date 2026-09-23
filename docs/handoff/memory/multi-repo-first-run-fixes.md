---
name: multi-repo-first-run-fixes
description: 萊峰19 是全平台第一個真多 repo 專案，一次撞出 5 個缺陷；碼已 push 且 **08-26 09:22 重啟後已生效**，但仍未實跑驗證，且萊峰19 測試環境仍缺掛純水
metadata: 
  node_type: memory
  type: project
  originSessionId: 1b18a6d9-4158-423f-9fea-f330935f3264
---

2026-08-25：萊峰19（project 11）加入第二個 repo「純水」（odoo19_taipure，base_branch=`mainForRaifong`）後，
task 186 死在最後一關。它是全平台**第一個真正的多 repo 專案**（其餘 11 個專案都只有 1 個 repo），
這條路徑等於首航。修正已 push：`7c3e738`（pipeline 四項）＋`66559d1`（repo 目錄命名）。

## 還沒做完的事（照順序）
1. ~~未重啟~~ **08-26 09:22:25 平台 node 已重啟（> commit 的 08-25 16:44）→ 修正已生效**。
   判讀法：`ps -eo pid,lstart,cmd | grep server/index.js` 的啟動時間 vs `git log --format=%ci` 的 commit 時間。
   ⚠ 仍**未實跑驗證**——08-26 送出的 task #194／#195（萊峰19）是首次實測，看它們會不會重蹈 186 的覆轍
2. 環境頁的 addons drift 紅字**未人工實測**（含深色模式）
3. **萊峰19 容器至今只掛 `main`**（`docker inspect` 可證），純水的碼不在測試區。重啟後該專案下一張
   任務會被新的 drift 檢查擋在部署關，直到在環境頁按「停止」→「重新啟動」
4. task 186 重試才會走完（純水會被「無任務分支」跳過）

## 兩個仍活著的認知
- **中途加入的 repo 不會回頭參與已開跑的任務**：它沒有 worktree、沒有 task 分支，現在的行為是跳過並留聲。
  要它真的參與，得重跑 analysis，不是在合併關硬救。
- **`odoo15-ucpt-uics` 有同形狀的未爆彈**：`origin/HEAD`→`odoo15`，本地卻只有 `main`＋`testing`
  （testing 追 origin/odoo15 是對的），而 `origin/main` 與它差 520 個 commit。舊 `ensureMainBranch`
  會判主分支＝main，只要有人按「更新 repo」就會 `pull origin main` 並把那 520 個 commit 併進 ai-dev。
  已由本次修正解掉，但那個 repo 本地仍沒有 `odoo15` 分支（下次呼叫時才會建）。見 [[ucpt-odoo15-port-incomplete]]

## 判讀陷阱
- **全跑基線不能與改檔並行**：第一次全跑是背景跑、我同時在改 `push-ai.js`，jest 讀到改到一半的碼，
  7 個紅燈全是自己造成的。差點被當成既有紅燈放過去。基線要在動手**之前**單獨跑完。
- **「不再 fatal」不等於修對了**：`ensureAiBranch` 會讓 ai-dev 建得出來，但基底可能歪到本地 main 上——
  照樣「成功」，只是少了主分支才有的檔案。驗證要斷言「只存在於主分支的那個檔案有在 ai-dev 裡」。
- push 走 [[push-with-stored-pat]]，`--user 2`（kingsmvp2）。
