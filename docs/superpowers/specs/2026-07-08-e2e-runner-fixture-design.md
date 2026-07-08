# E2E 測試改造：固定 runner ＋ 共用 fixture

日期：2026-07-08
狀態：設計已核可（架構＋導覽策略），待複審後進實作計畫

## 1. 問題（來自實測歷程）

以「報價單客戶下增加備註T欄位」單（`manual_1783326354710`）為樣本，追三次 E2E：

| 次 | 腳本用的 URL | 結果 | 真因 |
|---|---|---|---|
| run1 03:49 | `localhost:8069`（腳本寫死） | 登入失敗 | 打到錯的埠，該台無此測試帳號 |
| run2 05:50 | `localhost:8069` | connection refused | 該埠無服務 |
| run3 07:22 | `127.0.0.3:8070`（agent 手動改成注入值） | 登入成功但導覽鬼打牆 6.5 分後被手動暫停（記為 aborted / 0 token） |

根因（系統性，非單一單）：

1. **沒有固定 harness**：專案無 `playwright.config`、無人用 `@playwright/test`；agent 每次用 `require('playwright')` + `chromium.launch()` 手刻腳本並 `node xxx.spec.js` 跑。
2. **沿用寫死 URL 的舊 spec**：worktree 殘留上一輪 spec（`localhost:8069` 寫死），多個 worktree 皆有（`manual_1783319749063`、`manual_1783326354710`），每張單重演打錯埠。
3. **手刻等待必踩雷**：`waitForLoadState('networkidle')` 在 Odoo（longpolling/bus）永不 idle → 30s timeout；找不到元素 → 20s timeout。
4. **失敗反射是再寫 diag 腳本**：run3 連寫 `diag.js`→`diag11.js` 共 11 支拋棄式探針，每支付 20–30s timeout＝ token 與時間主要黑洞。
5. **漂亮路由假設錯**：agent 試 `/odoo/sales`、`/odoo/apps` 全 404（該台走 hash 路由）。
6. **prompt 沒規範怎麼跑**：`playwright.md` 只說「用 Playwright 撰寫測試腳本」，agent 自由發揮成上述反模式。

## 2. 目標與成功標準

- **省 token**：agent 只寫「本次變更的斷言」（數行），不寫 harness、不寫 diag 腳本。
- **穩定**：以 `@playwright/test` 的 web-first `expect().toBeVisible()` 自動重試取代手動 timeout；不再出現 networkidle 卡死。
- **準確**：一律打注入的 `test_url`，不可能打錯埠；pass/fail 由 playwright exit code 判定，不靠 LLM 自述。
- **自動化**：pipeline 依 `npx playwright test` 的 exit code ＋ JSON reporter 取結果。

成功判準：對同一「加欄位」型任務重跑，E2E 單次 < 60s、無 diag 腳本、無寫死 URL、verdict 來自 exit code。

## 3. 非目標（YAGNI）

- **不加 `routing_mode` DB 欄位**：fixture 用 app-switcher UI 點擊導覽，跨 Odoo 版本通用，不碰 `/odoo/<slug>` 也不寫死 action id。
- 不改 pipeline 的階段流轉（pass→review_pending、fail→退 coding、env→stopped 全部沿用）。
- 不動 `parseAgentResult` 的 `<result>` JSON 協定（見 §6，agent 仍回同格式，只是來源改為 exit code）。

## 4. 架構

```
env.url ──┐
E2E_LOGIN ─┼─ (playwright-agent.js 注入 env + cwd) ──► e2e-runner/（固定，不在 repo/worktree）
E2E_PASSWORD┘                                          ├─ playwright.config.js  (baseURL=E2E_BASE_URL)
                                                       ├─ fixtures.js           (login / openApp)
                                                       └─ tests/<task_id>.spec.js（agent 每次覆寫，只寫斷言）
                                                            │
                                              npx playwright test ──► exit code + JSON report ──► verdict
```

## 5. 元件與介面

### B-1｜固定 E2E runner：`app/server/pipeline/e2e-runner/`
- 位置刻意在 repo/worktree 之外——E2E 只靠 URL 打已部署測試區，不需原始碼；徹底根除「沿用 worktree 舊 spec」。
- `package.json` + `playwright.config.js`：
  - `use.baseURL = process.env.E2E_BASE_URL`
  - `use.trace = 'on-first-retry'`、`retries: 1`、`use.actionTimeout` 合理值
  - `reporter: [['json', { outputFile: 'report.json' }]]`、`testDir: 'tests'`
- `@playwright/test` ＋ chromium 由 `ensureE2eRunner()` 一次性安裝（見 B-3）。
- 版控：commit `package.json`/config/fixtures；**不 commit** `node_modules`、`tests/*`、`report.json`（列入 `.gitignore`）。

### B-2｜共用 fixture：`e2e-runner/fixtures.js`
- `login(page)`：導向 `${baseURL}/web/login`，填 `process.env.E2E_LOGIN` / `process.env.E2E_PASSWORD`；以 `expect(登入後 shell locator).toBeVisible()` 確認；**禁用 `networkidle`**；密碼不印出。
- `openApp(page, appName)`：點 app-switcher（home menu 按鈕）後點文字 = `appName` 的 App 磚。跨版本通用。
- 導出 `test`/`expect`（re-export 自 `@playwright/test`）供 spec 直接引用。
- 已知取捨（使用者已接受）：`openApp` 靠 App 顯示名稱（語系相依）；若日後多語系造成不穩，改由 task spec 自帶導覽目標。

### A｜prompt：`.claude/agents/playwright.md`
- 縮為硬規則，不再複製 B 的導覽知識（B 為知識本體，避免 drift）：
  - 測試寫入 `tests/<task_id>.spec.js`，`import { test, expect, login, openApp } from '../fixtures'`（或相對 fixtures 路徑）。
  - **只寫本次變更帶來的新行為斷言**；用 `expect().toBeVisible()` 等 web-first 斷言。
  - 禁止：`waitForLoadState('networkidle')`、寫死任何 URL/埠、`chromium.launch()` 手刻、另寫 diag/debug 腳本。
  - 收尾一律 `npx playwright test tests/<task_id>.spec.js`，依其 exit code ＋ `report.json` 定 verdict。

### C（重新定義）｜URL 紀律：`playwright-agent.js`
- 原本 `cwd = worktreeParent(...)` → 改為指向 `e2e-runner/`。
- 注入 env：`{ E2E_BASE_URL: env.url, E2E_LOGIN, E2E_PASSWORD }`。
- 帳號本無壞；只要永遠打注入 URL，run1/run2「打錯埠」不再發生。

### B-3｜`ensureE2eRunner()`（新，`e2e-runner` 內或旁）
- 冪等：`node_modules`/chromium 缺才 `npm install` ＋ `npx playwright install chromium`；與 `ensureEnvRunning` 同風格，於 `runPlaywrightAgent` 開頭呼叫。

## 6. 判定與錯誤處理

- `runPlaywrightAgent` 沿用現行分支（pass→review_pending；fail→退 coding／計數；env→stopped），**不改**。
- agent 仍回：`<result>{"verdict":"pass|fail","failure_type":"code|env","plan":...,"report":...}</result>`，但來源改為確定性訊號：
  - playwright exit 0 → `pass`。
  - 斷言失敗（report 有 failed assertions）→ `fail` / `failure_type:code`。
  - 連不上 baseURL、登入 fixture 失敗 → `fail` / `failure_type:env`。
- report 摘要（哪個 spec/step、預期 vs 實際）取自 `report.json`，不需 LLM 重述細節。

## 7. 測試（Rule 9：測意圖）

- `playwright-agent.test.js`（擴充）：mock `runClaude`，斷言以 `cwd=e2e-runner`、`env.E2E_BASE_URL=env.url` 呼叫——鎖住「永遠打注入 URL」這個意圖，改壞會紅。
- `ensure-e2e-runner.test.js`（新）：node_modules 存在時跳過安裝（冪等），缺時觸發安裝指令（mock exec）。
- fixture 針對真實 Odoo 的行為：無法在 pg-mem/jest 內單元化 → 列為一次性人工 smoke（對 running 測試區跑一支樣本 spec 驗 login+openApp），記錄於 runner README。

## 8. 推進步驟（實作計畫再細分）

1. 建 `e2e-runner/`（config + fixtures + package.json + .gitignore + README），本地對 running 測試區 smoke 過。
2. `ensureE2eRunner()` ＋ 單元測試。
3. 改 `playwright-agent.js`：cwd/env 注入 ＋ 擴充測試。
4. 改寫 `playwright.md` prompt。
5. 清理殘留 worktree 舊 spec（`e2e_*.spec.js`）為可選收尾。

## 9. 風險

- App 顯示名稱語系相依（見 B-2 取捨）。
- runner 首次安裝 chromium 耗時／需網路 → `ensureE2eRunner` 需 log 進度並在失敗時歸為 env、明確報錯（Rule 12 fail loud）。
