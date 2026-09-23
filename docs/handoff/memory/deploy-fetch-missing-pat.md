---
name: deploy-fetch-missing-pat
description: 部署的 git fetch 漏帶 PAT（`dd8b96e8`，已重啟未實跑）＋部署結果補進任務對話（`09a858f4`，**已 push 未重啟**）；**失敗點在寫 deploy_runs 之前 ⇒ 整次自動部署完全無痕**，症狀就是「核准完好像沒部署」
metadata: 
  node_type: memory
  type: project
  originSessionId: 654dbf62-592b-46de-bec5-8e825acadbfe
  modified: 2026-09-10T06:29:47.155Z
---

2026-09-10：鴻久部署失敗 `could not read Username for 'https://github.com'`。

真因：`app/server/lib/deploy-run.js` 的 `defaultGit().headSha()` 跑
`git fetch origin <branch>` 時**沒帶 PAT**。客戶 repo 是私有的，git 轉去要互動輸入，
無 tty ⇒ 直接死。**平台其餘 4 個 `git fetch`（git.js×2、finding-fix、enterprise-sources）
都帶憑證，只有部署這支漏了**——所以「平台有一套 buildGitEnv」不代表每條路徑都走到它。

已修並 push：commit `dd8b96e8`（master）。**09-10 14:30 已重啟**（commit 14:28），
但⚠ **真實的自動部署一次沒實跑過**（只用 `defaultGit(target, uid)` 對真 repo 驗過 fetch：
user=null 重現原錯、user=2 拿到 sha）。

**這個 bug 的症狀是「什麼都沒發生」，不是紅燈**：`runDeployGroup` 的 `git.headSha()`
在 **INSERT deploy_runs 之前**，fetch 一炸就 `return`，於是
（a）`deploy_runs` 連一筆 failed 都沒有、（b）失敗訊息只走 `notify.emitToUser('terminal:output')`
而**該事件不落 DB**（`task_events` 只由 `claude-runner.js` 寫，emitToUser 不寫）⇒ 重整就沒了。
判別法：核准後 task_logs 的「→ 併入 ai-dev」到「→ 更新 Wiki」只隔 1~2 秒（真部署要 30 秒以上），
且 `deploy_runs` 查無該 task_id。實測重現：`cd repos/<repo>/main && git fetch origin ai-dev`
→ exit 128 `could not read Username`。

**另一個會長得一模一樣的原因**：`deployToTestEnv` 的兩道守衛（專案 `auto_deploy_enabled`、
`project_deploy_targets` 有 env='test' 且 enabled）不過就靜靜略過，同樣只留一行不落 DB 的訊息。
鴻久 09-10 的 254/257/259/260/261 就是這種——核准時部署目標還沒建（目標 02:51 UTC 才建立）。

**結構性缺口（比這個 bug 本身值得記）**：自動部署（`push-ai.js` 的 `deployToTestEnv`）
刻意傳 `userId: null`，因為那是系統觸發、`deploy_runs.triggered_by` 不該歸屬到人。
但「不歸屬到人」和「不需要人的憑證」是兩件事——凡是系統觸發卻要連外的動作，
都要問一次「這條路徑的 PAT 從哪來」。這次的解法是另開 `gitUserId`
（預設 = `userId`，push-ai 傳 `task.approved_by || task.user_id`）。

**判讀線索**：`取不到分支 X 的狀態：...` 這句是 `deploy-run.js` 包出來的，
後面接的才是 git 原話。現在認證失敗會被翻成「GitHub 認證失敗，請到設定填個人 GitHub PAT」。

**後續：部署結果補進任務對話**（`09a858f4` 已 push、⚠ **未重啟未實測**）。
`push-ai.js` 的 `deployToTestEnv` 與 `/release` 兩邊都改寫 `task_logs`（role `ai`），
文案抽到 `app/server/lib/deploy-text.js`（放 `deploy-run.js` 不行——那支在
`deploy-trigger-*.test.js` 裡整包被 mock，`describeResults` 會拿到 undefined）。
**兩條刻意不對稱**：專案沒開自動部署時測試區那條不寫（多數專案的常態，寫了會把有事的那行淹掉），
正式區那條照寫（使用者主動按下去、等著看客戶機更新了沒）。測試 4733→4749 全綠。

**踩到的坑**：在 pg-mem 的測試 fixture 裡 `DELETE FROM tasks` 會被
`task_logs_task_id_fk` 擋下來（沒有 CASCADE）——只要讓某關開始寫 task_logs，
該關的測試 `beforeEach` 就要先 `DELETE FROM task_logs`。症狀是**整份測試檔幾乎全紅**，
而錯誤訊息指向 `db.js` 的 `query()`，完全不指向「是我新增的那行 INSERT 造成的」。

相關：[[push-with-stored-pat]]、[[auto-deploy-security-fixes]]、[[hungjou-deploy-topology]]、[[shared-index-race-on-commit]]
