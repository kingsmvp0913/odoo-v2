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
| `baseline/` | ✗ | 基線圖。門禁的一半，但**只在本機有效**（見下） |
| `inventory/` | ✓ | 盤點資料（待遷移清單等） |
| `snapshots/` | ✗ | 每次執行的截圖 |
| `diff/` | ✗ | 差異圖，只在門禁失敗時產出 |
| `.fontroot/` | ✗ | 截圖用的中文／emoji 字型，43MB 二進位（見下） |
| `.pw-browsers/` | ✗ | 截圖用的 Chromium，650MB（見下） |

`baseline/`、`snapshots/`、`diff/`、`.fontroot/` 已在 repo 根 `.gitignore` 排除。

**基線圖為什麼不進版控**：基線拍的是正式區畫面，會把真實任務標題、專案名稱、用量數字寫進 git 歷史，刪不掉。取捨後選擇不進版控，代價是門禁不可攜——換機器或換 worktree 要自己重跑 `npm run rwd:baseline`，且**重產前務必確認是乾淨 HEAD**，否則會把未驗證的破版收進基線，門禁從此驗不出東西。

**字型為什麼隨 repo 走**：本專案的容器沒裝中文字型（`fc-list :lang=zh` = 0），中文會全部渲染成豆腐框 □。方框寬度不等於中文字寬，拿那種圖判斷手機版會不會擠爆是量錯的——對 RWD 專案而言是致命的。容器內無 root、apt 索引也是空的，裝不進系統目錄，因此改放 repo 內、由 `capture.js` 指定 `XDG_DATA_HOME`（`/etc/fonts/fonts.conf` 的 `<dir prefix="xdg">fonts</dir>`）。字型檔不進版控，換機器時重抓：

```bash
mkdir -p app/rwd/.fontroot/fonts && cd app/rwd/.fontroot/fonts
curl -sSLO https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/OTC/NotoSansCJK-VF.otf.ttc
curl -sSLO https://github.com/googlefonts/noto-emoji/raw/main/fonts/NotoColorEmoji.ttf
```

`.fontroot/fonts/` 裡**沒有任何字型檔**時 `capture.js` 直接停下（退出碼 1），不會默默改用系統字型：目錄還在、裡面空了是換機／容器重建後的常態，而那時重拍基線就是拿豆腐比豆腐——門禁照樣全綠，只是它量的已經不是中文版面。確定要用這台的系統字型拍（基線與別台不可比、只在本機有效）就設 `RWD_ALLOW_SYSTEM_FONTS=1`。

**Chromium 為什麼也隨 repo 走**：原本裝在 `/opt/pw-browsers`，容器一重建就沒了（本容器只有 `odoo-v2`／`odoo-envs`／`.claude` 三處持久）。重裝拿到的是新版，而**換一版 Chromium，同一份 HTML 的文字描邊就有 subpixel 差異，42 張桌機基線會一次全紅**（2026-08-07 實際發生過，全部 42 組 diff 非零，但逐字比對版面與資料都沒動，純粹是描邊）。基線比的是像素，所以瀏覽器跟字型一樣得釘在 repo 內：

```bash
cd app && PLAYWRIGHT_BROWSERS_PATH=$PWD/rwd/.pw-browsers npx playwright install chromium
```

`capture.js` 在 `require('playwright')` **之前**把 `PLAYWRIGHT_BROWSERS_PATH` 指到 `.pw-browsers/`（該變數是載入時就決定去哪找執行檔的，設晚了無效）。已自行設好該變數則不覆蓋。若重裝後版本與基線不同 → 基線失效，只能在乾淨 HEAD 重產。

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

只有在**刻意變更桌機外觀**時才更新基線（本規格前 7 個 Block 都不該發生），並在對應 commit 訊息寫明原因——基線本身不進版控，那行訊息是唯一留得下來的紀錄。

## 基線的體積

實測（`styleguide.html`，1440×5432 全頁）：**約 480–540 KB／張**。這是最長的頁面之一，一般頁面更小。

桌機門禁那 46 張抓 **15–25 MB**，全部落在本機工作目錄，不佔 repo。

## 已知限制

- **兩條路由無法自動截圖**：`#/task/:id/terminal` 需要執行中的任務、`#/projects/:id/db` 需要可用的遠端連線。兩者在 `routes.js` 標 `covered: false`，執行時會列進「人工檢查清單」。
- **動態內容要遮**：用量條、待處理 badge、時間戳每次都不同，`routes.js` 的 `STABILIZE_CSS` 用 `visibility: hidden` 遮掉（保留佔位，才驗得出版面位移）。新加的動態區塊要自行補 `data-rwd-volatile` 屬性，否則門禁會開始假紅——**假紅比沒有門禁更糟，它會訓練人忽略紅燈**。
- **`pixelmatch` 是 ESM**：`compare.js` 用 dynamic import 載入。`require(ESM)` 只在 Node 22+ 可用，而 `DEPLOY.md` 要求 Node 20 LTS，寫成 require 會在部署機上炸。
- **Chromium 已預裝**：`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`。不要跑 `playwright install`。
