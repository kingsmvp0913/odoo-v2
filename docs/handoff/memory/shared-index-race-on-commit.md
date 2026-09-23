---
name: shared-index-race-on-commit
description: 共用 checkout 上「git add 完再 git commit」會夾帶別人的檔案——index 是共用的，平行 session 會在兩道指令之間改掉它；用私有 GIT_INDEX_FILE 才免疫
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 221893d9-c91c-41a2-b1a7-1ff2437729e0
  modified: 2026-09-11T01:39:39.152Z
---

2026-09-10 實際發生：`git add`（我的 14 個檔）→ `git diff --cached --stat` **確認就是 14 個** →
`git commit` → 結果 **30 個檔案、856 insertions**，把另一個 session 未完成的
`reject-triage.js`／`spec-version.js`／`.claude/agents/*.md` 全部夾進我的 commit。

**Why**：`.git/index` 是整個 checkout 共用的一份檔案。always.md #4 教的「逐檔挑選」只保證
*我下 add 的那一刻* index 是對的；平行 session 在我 add 完到 commit 之間跑一次 `git add`，
我的 commit 就照單全收。查過了：沒有 git hook、沒有 `commit.all`、沒有 alias——
不是設定問題，是共用 index 的先天競態。always.md #5 說平行工作要各開 worktree，正是為了這個。

**How to apply**：在共用 checkout 上 commit，不要信「add 完再 commit」。用私有 index：

```bash
export GIT_INDEX_FILE=/tmp/myidx; rm -f $GIT_INDEX_FILE
git read-tree $BASE
git add -- <只有我的檔>
git apply --cached mine.patch          # 檔案混了別人的 hunk 就走這條
N=$(git diff --cached --name-only $BASE | wc -l); [ "$N" = "14" ] || exit 1   # 數量閘門
TREE=$(git write-tree); NEW=$(git commit-tree $TREE -p $BASE -F msg.txt)
git update-ref refs/heads/master $NEW
unset GIT_INDEX_FILE; git reset --mixed HEAD    # 把共用 index 同步回新 HEAD，不動工作目錄
```

`GIT_INDEX_FILE` 不跨 Bash 呼叫存活（shell state 不保留），所以 read-tree→commit-tree→update-ref
**必須在同一次呼叫內**跑完。

**補救**：commit 錯了而且沒 push，就用同一招重建正確的 commit 再 `git update-ref` 蓋掉，
比 `git reset` 安全——`reset --mixed` 會把別人已 stage 的狀態一起抹掉。事後要驗兩件事：
`git show --stat HEAD` 只有我的檔，而且對方的改動**還在工作目錄**（用他們特徵字串抓一次）。

**還有一個判讀陷阱**：我量到的「基線 8 個紅燈（`reject-triage.test.js`）」其實是**別人未完成的碼**，
不是既有問題。共用 checkout 上量基線，先 `git status` 看看樹上有沒有別人的東西，
否則會把對方的半成品當成 repo 的既有紅燈放過去（或反過來，當成自己弄壞的）。

**漏掉最後那行 `git reset --mixed HEAD` 的症狀（2026-09-10 又踩一次）**：`git status --porcelain -uno`
出現 `MM`，而 `git diff --cached` 顯示的內容是**把你剛剛 commit 的改動全部刪掉**——因為共用 index 還停在
commit 前的樹，HEAD 卻已經往前走了。此時誰在這個 checkout 上 commit，都會把你的東西還原掉，而且看起來
像是正常的「已暫存變更」。修法：`git reset -q -- <你的那幾個檔>`（**限定路徑**，不要用光禿禿的
`git reset`——那會抹掉別人已 stage 的狀態）。

**漏掉那行還會卡死夜間改善通道（2026-09-11 實際發生）**：`0926168e` 用私有 index commit 後沒 reset，
共用 index 停在 commit 前 ⇒ 夜間批次 `applyFix` 判「主 clone 有已暫存的變更」拒絕合併 ⇒ 兩條已修好、已過審的
修正（finding 142/143）停在 `adopted`，改善提案頁顯示「改善中，上次未完成」。判別：`feedback.last_attempt_note`
列出的檔名＝那次 commit 的檔名。先用 `git hash-object <檔>` 對 `git rev-parse HEAD:<檔>` 確認工作目錄＝HEAD，
再限定路徑 reset。修完後 `resumeAdoptedFixes` 下一批會自動補合併，不必重跑修正。
09-11 使用者要求當場結案：手動 `merge --no-ff` 兩條（`15aed370`／`8dd27ef0`，全跑 4763 綠）→ pushRepo 推上 →
照 `setStatus('merged')`＋`markGroupDone` 口徑補 DB（fix 23/24→merged、feedback 26/27→done、來源提案 139/140→done）。
**cron.js／health-data.js 需重啟才生效**（server 起於 09-10 16:53）；chat-retry.md／cs-capability.md 走 mtime 熱載。

**09-11 同日補上程式防線**（使用者核准設計）：`finding-fix.js` 新增 `resyncGhostStaged`——暫存檔逐一比
「HEAD blob vs 工作區 hash-object」，**全部相等**才限定路徑 reset 並重讀 status 再合併；有一個不等就整個不動、
錯誤只點名真的那幾個。純程式、不叫 AI；因為 `resumeAdoptedFixes` 排在批次第一步，殘影會在任何 AI 開跑前被清。
已知接受的盲區：「暫存了改動、工作區又改回 HEAD」會被當殘影清掉（實務上幾乎只有私有 index 提交會產生這形狀）。
測試：`finding-fix-ghost-index.test.js` 用**真 git** 重現改／增／刪三形狀；拆掉「清完重讀 status」會紅。
全跑 4768 綠。**已 commit＋push `95860b1e`，未重啟**（沒重啟前今晚批次跑的仍是舊的 applyFix）。
同日 #25（送出跳頂）改人工修掉 `857bb485` 並把 feedback 25 標 done，避免夜間批次第三次重修。

相關：[[git-status-uno-untracked-pitfall]]、[[nightly-fix-fuse-cache-read]]、[[multi-instance-shared-ai-dev]]
