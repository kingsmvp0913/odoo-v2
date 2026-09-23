---
name: deployment-env-red-tests
description: "⚠ 已失效的豁免清單：那 4 支紅燈 08-07／08-08 複測全綠。本檔留作歷史診斷（ensureWorktreeAtMain 的 git identity 是真實產品 bug，已修），**不要當成現行的紅燈豁免依據**"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 61fc147a-fc2c-480e-bb95-d9c7ea97700c
---

**⚠ 這份清單已經不再適用，不要拿它當「這幾支紅了可以放過」的依據。**

- **2026-08-07 複測**：4 支全綠、全套 `157 passed / 0 failed`（2030 tests）、exit 0。連第 4 支（原本決定不修的 reclone race）也過了——它是時間敏感 flake，不是穩定紅燈。
- **2026-08-08 再測**：全套 `2210 passed / 0 failed / 163 suites / exit 0`，同樣全綠。同日 `always.md` 規則 2 那份同型的豁免清單也已刪除改寫（見 commit `69481b5`）——理由一模一樣：清單是在真因修好**之前**量的，留著會教人把自己改壞的東西當既有問題放過去。

**判定法一律是「動手前自己跑一次當基線，新紅燈先當成自己造成的」，不要沿用任何寫死的清單或通過數字（數字同一天就會腐爛）。** 下文為 08-05／08-06 的診斷，保留作背景與修法紀錄。

**同日另修：全套零失敗卻 exit 1。** 8 支 env 相關測試在結束後噴 `import a file after the Jest environment has been torn down`，根因與 `12a597a` 同型——`nginx-map.js` 的 debounce timer 是 unref 背景路徑，會在 jest 拆掉環境之後才觸發，那時才執行 `require('../db')` 就炸。修法：把該 lazy require 提到檔頭（`syncNginxMap` 內改用 `dbQuery`）。**判讀教訓：`Tests: X passed, 0 failed` 與 exit code 是兩件事**，只看測試摘要會漏掉這種殘留（always.md #12）。

在本部署容器（odoo-v2，非乾淨開發機）跑全套測試，除了 always.md rule 2 記的 `git-integration.test.js:106` CRLF／pgPass flake 外，還有 **4 支既有紅燈**，2026-08-05 逐一查清，全部**與碼改動無關**（把當時所有改動 stash 後在同環境重跑，4 支一模一樣紅）。真正結果看 `Tests: X passed`。

1–2. **`ensure-env.test.js` 兩支**（line 40「envBindHost(8069)=127.0.0.2」、line 90「loopbackHostForPort(21000)=127.0.50.133」）：本容器 baked **`ENV_BIND_HOST=10.0.0.1`**（測試區綁這個，見 [[deployment-topology]]）。`envBindHost()` 回 `process.env.ENV_BIND_HOST || loopbackHostForPort(port)`，env 有設就回 10.0.0.1，測試卻寫死 loopback 期望且**沒隔離這個 env**。產品行為正確＝測試不 hermetic。修法：測試 `beforeEach` 存/清 `ENV_BIND_HOST`、`afterEach` 還原。**✅ 2026-08-06 已修**（`beforeAll` delete＋`afterAll` 還原，6/6 綠）。

3. **`git-integration.test.js:121`「ensureWorktreeAtMain：分支已有領先 base 的 commit → reset=true 不得丟掉實作」**：失敗在 line 138（`b.py` 沒被帶進來），不是 137（實作有保住）。根因＝本環境**無全域 git user.name/email**（`git config --global` 為空）；`ensureWorktreeAtMain`（git.js:559）reset 且分支領先時走 `git merge --no-edit <base>` 帶最新 base，這是非 ff → 要建 merge commit → 沒身分 → 失敗 → catch 走 `merge --abort` → 新 base 沒進來。**帶 `GIT_COMMITTER_NAME/EMAIL` 即綠（已驗證）**。line 143 衝突案能過，是因它的 merge 在建 commit 前就撞衝突、abort 剛好滿足「保住實作」。
   - ✅ **2026-08-06：已證實是活的產品 bug 並修掉**。本機 `git config --global user.name` 確為空（exit 1），故 respec 打回分析時那個非 ff merge 必定失敗＋靜默 abort ⇒「帶最新 base 給分析讀」在正式機從未生效過。修法：`ensureWorktreeAtMain` 簽名加第 6 參數 `gitEnv`，merge 改 `[...identArgs(gitEnv), 'merge', ...]` ＋ `gitOpts`，`runner.js:138`／`task-agent.js:225` 傳入。整支 `git-integration.test.js` 25/25 綠（連 always.md #2 記的 CRLF flake 在 Linux 也不再紅）。

4. **`project-routes.test.js:399`「POST reclone：更新完成後 testing 真的被重長到 ai-dev」**：帶 git identity **仍紅**（非同源）。根因＝背景 async race——`resetTestingToAiBranch`（rebuild-testing 那步）跑在 `clone_status='done'` **之後**的背景鏈，而 `waitReclone` 只等 `clone_status`，斷言時該呼叫還沒發生；加上前一測試（reclone-sync-ok）的背景 reclone 延遲 resolve、污染共享 `gitMock.resetTestingToAiBranch` → 斷言看到的是上一測試的 sync-ok dir。時間敏感 flake。修法：`waitReclone` 等到 rebuild 那步、或測試間隔離背景污染。**⬜ 2026-08-06 刻意不修**（使用者同意）：產品價值最低、最易越修越糊，是目前唯一的常態紅燈。

進度與是否修的決定見 [[session-2026-08-05-platform-tasks]]。
