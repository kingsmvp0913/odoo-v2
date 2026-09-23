---
name: task-diff-three-dot-stale-main
description: 審任務 diff 用 main...branch 會把「上一張任務的改動」算成這張的，看起來像違規動了別的方法——真因是本地 main ref 落後
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ca877d06-7686-4fdd-b97a-85a1bb8e7993
---

審平台 pipeline 產出的任務 diff 時，**不要無條件用 `git diff main...task/<taskId>`（三點）**。

**現象**：2026-08-20 審 raifong #176 時，`--stat` 顯示 110 行變動，`-U0` 的 hunk 標頭出現三個落在
`_compute_amount_to_invoice`（第 215/217/225 行附近）的區塊——而規格明寫「同檔其他方法逐字不動」。
看起來就是 coding agent 越界改了別的方法。

**真因**：那三個 hunk 是**前一張任務 #175 的改動**。平台把 #175 合進了它自己管理的分支
（`git log main` 停在 `f83a430 Merge branch 'ai-dev'`，只含 #171／#172），而 #176 的分支
是直接建在 #175 的 merge commit 之上（`eee52fa` 的 parent 就是 `6c35f63 Merge branch 'task/...175'`）。
⇒ merge base 不含 #175，三點 diff 就把 #175 的內容也算進 #176 頭上。

**正確做法**：先確認分支的實際起點，只審這張任務自己的 commit。
```
git log --oneline -3 task/<taskId>        # 看 parent 是不是上一張的 merge commit
git show <該任務的 commit> --stat          # 只看這一張的淨改動
```
`git show` 出來的 `4 insertions, 96 deletions` 才是真正要審的東西。

**判別線索**：若 hunk 內容你「認得」——那是你上一張任務剛核准過的碼——就是這個陷阱，不是越界。
另一個線索是本地 `main` 的 `git log` 最新 commit 對不上剛完成的任務編號。

⚠ 容器內 `git fetch origin` 會 `could not read Username for 'https://github.com'`（沒帶 PAT），
所以本地 ref 落後是常態，不是異常狀態。要 push 才需要 PAT，見 [[push-with-stored-pat]]。

相關：[[raifong-17-to-19-upgrade]]（#171→#175→#176 這串連續改同一個檔的任務就是踩到的場景）
