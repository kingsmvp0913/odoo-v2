---
name: auto-deploy-ui-and-autofill
description: 自動部署頁改版與自動帶欄位已 push（b0848b79），但未重啟、SSH 那半從未實測；含「存出來的目標按了必定失敗」的真因與 db_name 刻意設計
metadata: 
  node_type: memory
  type: project
  originSessionId: b008939c-2575-42f2-8cbc-7cccd86be59a
  modified: 2026-09-10T02:46:52.724Z
---

2026-09-10 從「介面超醜」一路挖到四個缺陷。碼已 push `b0848b79`（master），
**未重啟 server、SSH 那半一次都沒實跑**。當下 `project_deploy_targets` 與 `deploy_runs` 都是 0 筆，
只有鴻久（project 3）開了 `auto_deploy_enabled`。

**接手要做的**：重啟 → 鴻久 → 自動部署分頁 → 按「開始評估」。新增的 18 支測試全是餵假輸出測解析邏輯，
`enrichCandidate` 對真機吐出來的東西看不看得懂，只有那一按知道。

## 四個真因（都已修）

1. **前端存部署目標時沒送 `repo_id`** ⇒ `deploy-run.js` 的 `defaultGit(t)` 拿 `t.repo_id` 查 `local_path`，
   null 就在 `headSha` 拋「這個部署目標沒有對應的 repo」。**目標存得下去、畫面全綠、按部署 100% 失敗**。
   這種「存檔成功但註定失敗」的形狀值得在別的地方也找一遍。

2. **來源分支讓前端填死 `ai-dev`／`main` 是錯的**。這個 repo 的分支名是算出來的：
   正式＝`getMainBranch()`（可能是 develop／odoo15），測試＝`remoteAiRef()`（可能是 `ai-dev-odoo15`）。
   兩支都在 `app/server/pipeline/git.js`，早就寫好了。base_branch 非 main 的專案（超淨14 那類）
   照舊填會 fetch 到不存在的分支。已改成後端依 env 推導，前端連欄位都拿掉。

3. **`ui-next-table` 與 `ui-next-log-pre` 這兩個 class 從來沒有定義過**——同 `.btn-secondary`
   （見 [[ui-next-css-traps]]）。症狀是裸 `<table>`：欄位黏成一團、按鈕被切出容器。
   `app.css` 早有做好的 `.table-wrap`+`.data-table`。**用了不存在的 class 沒有任何徵狀，測試也不會紅。**
   `TokenReport.js` 也套了 `ui-next-table`，同樣是裸的，還沒修。

4. **conf 的 `addons_path` 是容器內路徑，但部署是 SFTP 傳到宿主**。少了 Mounts 換算會把宿主上
   不存在的路徑存成 `addons_dir`，要到真的部署才炸。修法：`docker inspect -f '{{json .Mounts}}'`
   → 取最深的命中掛載 → 換算 → 在**宿主**上 `ls` 那條路徑（順帶驗證它存在）。

## 一個「看起來像 bug 但是刻意的」

`deploy-probe.js` 給每個候選填 `dbName: conn.db_name`（照抄連線設定，不讀 conf）。
我一開始判定成缺陷，**被 `deploy-probe-run.test.js:103` 的意圖註解打臉**：
「db_name 以 db_connections 為準，conf 只作交叉驗證。讀 conf 猜會拿到 `odoo_tst,hutest` 這種清單，選錯就升級到別的 DB。」

但風險是真的：一條連線探到兩個容器（鴻久那台 odoo-tst／odoo-prd）時兩個候選拿同一個 db_name。
最後採「保留原設計＋標示 `dbMismatch`＋給可改的下拉」。
**教訓：改 probe／deploy 這一帶之前先讀那兩支測試的意圖註解，那裡寫著當初為什麼這樣選。**

## 前端驗證迴圈的補充

用 playwright + `ctx.route()` 攔 `**/api/projects/3/deploy-*` 餵假 JSON，就能把「有目標／有歷史／
評估結果」三種狀態都叫出來截圖，**完全不碰客戶機**。比 [[ui-next-frontend-verify-loop]] 只截現況更有用——
那三種狀態在真 DB 裡都是空的，不攔就永遠只看得到空畫面。

量溢出要 `table.scrollWidth - wrap.clientWidth`；肉眼看不出 70px，但那 70px 就是「立即部署」被切掉的量。
