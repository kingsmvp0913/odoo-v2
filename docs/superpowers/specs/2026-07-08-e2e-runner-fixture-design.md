# E2E 測試改造：改用 Odoo 原生 tour（HttpCase + --test-enable）

日期：2026-07-08
狀態：架構已核可（原生 tour），待複審後進實作計畫
沿革：初版設計為「Playwright 固定 runner ＋ fixture」；查證業界成熟做法後改採 Odoo 官方 tour（見 §2 決策）。

## 1. 問題（來自實測歷程）

以「報價單客戶下增加備註T欄位」單（`manual_1783326354710`）追三次 E2E：

| 次 | 腳本用的 URL | 結果 | 真因 |
|---|---|---|---|
| run1 03:49 | `localhost:8069`（腳本寫死） | 登入失敗 | 打到錯的埠，該台無此測試帳號 |
| run2 05:50 | `localhost:8069` | connection refused | 該埠無服務 |
| run3 07:22 | `127.0.0.3:8070`（agent 手動改成注入值） | 登入成功但導覽鬼打牆 6.5 分後被手動暫停（記為 aborted / 0 token） |

根因（系統性）：agent 每次用 `require('playwright')` + `chromium.launch()` 手刻瀏覽器腳本、沿用 worktree 寫死 URL 的舊 spec、踩 `networkidle` 永不 idle、失敗就連寫 `diag.js`→`diag11.js` 共 11 支拋棄式探針、又試 `/odoo/sales` 漂亮路由 404。時間與 token 全燒在「重新摸索怎麼驅動這台 Odoo 的 UI」。

## 2. 決策：為何改用原生 tour

查證兩條成熟做法後（見 §10 出處）：

- **Odoo 官方 E2E 就是 tour**：tour JS + `HttpCase.browser_js`/`start_tour`，用 `odoo-bin ... --test-enable --test-tags` 跑，**exit code 即 pass/fail**。跑在**交易內**（測完 rollback、不污染資料），用 **Odoo 自己的 tour 引擎等待/選元素**。官方文件明講「路由或跨 App 的變更，優先用 integration tour」。
- 業界 Playwright 最佳實踐（storageState 登入一次複用、`getByRole`、禁 `networkidle`）雖能穩住外部瀏覽器測試，但**仍要維護登入/導覽/瀏覽器安裝**。

**結論（Rule 7 擇一）**：本 pipeline 的任務全是純 Odoo 模組行為（加欄位、欄位位置、存檔、報表），tour 為此量身打造，且**從根本消除**我們踩到的整類問題——登入、導覽、路由、networkidle、找按鈕、diag 腳本全部不再存在，因為測試跑在 Odoo 內部的已認證 session 與 tour 引擎裡。Playwright 路線**明確擱置**，未來若出現「tour 做不到、需跨系統/外部頁」場景再議。

## 3. 目標與成功標準

- **省 token**：agent 只寫一支 tour（step 陣列）＋一支 `HttpCase`，不寫瀏覽器 harness、不寫 diag 腳本、不做導覽試錯。
- **穩定**：由 Odoo tour 引擎負責等待與選元素；無 networkidle、無手動 timeout、無寫死 URL/埠。
- **準確**：pass/fail 由 `odoo-bin --test-enable` 的 exit code 判定，不靠 LLM 自述。
- **自動化**：Node 端跑 odoo-bin、讀 exit code ＋ log，沿用現行 deploy 的失敗分類與階段流轉。

成功判準：對同型任務重跑，E2E 無瀏覽器手刻腳本、無 diag、verdict 來自 exit code，且測試檔隨模組進 git（版控、可回歸）。

## 4. 架構

E2E 階段 = 「**tour 撰寫（LLM）**」＋「**測試執行（Node，確定性）**」兩段，接在 deploy 之後、沿用同一台測試區 DB。

```
deploy 成功 (status=playwright_running)
        │
        ▼
 tour-author agent（LLM）───► 寫入模組（worktree）：
   · <module>/static/tests/tours/<name>.js   （tour steps＋斷言）
   · <module>/tests/test_<name>.py           （HttpCase：Python 先備資料 → start_tour）
   · <module>/tests/__init__.py
   · __manifest__.py 註冊 web.assets_tests   （tour JS 資產）
   → git commit 到 task 分支
        │
        ▼
 runTourTests()（Node，複用 env-agent execCmd）：
   venvPython odoo-bin -i/-u <mod> -d test_<dir> --stop-after-init \
     --test-enable --test-tags /<module> --addons-path … <odooDbArgs>
   → exit code ＋ log
        │
        ▼
 verdict（複用 deploy 的 extractOdooError / classifyFailureWithAgent）：
   exit 0                      → review_pending
   tour/斷言失敗（code）        → 退 coding 計數（滿 PW_LIMIT→stopped）
   env（chromium 缺/連不上/起不來）→ stopped, blocker_type=env
```

## 5. 元件與介面

### A｜tour-author agent：改寫 `.claude/agents/playwright.md`
- 職責改為：依 analysis_yaml 為**本次新行為**產出 tour，寫入模組並 commit。
- prompt 硬規則：
  - tour 放 `<module>/static/tests/tours/<name>.js`，用標準 tour step（`trigger`/`run`/`content`），斷言用 tour 內建等待（不自行 sleep）。
  - `HttpCase` 放 `<module>/tests/test_<name>.py`，**需要前置資料時在 Python `setUp` 建立**（如先建一張 sale.order），再 `self.start_tour(url, 'tour_name', login=...)`。
  - 於 `__manifest__.py` 的 `assets['web.assets_tests']` 註冊 tour JS。
  - 只新增測試檔，**不改動功能程式**；完成後 commit 到 task 分支。
  - 禁止：`require('playwright')`/`chromium`、寫死 URL/埠、額外 diag 腳本。
- 已知取捨：tour DSL 有學習成本，但比「驅動瀏覽器」遠為受限、可預期；Odoo 18 除錯模式有 tour 錄製器可輔助人工修。

### B｜測試執行：`runTourTests(projectId, moduleName)`（新，`env-agent.js` 內，`upgradeModules` 的姊妹）
- 組指令＝現行 `upgradeModules` 指令 ＋ `--test-enable --test-tags /<moduleName>`。
- 沿用 `execCmd`、`test_<dirName>` DB、`addonsPath`、`odooDbArgs()`、600s timeout。
- 非 0 結束即 throw（含完整 log）供上層判定，與 `upgradeModules` 一致。

### D｜chrome 前置（併入環境建置：`env-agent.js` `runEnvSetup`）
- tour 的 `browser_js` 需 chrome/chromium 執行檔。Odoo 於 Windows **只認三個固定路徑**（`common.py` `ChromeBrowser.executable`），不吃 `CHROME_BIN`：
  `%ProgramFiles%\Google\Chrome\Application\chrome.exe`、`%ProgramFiles(x86)%\...`、`%LocalAppData%\...`。
- 本測試機已存在 `C:\Program Files\Google\Chrome\Application\chrome.exe`，符合第一路徑 → **零安裝、自動找到**（跨 Odoo 13→18 一致，版本安全）。
- **關鍵雷（Rule 12）**：Odoo 找不到 chrome 時 `raise unittest.SkipTest`——tour 被**靜默跳過**、`odoo-bin` 仍 exit 0 → 假綠燈。故在 `runEnvSetup` 的 clone/venv/pip/init 之後加一步 `chromeCheck`：三路徑皆不存在 → env 標 `error`＋明確訊息（請安裝 Google Chrome），**不讓環境算就緒**。chrome 這件事在「環境就緒」時一次確定，E2E 階段不再處理。

### C｜階段串接：改寫 `playwright-agent.js` → `runTourStage()`
- 開頭仍 `ensureEnvRunning`（沿用）。
- 呼叫 A（透過 `runClaude` 讓 agent 寫 tour 並 commit）→ 再呼叫 B（`runTourTests`）。
- verdict 對映**完全複用** deploy 既有邏輯：`extractOdooError` 抽錯、`classifyFailureWithAgent` 分 code/env/transient、transient 自動重試一次。
- 階段流轉沿用現況：pass→review_pending；code→退 coding（`pw_retry_count`，滿 `PW_LIMIT`→stopped）；env→stopped(blocker_type=env)。**不改** runner/DB schema。

## 6. 判定與錯誤處理

- **pass**：odoo-bin exit 0（模組裝好且 tour 全過）。
- **code**：log 出現 tour step 失敗／斷言不符／模組載入錯 → 退 coding。
- **env**：連不上 DB、env 起不來 → stopped/env，明確報錯（Rule 12 fail loud），log 落地 `data/logs`（沿用 `saveDeployLog` 模式）。chrome 缺失已於環境建置擋下（見 D），不會走到這裡。
- **防假綠燈（Rule 12）**：exit 0 還要確認 tour **確實執行**——log 需出現該 tour 名稱且非 `skipped`／`0 tests`；只要偵測到 tour 被 skip（chrome 意外消失等）即判 env，不得當 pass。

## 7. 測試（Rule 9：測意圖）

- `env-agent.test.js`（擴充）：mock `execCmd`，斷言 `runTourTests` 送出的 args **含 `--test-enable` 與 `--test-tags /<module>`** 且 DB＝`test_<dir>`——鎖住「用 Odoo 官方 test runner 對正確 DB 跑」的意圖。
- `playwright-agent.test.js`（改）：mock A/B，驗 exit 0→review_pending、code→coding_running＋計數、env→stopped/env 三路對映不回歸。
- 真實 tour 對 running 測試區：列一次性人工 smoke（跑一支樣本 tour 驗綠燈），記於實作 PR 說明。

## 8. 推進步驟（實作計畫再細分）

1. `runEnvSetup` 加 `chromeCheck` 步驟＋單元測試（三路徑皆缺 → env error）。
2. `runTourTests()` ＋ 單元測試（args 含 test-enable/test-tags）。
3. 改 `playwright-agent.js` → `runTourStage`：串 A→B，複用 deploy 的 verdict 對映；含防假綠燈（tour 非 skipped）＋測試。
4. 改寫 `playwright.md`：tour-author 規則（含 HttpCase 備資料、manifest 資產、只寫測試檔）。
5. 一次性人工 smoke（樣本 tour 綠燈）。
6. 清理殘留 worktree 舊 `e2e_*.spec.js`（可選收尾）。

## 9. 風險

- **chromium 供給**：測試機**已有** `C:\Program Files\Google\Chrome\Application\chrome.exe`（符合 Odoo 首選路徑），零安裝。真正風險是「chrome 消失 → tour 靜默 skip → 假綠燈」，已由 D（環境建置檢查）＋ §6 防假綠燈雙重擋下。
- **tour DSL 撰寫品質**：agent 產 tour 需良好 prompt 範例；比瀏覽器導覽可預期，但仍需人工 smoke 把關。
- **前置資料**：複雜流程要在 HttpCase `setUp` 用 ORM 備資料，prompt 需明確指引（比 UI 建資料穩）。
- **與 deploy 重疊**：E2E 會對已升級模組再跑一次 `-u --test-enable`；可接受。若要更省，未來可評估「deploy 直接帶 --test-enable」把兩段併一（本次不做，保留 deploy/e2e 計數分離）。

## 10. 出處

- Odoo 官方測試文件（tours / HttpCase）：https://www.odoo.com/documentation/18.0/developer/reference/backend/testing.html
- Playwright 官方（storageState 認證複用、POM、fixtures、web-first 斷言）：https://playwright.dev/docs/auth 、 https://playwright.dev/docs/pom 、 https://playwright.dev/docs/test-fixtures
- 為何避免 networkidle：https://github.com/mskelton/eslint-plugin-playwright/blob/main/docs/rules/no-networkidle.md
