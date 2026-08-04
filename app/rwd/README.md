# `app/rwd/` — RWD 改造的參考資料與驗收工具

本次 RWD 改造（規格：repo 根的 `RWD-C-SPEC.md`）的一切集中在這個目錄。

這裡的核心產物是**桌機基線圖**。規格 §2 的第一約束是「不能影響網站使用」，而這個目錄存在的唯一理由，就是把那句話變成一條可以跑、會亮紅燈的門禁：**桌機 1440px 的截圖 diff 必須為 0**。

## 目錄

| 路徑 | 進版控 | 內容 |
|---|:---:|---|
| `routes.js` | ✓ | 路由清單、斷點、主題、遮罩設定 —— **唯一真相**，新增路由只改這裡 |
| `capture.js` | ✓ | 截圖 |
| `compare.js` | ✓ | 與基線比對 |
| `lib/session.js` | ✓ | 登入取 token、樣本 id、URL 組裝 |
| `baseline/` | ✓ | 基線圖。**門禁的一半，必須進版控** |
| `inventory/` | ✓ | 盤點資料（待遷移清單等） |
| `snapshots/` | ✗ | 每次執行的截圖 |
| `diff/` | ✗ | 差異圖，只在門禁失敗時產出 |

`snapshots/` 與 `diff/` 已在 repo 根 `.gitignore` 排除。

**基線圖為什麼要進版控**：不進版控就不可攜——換一台機器、換一個 worktree 就驗不了，等於沒有門禁。`rules/always.md` 8 記載過 `docs/` 不進版控造成「spec 傳不到別台機器」的痛，同樣的坑不要踩第二次。

**為什麼在 `app/` 底下**：`rules/infra.md` 113 —— Node 模組解析不跨目錄樹，放 repo 根的話 `require('playwright')` 找不到 `app/node_modules`。

**為什麼不放 `app/tests/`**：jest 的 `testMatch` 是 `**/tests/**/*.test.js`，放進去有被 `npm run test:quiet` 撈走的風險。這裡完全在 jest 視野外。

## 怎麼跑

需要一個**跑起來的平台**與一個 **admin 帳號**。

```bash
export RWD_BASE_URL=http://localhost:3939/   # 預設值,掛子路徑時要改
export RWD_USER=<admin 帳號>
export RWD_PASS=<密碼>

cd app
npm run rwd:baseline   # 建立/更新基線(會覆寫,請先確認在乾淨 HEAD)
npm run rwd:capture    # 截當前狀態到 snapshots/
npm run rwd:check      # 截圖 + 比對(完整 3 個斷點)
npm run rwd:gate       # 只跑桌機門禁那組,最快
```

帳密只走環境變數，**不要寫進任何檔案**。

退出碼：`0` = 門禁通過，`1` = 桌機出現回歸、或桌機基線/截圖缺漏（少比一張不等於通過）。

## 例行用法

每個 Block 完成後：

```bash
cd app && npm run rwd:check
```

- **桌機回歸** → 門禁失敗，差異圖在 `diff/`。修到 0 為止，不要放行。
- **小螢幕變動** → 預期中，只報告不擋，那正是進度證據。

只有在**刻意變更桌機外觀**時才更新基線（本規格前 7 個 Block 都不該發生），更新時在 commit 訊息寫明原因。

## 基線的體積

實測（`styleguide.html`，1440×5432 全頁）：**約 480–540 KB／張**。這是最長的頁面之一，一般頁面更小。

桌機門禁那 46 張抓 **15–25 MB**。這是進版控的一次性成本，可接受；長期膨脹的風險來自「反覆更新基線」，所以規則是**只有刻意變更桌機外觀時才更新**——本規格前 7 個 Block 都不該發生。

`snapshots/`（每次執行都重產）與 `diff/` 不進版控，不佔 repo。

## 已知限制

- **兩條路由無法自動截圖**：`#/task/:id/terminal` 需要執行中的任務、`#/projects/:id/db` 需要可用的遠端連線。兩者在 `routes.js` 標 `covered: false`，執行時會列進「人工檢查清單」。
- **動態內容要遮**：用量條、待處理 badge、時間戳每次都不同，`routes.js` 的 `STABILIZE_CSS` 用 `visibility: hidden` 遮掉（保留佔位，才驗得出版面位移）。新加的動態區塊要自行補 `data-rwd-volatile` 屬性，否則門禁會開始假紅——**假紅比沒有門禁更糟，它會訓練人忽略紅燈**。
- **`pixelmatch` 是 ESM**：`compare.js` 用 dynamic import 載入。`require(ESM)` 只在 Node 22+ 可用，而 `DEPLOY.md` 要求 Node 20 LTS，寫成 require 會在部署機上炸。
- **Chromium 已預裝**：`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`。不要跑 `playwright install`。
