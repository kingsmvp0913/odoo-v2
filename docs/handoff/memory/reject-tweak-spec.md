---
name: reject-tweak-spec
description: 人工審核退回改走「小修正規格」追加式（893105bd 已 push、未重啟未實測）；含追加式規格會繞過 QA resume 指紋這個致命盲點
metadata: 
  node_type: memory
  type: project
  originSessionId: 5ac874ef-16e5-4d39-b70f-3c2814c60d04
  modified: 2026-09-10T04:00:52.157Z
---

2026-09-10。使用者抱怨「我只改一個小地方卻要整個重看過規格 很麻煩」。已改完並 push `893105bd`。

## 改了什麼

人工審核退回判 `fix` 時，**拿掉了「無條件先繞 respec_running（規格層重做）」那一關**。改由分診（analysis-reject）在同一輪多吐一個 `spec_patch` 欄位，落成一份「小修正規格」：

- 存在 `task_specs`，用新欄位 `kind` 分 `'main'` / `'tweak'`；**兩邊版本序列各自從 1 起算**（混一條序列會讓主規格跳號 ⇒ 時間軸的規格書靠版號對，跳號＝那一則靜默對不到任何規格）
- **主規格（tasks.analysis_yaml）一個字不動**，是追加不是重產
- 純文字條列，**刻意不做成 YAML**（這個 repo 兩次前科：使用者貼的冒號炸掉規格、回覆與 YAML 綁死一行縮排就整輪報廢）
- coding 與 QA 兩關都讀得到（`loadTweakSpecs` 每輪給**全部版本**，不只最新——coding 無狀態，只給最新會讓前一次的要求從 prompt 消失、被這輪改回去）
- `decision='respec'`（整份重產、回分析關）**保留不動**，只在 prompt 收緊判準：現行 SD 八成以上還能用就走 fix

流程圖 `pipeline-spec.js` 已同步（拿掉 `triage→respec` 線，`triage→analysis` 留著＝判 respec）。

## 最重要的一件事：追加式規格會繞過 QA 的 resume 失效機制

`qa-retry` 的 prompt **刻意一個字規格都不帶**（那是續接只要 19 秒 / $0.27、對照全量重讀 8~10 分鐘 / $3 的前提）。規格中途被換掉時，靠的是 `qa_prompt_ver = promptVersion('qa') + '.' + sha1(analysis_yaml)` 這個指紋讓 resume 失效、降級 fresh。

**追加式規格不動 `analysis_yaml` ⇒ 指紋不變 ⇒ resume 照樣續接 ⇒ 小修正規格會是這條路上唯一送不到 QA 的規格。** 後果就是 [[qa-resume-stale-spec]] 的 task 184 形狀：QA 拿舊規格審新實作、判超出規格，coding 照 QA 的話改回去，來回到熔斷。

解法是讓 `qa-retry` 也帶 `{{tweak_specs}}`（它很短，token 幾乎沒差），**不是**把它折進指紋（那等於每次小修正都付一次全量重讀，把省下來的又賠回去）。

**通則：任何「新增一個規格來源但不動 analysis_yaml」的設計，都要先問 qa-retry 拿不拿得到。** 那支 prompt 的「不帶規格」是刻意的省 token 設計，不是疏漏。

## 還沒做的

- **未重啟**。`db.js` 加了 `task_specs.kind` 欄位，沒重啟就沒這欄 ⇒ `recordTweakSpec` 的 INSERT 會失敗（有 catch、只落 console.error，fix 仍會進 coding，但小修正規格不會產生）。重啟走主機 `docker restart`，見 [[platform-restart-kills-container]]。
- **前端沒用瀏覽器看過**，深色模式也沒驗。時間軸新增一則 `[小修正規格]（第 N 版）`，靠前綴＋全形括號版號掛規格書（與主規格的 `[等待你審核規格]` 同一套機制）。格式一動就靜默掛不上去。
- **整條沒實跑過**：沒有真的退回一張任務看它跑完一圈。

## 附帶

- 分診的 `parseAgentResult` 原本沒帶 `schemaHint`，這次補上。理由：`spec_patch` 是多行字串，模型偶爾在 JSON 內塞真換行而不是 `\n`，`JSON.parse` 一死就整包分診結論連同去向一起丟掉、任務白白 stopped；補救那輪（haiku）不帶形狀只知道「這串壞了」，修不回來。
- 改了 4 支 agent prompt（analysis-reject／qa／qa-retry／coding-project）⇒ `promptVersion` 換版 ⇒ 進行中任務的 resume session 會強制 fresh 一次。這是預期行為，見 [[prompt-effect-verification-pitfalls]]。
- 測試 4703→4728 全綠、零回歸（新增 8 支）。
- 這次 commit 被平行 session 夾走過一次（已救回），教訓見 [[shared-index-race-on-commit]]。
