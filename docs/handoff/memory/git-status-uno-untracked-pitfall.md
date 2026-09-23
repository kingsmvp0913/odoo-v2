---
name: git-status-uno-untracked-pitfall
description: 「git status --porcelain -uno 是空的」不能推論某目錄未被追蹤——我因此誤判 graphify-out 並 rm -rf 掉 487 個版控檔
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ca582294-9e8a-4694-975c-4027d636c586
---

**`git status --porcelain -uno` 空輸出 ≠ 該目錄不在版控。** `-uno` 的意思是「不列出未追蹤檔」，
未修改的**已追蹤**檔本來就不會出現在任何 `git status` 裡。兩者都不顯示，看起來一模一樣。

**Why**：2026-08-08 我踩了。看到 `git status` 一片 `?? graphify-out/...`、而 `-uno` 是空的，就下結論
「graphify-out 全是未追蹤檔、不在版控內」，還把它寫進記憶、據此建議使用者「直接刪除」。實際是
**487 個已追蹤（14MB）＋ 310 個未追蹤（6MB）**。`rm -rf` 之後 `git status` 冒出一整排 ` D `，才發現
刪掉的是版控檔。`git restore` 救回了 487 個，但 310 個未追蹤的 cache 檔永久消失。
（同一個錯誤也寫在施工規格 `docs/SPEC-graphify-removal-wiki-refresh.md` 的 A-11：「不在版控內，
可以直接刪」——所以這不是只有我會犯的判讀錯。）

**How to apply**：
- 要判斷「某路徑在不在版控」，唯一可靠的是 `git ls-files <path> | wc -l`，不是任何形式的 `git status`。
- 要判斷「會不會被忽略」用 `git check-ignore -v <path>`。
- **刪除目錄前先 `git ls-files` 數一次**；要刪版控內的東西一律 `git rm -r`（可 revert），不要 `rm -rf`。
- 向使用者要授權時，先確認自己陳述的前提為真——我那次的「20MB、310 個未追蹤檔」讓對方在錯誤
  前提下同意了刪除。

**結局**：`graphify-out/` 已於 commit `1697082` 從版控移除並加進 `.gitignore`（自動索引早在 `cff9b05`
移除、產物永不更新、無任何消費者）。要重跑用 `scripts/graphify_index.py`。此事已了結，本條留的是判讀教訓。
