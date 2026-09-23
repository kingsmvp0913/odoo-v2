---
name: nightly-fix-fuse-cache-read
description: 改善通道 2026-09-08「又沒跑完」的兩個真因——保險絲把 cache_read 算成花費（97% 的量）害 5 組只跑 2 組、主 clone 髒掉害合併 0 條；兩者都已修/已補做
metadata:
  type: project
---

2026-09-08 夜間批次「沒跑完」＝**兩個各自獨立的原因疊在一起**，跟 [[merge-single-point-zeroed-nightly-batch]] 的 09-07 真因（merge 落空）又不同——那次的修法 `a6d552b6` 這次實跑通過了（8 候選→7 組，merge 沒落空）。

log 一行就分得出來：
```
[NIGHTLY-FIX] 候選 8 筆 → 統整 7 組 → 本批次執行 5 組
[NIGHTLY-FIX] 保險絲跳了（token-budget），不再開新的一條（已跑 2 條）
[NIGHTLY-FIX] 本批次結束：嘗試 2 條、合併 0 條、超出上限未跑 2 條
```

## 真因 1：保險絲拿「讀了幾次快取」在限制花費

`tokensSince()` 把 `cache_read_tokens` 也加進總額。實測那晚 13.2M 裡 **12.76M（97%）是 cache_read**，兩組就撞穿 12M 上限；不含 cache_read 的真實用量只有 **83 萬（一組約 40 萬）**。cache_read 計價只有一般 input 的 1/10，兩者根本不同量級。

已修（`67d894ea`）：只算 `input+output+cache_create`，上限 12M→15M（約 35 組）⇒ 先撞到的會是 `NIGHTLY_FIX_MAX=5`，保險絲回到「只擋異常爆量」。補的測試「cache_read 再多都不進預算」**驗過會紅**（把 cache_read 加回計算那支就失敗）。

⚠ 還有一個沒修的口徑問題：`tokensSince` **不分 agent_type**，同時段跑的一般 pipeline 任務也會吃掉批次預算。那晚剛好只有夜間 agent 在跑，所以沒暴露。

## 真因 2：主 clone 髒 ⇒ 合併 0 條（會重複發生）

`applyFix` 原本要求主 clone 完全乾淨。這是**慣性問題**而非偶發：白天有人在主 clone 工作、留一個檔沒提交，當晚全部合併就落空（修正留在 `adopted`、不記失敗、下批重試——設計是對的，但下批照樣被同一個檔擋）。

✅ **已放寬（`7236ee12`）**，兩道關卡都擋過頭：
- 「有任何未提交的檔」→ 改成兩層。**未暫存的變更根本不會進 merge commit**（原註解說會，是錯的），所以只擋兩種：已 `git add` 的、以及與「`HEAD...origin/master` ∪ `HEAD...分支`」重疊的檔。
- 「與 origin 分岔」→ 改成數 `rev-list --left-right --count`。只有本地領先（忘記 push）就自動推上去再合併；兩邊各有各的 commit 才停手。

⚠ 連帶影響：`ui-preview` 的 before 截圖拍的是主 clone 的 live checkout，原本靠「applyFix 要求乾淨」來論證夜間批次安全——**那個論證本來就不成立**（截圖在 fix-review，比 applyFix 早），放寬之後更不成立。未暫存又不重疊的改動會入鏡，可能害 fix-review 誤判。已改註解，未修。

09-09 補做：手動 merge `fix/finding-123-9`／`fix/finding-124-11` 進 master 並 push（`96758dc0`），DB 照 `markGroupDone`＋`setStatus` 的口徑補：`finding_fixes` 9/11→`merged`、`feedback` 11/12→`done`＋`finding_id`、`health_check_findings` 123/124 補 `applied_at`。

## 判讀陷阱

- **`health_check_findings` 的 123/124 一開始就是 `status='done'`**——那是批次自建的「施工紀錄」列（`nightly-fix.js:363` 明講），不是等人裁決的提案。看到 done 別以為已經套用完了，要看 `applied_at` 與 `finding_fixes.status`。
- **主 clone 隨時可能有別的 session 在動**。這次 `git add` 那一刻，另一個 session 剛提交完 `5e55bebd`（內容跟我要提交的一模一樣）又開始下一件工作並 staged 了東西，我的 `git add <明確清單>` 就夾到它的 `ProjectDetail.js`。用 `git restore --staged` 還原（內容不會掉）。**commit 一律用 path-limited 的 `git commit -m "..." -- <paths>`**：它只吃工作區那幾個路徑、完全不碰 index，別人 staged 的東西進不來。
  - **2026-09-10 再犯一次，而且是反方向**：我 `git add` 了自己的 17 個檔，對方隨後 `git commit` 就把**我的檔全部吃進他們的 commit**（訊息只講他們的 SSH 部署）。前一次是我夾到別人，這次是別人夾走我——只要 `git add` 進共用 index，兩個方向都會發生（對方從他們那一側記在 [[shared-index-race-on-commit]]，含免疫做法：私有 `GIT_INDEX_FILE`）。對方後來自己 amend 掉我的檔、把我的改動退回工作區，所以沒掉東西，但那是運氣。
  - **語法有坑**：`git commit -- <paths> -m "訊息"` 會把 `-m` 和訊息當成 pathspec 而失敗（`pathspec '-m' did not match any file(s)`）。`-m` 必須寫在 `--` 前面。這次就是這樣失敗、才讓對方的 commit 有機會先吃掉我的檔。
- 全跑通過數會被別人的刪檔帶著跳（4570→4555→4570），**跨時段比對通過數在共用 clone 裡沒有意義**。

## 附帶清出來的漏洞：被駁回的工作區沒人收（`16bd8812` 已修）

`removeWorktree` 原本只在三條退場路徑上有（動到不該動的檔、什麼都沒改、人工按捨棄），漏了兩條**常走的**：`finding-fix.js` 的「測試退步」與 `nightly-fix.js` 的「fix-review／fix-verify 未通過」。每被駁回一次就永久留下一份完整 checkout，`finding_fixes.worktree` 還指著它 ⇒「還有工作區可看」是假的。09-09 清出一個 09-08 留下的（`fix-10`，5 個 staged 檔）。

⚠ 手動清這種殘留 worktree **一定要先確認 `app/node_modules` 那個 junction 已經拆掉**再刪目錄——遞迴刪會沿著連結刪到主 repo 的相依（`linkNodeModules` 檔頭註解記著這件事）。這次它剛好早就被 `unlinkNodeModules` 拆了，清完主 repo 仍是 489 個，沒踩到。

判讀陷阱：pg-mem 的 SERIAL **跨測試累加**，所以斷言裡寫死 `fixId=1` 會在別支測試增減時無聲失去鑑別力（這次實際拿到 24、25）。改成從 DB 撈 id 再組路徑。
