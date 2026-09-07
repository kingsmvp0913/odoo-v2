---
name: nightShift
description: Use when the user leaves for the day and wants unattended overnight progress on a task they nominate at clock-out. The assignment file docs/nightshift-assignment.md is the authoritative scope; this skill defines the per-round contract — usage-quota gate, decision anchors, screenshot verification, git safety — and the morning handoff. Invoke at clock-out; each scheduled wake-up re-reads this file.
---

# 夜班：無人值守推進「當晚指定的那一件事」

使用者下班前**指定當晚要做哪一件事**，寫成工作單 `docs/nightshift-assignment.md`；夜班照著推進。
**每一輪都從這份檔案重新開始** —— 對話可能已被 compact、session 可能已重開，所以任何「記在腦子裡」的東西都不算數。狀態一律讀檔。

⚠ 本 skill **不預設題目**。沒有工作單就沒有夜班（見第 2 步）。歷史上它曾綁死在「UI Next 改版」，
結果那份待辦來源被刪掉之後，交班檔連續 98 輪記「無變化」。題目改由工作單帶入就不會再發生。

## 為什麼不靠 compact

無法主動觸發 `/compact`。因此設計上**把狀態外部化**：進度寫回 spec 的狀態表，待審事項寫進交班檔。context 掉了不影響接手。

---

## 每輪六步

### 1. 額度閘門（先做，沒過就停）

```bash
TOK=$(python3 -c "import json;print(json.load(open('/home/odoo/.claude/.credentials.json'))['claudeAiOauth']['accessToken'])")
curl -s -H "Authorization: Bearer $TOK" -H "anthropic-beta: oauth-2025-04-20" \
  https://api.anthropic.com/api/oauth/usage | python3 -m json.tool | grep -A3 seven_day
```

**門檻寫在當晚的工作單裡**（`docs/nightshift-assignment.md` 的「額度門檻」欄）。
**週額度（`seven_day.utilization`）≥ 該門檻 → 立刻停止本輪**，不寫任何碼，把「因額度停手」記進交班檔，不再排下一輪。

工作單沒寫門檻時用 **60**（2026-08-31 的原始裁決，理由是保住隔天上班的額度）。
數字每次都可能不同——2026-09-02 是 70、2026-09-07 也是 70。**以工作單為準，不要照抄本檔的 60。**

**重置時間以 API 回的 `resets_at` 為準，不要照著本檔或前一輪的推算規劃額度。**
2026-09-02 實測：同一場作業內 `utilization` 從 50% 掉到 2%，而當時記錄的 `resets_at` 還在隔天——
拿推算值去分配「還剩幾個百分點可以用」會失準。每輪重新讀。

5 小時額度撞到不用停 —— 它每 5 小時自己回滿，等下一輪即可。

### 2. 校準（狀態可能被別人改過）

```bash
cd /home/odoo/odoo-v2 && git pull --ff-only origin master
```

#### 2a. 讀當晚的工作單（**唯一題目來源**）

```bash
cat /home/odoo/odoo-v2/docs/nightshift-assignment.md
```

工作單由使用者下班前指定、由當時的 session 寫檔。它決定**當晚做哪一件事**，格式見本檔末〈工作單格式〉。
裡面的裁決（範圍、額度門檻、push 策略、完成定義）**一律優先於本 skill 的預設值**。

**工作單不存在、或狀態已是「已完成」 → 停止，不排下一輪**，並在交班檔寫明原因。
**不要自己找事做。** 找不到題目不等於閒著沒事，那是「使用者今晚沒交辦」或「訊號壞了」，兩者都該停。

> 這條是有代價換來的：本 skill 原本把題目綁死在兩份規格書上，那兩份後來被刪掉，
> 而當時沒寫「來源全空怎麼辦」，於是交班檔連續 **98 輪**記「維護模式、無變化」，每輪都花額度確認一次沒事做。

#### 2b. 接上一輪的進度

`docs/nightshift-review.md` 的最後一輪 —— 那裡有「仍未做／沒驗到」清單與上一輪自己拍板的結果。
**工作單定範圍，交班檔定進度到哪裡。** 兩者對不上時記進交班檔，不要自己調和。

### 3. 做

一次只推一項。有測試先寫測試。遵守 `.claude/rules/always.md` 與 `CLAUDE.md`。

### 4. 驗（**不准信 exit code**）

```bash
cd /home/odoo/odoo-v2/app && npm run test:quiet > /tmp/t.log 2>&1; echo "EXITCODE=$?" >> /tmp/t.log
grep -E '^Tests:|^Test Suites:' /tmp/t.log
```

判紅綠**只看 `Tests:` 那行**。原因有二，都是這個 repo 的實證：

- `project-routes.test.js` 會在案例通過後嘗試連外部 PostgreSQL，害 Jest 非零結束（CORRECTION-SPEC 自己記的，且**尚未建立乾淨 HEAD 基線**）
- 本 repo 已因管線吃掉 exit code 誤判三次

**動手前先跑一次全跑當基線**，把 `Tests:` 數字寫進交班檔。之後的新紅燈一律先假設是自己造成的。不要在任何地方寫死「既有紅燈清單」——那種清單會腐爛成放過自己錯誤的藉口。

### 5. 記帳

- 更新對應 spec 的狀態表
- `git status --porcelain -uno` **逐檔挑選**，禁用 `git add -A`
- commit 訊息格式 `[模組]: 為什麼（不是做了什麼）`；模組名取自工作單
- **push 策略照工作單的「push 策略」欄**。工作單沒寫時的預設是**只 commit 不 push**，留給使用者早上審完決定

### 6. 排下一輪

做完接著下一件，不空等。額度閘門沒過或待辦清空則收工。

---

## 硬規則

**cwd 會漂移。** Bash 的工作目錄跨呼叫保留，`cd app` 之後再 `ls .claude/` 會找不到檔案並看起來像「檔案被刪了」（2026-08-31 實際踩到）。每個指令自己帶絕對路徑或先 `cd /home/odoo/odoo-v2`。

**需要拍板的事：有錨點才自己決定。** 使用者裁決是「先選一個做，記下來早上審」，理由是「規格書內參考的對象應該很明確」。所以：

- 找得到明確錨點（GodUI 元件規格、AskMe 實際畫面、同專案既有寫法、spec 白紙黑字）→ **選一個做**，把「選了什麼、根據哪個錨點、還有什麼選項」記進交班檔
- 找不到錨點 → **跳過**，記進交班檔。這條守住 `CLAUDE.md` 的 NEVER guess intent

當晚有哪些已知待拍板事項，看工作單自己列的清單（本檔不寫死——寫死的清單會跟著題目換而腐爛）。

**不動核心與別人的碼。** 只碰 `app/public`（前端）與必要的 `app/server`。改 `app/public` 前先載入 `platformDev` skill（配色 dark-mode 硬規則在那）。

### 改 ui-next 的 CSS 前必讀（2026-08-31 兩次踩到）

**同一條 selector 會被定義好幾次，改了不一定生效。** 同權重的規則後者贏，
所以「改了沒反應」的第一個假設永遠是**它在後面被蓋掉了**。
更陰險的是**移除一條之後，原本被它蓋住的另一條會浮上來**：移掉卡片的 `min-height:210px`，
`min-height` 反而變成 250px（另一條規則），看起來像沒改到。

**2026-09-02 起 CSS 已拆檔**，覆蓋關係現在跨檔案：

- `ui-next-pages.css` **已不存在**（2026-09-02 拆檔），改成 `app/public/css/ui-next-pages/01-…09-*.css`。**別再 grep 舊檔名**
- 載入序＝`ui-next.css` → `01-base` → … → `09-later-patches`。
  **檔名前綴的數字就是層疊順序，不可重排、不可按字母排序**——
  `09-later-patches` 整份是靠排在最後才生效的補丁
- 要找某條規則被誰蓋掉，`grep -rn '<selector>' app/public/css/`，看它出現在哪幾個檔、
  哪個排在後面

（**這裡刻意不寫「重複幾組」**：2026-08-31 夜班期間這個數字從 11 變 9 再變 8，
寫死的數字會腐爛成假事實——`always.md` 規則 2 講的就是這件事。
現況鎖在 `frontend-ui-next.test.js` 的 `CROSS_FILE_DUP_BASELINE`，要知道就去讀那個常數。）

⇒ **改完一定要用瀏覽器 computed style 反查真正生效的值**，不要看原始碼就當作生效：

```js
getComputedStyle(document.querySelector('.ui-next-thread-composer')).width
```

**`--ui-zoom: 1.1`**：`getBoundingClientRect()` 量到的是**縮放後**的視覺尺寸，
`getComputedStyle().width` 是縮放前的值，兩者差 10%（893 vs 812）不是 bug。
**驗 CSS 值看 computed，驗視覺位置才看 rect。**

**改完 `.claude/skills/` 要跑** `node scripts/sync-skills.js`（Codex 讀的是 `.agents/skills/` 的實體副本，不同步時完全沒有徵狀）。

---

## 驗證：截圖

憑證在 `~/.claude/nightshift.env`（repo 外、600、**永不進版控**）。**不要用 scratchpad**——`/tmp` 會被清掉。

```bash
source /home/odoo/.claude/nightshift.env
cd /home/odoo/odoo-v2/app && npm run rwd:capture
```

參考圖與截圖腳本在 `~/.claude/nightshift-ref/`：`askme-home.png`（視覺基準）、`r1-*.png`（改動前現況）、`shot-round1.js`（可直接改路由重截）。

截圖腳本三個必要設定，少一個就出錯：`require` playwright 要用絕對路徑 `/home/odoo/odoo-v2/app/node_modules/playwright`、`PLAYWRIGHT_BROWSERS_PATH` 指 `app/rwd/.pw-browsers`、`XDG_DATA_HOME` 指 `app/rwd/.fontroot`（不設中文變豆腐框）。登入靠 `addInitScript` 塞 `localStorage.aidev_token`。

- 平台埠是 **8771**，不是 rwd 預設的 3939
- **`~/.claude/nightshift.env` 裡的 `RWD_TOKEN` 早就過期了**（2026-09-07 實測：`exp` 停在 2026-09-02 05:55 UTC）。
  **不要用它，也不要因此停手**——自己簽一顆（2026-09-07 實測 `/api/tasks` 回 200）：

  ```bash
  export RWD_TOKEN=$(cd /home/odoo/odoo-v2/app && node -e "const jwt=require('jsonwebtoken');const fs=require('fs');
  const cfg=JSON.parse(fs.readFileSync('../data/config.json','utf8'));
  console.log(jwt.sign({userId:2},cfg.JWT_SECRET,{expiresIn:'12h'}));")
  ```
  `JWT_SECRET` 在 `data/config.json`（**不在 `.env`**）。過期症狀是截到登入頁而不是內容頁。
  細節與其他判讀陷阱見記憶 `ui-next-frontend-verify-loop`。
- **截圖門禁自我比對全綠 ≠ 正確**（它比的是自己）。淺色其實是深色、中文變豆腐框都只有人眼開圖看得到。通過後一定要自己 Read 幾張真圖抽驗

> 以下〈AskMe 是視覺基準〉與〈GodUI 是元件基準〉兩節，**只在當晚工作單的題目與 UI Next 版面有關時才適用**。
> 題目換成別的（後端、pipeline、測試）就整段跳過，不要硬套。

### AskMe 是視覺基準

`https://askme.ideaxpress.biz/`（帳密同一個 env 檔）。

**「一樣」的範圍 = 版面效果，不是功能。** 使用者 2026-08-31 原話：「功能目前大致上是照目前的，我指的一樣是指版面效果，尤其是問答的資料和對話框」。與 CORRECTION-SPEC §「AskMe 的價值是『問題優先、安靜的版面層級、清楚的對話入口』；資料夾、模型選擇、分類推薦等 OAA 後端未支援的能力不納入」一致。

⇒ **不要搬 AskMe 的功能**（資料夾、模型選擇、@ 提及、語音）。OAA 有什麼功能就維持什麼功能，只換版面語言。

**使用者親口點名的優先項**（優先於 spec 內其他項目）：

1. **問答的資料呈現**與**對話框（Composer）**的版面
2. **舊對話「怪怪的」** —— CORRECTION-SPEC 已定契約：新舊對話「只可有資料狀態差異，**不可使用兩套版型或 Composer**」。使用者的回報等於這條沒做到。動手前先截圖看清楚實際症狀，不要憑猜

2026-08-31 實際登入截圖讀到的**版面**規格：

- **側欄** ~305px：品牌＋收合鈕 → New chat／New folder／Search → 分隔線 → Folders（chevron 展開）→ Personal（展開後 chat 標題帶左細線縮排）→ **底部固定** Account 區（使用者／Light mode／Change password／Sign out）
- **主區大留白**，內容不佔滿寬度
- **問候兩層**：小字帶 icon 的「Hi, {name}」＋超大字級、字重輕的主問句
- **Composer 是一張圓角卡**（比背景稍亮、無明顯邊框）：placeholder 在上佔主要高度，工具**橫排在卡片內底部**、小字小 icon、不搶視覺
  - 取的是**這個排法**：輸入區在上、一排低調工具在下、送出鈕在右下角為圓形實心
  - AskMe 該列有 @／附件／魔杖／`Files (n)`／專案 context（`T100 → 標準 → 正式區`，帶 chevron）／模型選擇／麥克風。**只有 OAA 本來就有的才放**——附件與專案 context 有，模型選擇／@／語音沒有就不要加
- **prompt suggestions 在 Composer 下方**，是帶 icon 的文字按鈕，不是卡片
- 全深灰階、幾乎無邊框、靠留白與字級分層

Composer 內嵌專案 context 那條，就是 spec 的 `NEXT-UX-007` combobox。

### GodUI 是元件基準

MCP 可用（`mcp__godui__*`，111 個元件，2026-08-31 實測）。§9 要校準的都在：`combobox`、`conversation-thread`、`prompt-composer`、`toast`、`drawer`、`command-palette`、`dropdown-menu`、`segmented-control`、`animated-tooltip`。

⚠ `get_component` 一次回 4–16KB React 源碼，11 個會吃光 context。**先抽四類資訊再讀**：動效參數／aria／鍵盤／尺寸 token。

---

## 交班檔

`docs/nightshift-review.md`（`docs/` 在 .gitignore，不進版控，同機可讀）。每輪追加，**不要覆寫**：

```markdown
## 輪次 N — HH:MM — 週額度 XX%
- 做了：<項目>，commit <sha>
- 測試：Tests: X passed / Y failed（基線 A/B）
- 自己決定的：<選了什麼>｜錨點：<哪來的>｜其他選項：<什麼>
- 跳過的：<什麼>｜缺什麼才能決定
- 沒驗到的：<哪些改動沒有實機／截圖驗證>
```

**Fail loud。** 跳過的、沒驗的、猜的，一律寫出來。全部標「完成」但其實有東西沒驗，比進度慢糟糕得多。

---

## 停止條件

任一成立就收工，並在交班檔寫明原因：

1. 週額度 ≥ 60%
2. 待辦清空
3. ~~`RWD_TOKEN` 過期~~ → **已不是停止條件**，自簽一顆即可（見〈驗證：截圖〉）。改為：**截圖環境壞掉且修不好**（例如 playwright 起不來、平台 8771 沒回應）
4. 連續兩輪測試紅燈修不好（陷入迴圈，換人比較快）
5. 撞到需要使用者拍板、且找不到錨點的事，**且**剩下的待辦都被同一個決定卡住

---

## 工作單格式

`docs/nightshift-assignment.md`（`docs/` 在 `.gitignore`，不進版控、只在本機）。
下班前由當時的 session 寫，**一晚一份、直接覆寫**。夜班每輪第 2a 步讀它。

```markdown
# 今晚的工作單 — YYYY-MM-DD

- **狀態**：進行中 | 已完成        ← 「已完成」代表夜班該停，不再排下一輪
- **題目**：<一句話>
- **規格書**：<路徑，或「無，範圍就是本檔」>
- **額度門檻**：<數字>%           ← 覆寫本 skill 預設的 60
- **push 策略**：只 commit 不 push | 測試全綠就 push
- **完成定義**：<什麼條件成立才算做完，要可驗證>

## 施工順序
1. …

## 已知待拍板
- <找不到錨點、需要人決定的事>

## 不要做
- <明確排除的範圍>
```

**必填是「狀態」「題目」「完成定義」三欄。** 少了「完成定義」夜班會不知道何時該停，
那就會退化成 98 輪空轉的老毛病。
