---
name: deploy-single-module-limit
description: deploy 只升級規格 module 欄位的單一模組，跨模組任務會有一半改動靜默不生效；2026-08-26 已修成支援逗號分隔清單
metadata: 
  node_type: memory
  type: project
  originSessionId: 49795893-87c4-4d68-a986-9cca31a60648
---

2026-08-26。萊峰19 的 task #195（把採購客製從 `idx_project` 拆成新模組 `idx_purchase`）連兩次 deploy
失敗、reentry 撞頂熔斷。**碼是對的，是平台的部署機制讓修法失效。**

## 缺陷本體（已修）

`deploy-testing.js` 從 `analysis_yaml` 的 `module` 欄位取**單一**模組去升級：

```js
const mods = moduleName ? [moduleName] : [];   // 舊碼
await upgradeModules(task.project_id, mods, signal);
```

#195 的規格 `module: idx_purchase` ⇒ 只跑 `-i/-u idx_purchase`，`idx_project` **從頭到尾沒被升級**。
於是它的 `pre-migrate.py` 一次都沒執行、砍掉的 217 行 view 也沒生效——而錯誤訊息指向**新模組**的
xpath 撞空，完全看不出真因（coding agent 因此診斷正確卻怎麼修都沒用）。

修法：新增 `app/server/pipeline/spec-modules.js`，`module` 改吃逗號分隔清單。
- `specModules()` → 陣列，**只有 deploy 用**（`upgradeModules` 本來就 `.join(',')`，早就支援多模組）
- `primaryModule()` → 第一個，給 `playwright-agent`／`task-agent`／`library-agent`
  （tour 用它組 regex 比對 `<module>/tests/*.py`、library 的 `_collectModuleSource` 用
  `/^[A-Za-z0-9_]+$/` 擋 path traversal——這兩處吃到逗號會靜默比對不到，不是報錯）

測試：`spec-modules.test.js` ＋ `deploy-testing.test.js` 的「規格 module 列多個模組」那支。
驗證過把邏輯改回舊行為會紅 5 支（不是假綠）。全跑 215 suites／3223 tests 綠、零回歸。

`analysis-project.md` 已補【module 撰寫規則】（`39da9e48`），給的是可照抄的正面例子而非禁令
（rules/agent-prompt 第 100 條）。**尚未實跑驗證** analysis 是否真的會在拆模組任務填兩個模組——
下一張跨模組任務要盯這一欄。只改 analysis-project：retry／timeout-resume 走 `--resume` 繼承首輪、
respec-patch 是增量 patch 沿用既有 module，都不重新決定這一欄。

## 判讀陷阱

- **deploy 綠燈證明不了「所有改動都生效」**——只證明「被列進 `-u` 的那些模組」裝得起來。漏升的模組
  其 view 改動與 migration 完全不執行，且**不會有任何錯誤**。
- **`node --check` 抓不到未定義變數**。我改了 `task-agent.js` 用 `primaryModule` 卻漏加 `require`，
  五個檔案 `node --check` 全 OK，跑全套才炸出 2 suites／9 tests 紅。語法檢查不能當通過依據。
- **`testing` 分支會疊上多張任務的碼**。#194 與 #195 先後併入後，#194 那次 `-u idx_project` 升級的
  其實是「#194＋#195 混合版」——它意外觸發了 #195 的 pre-migrate。要判斷測試環境現在到底跑什麼，
  看 `git log testing` 的 merge 序列，不要假設只有本任務的改動。

相關：[[multi-repo-first-run-fixes]]、[[raifong-17-to-19-upgrade]]（「部署只 -u 一個模組」那條硬推論的來源）
