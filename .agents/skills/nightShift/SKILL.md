---
name: nightShift
description: Use when the user leaves for the day and wants unattended overnight progress on the UI Next redesign (OAA UI Next). Defines the per-round contract — usage-quota gate, authoritative todo source, decision anchors, screenshot verification, git safety — and the morning handoff. Invoke at clock-out; each scheduled wake-up re-reads this file.
---

# 夜班：無人值守推進 UI Next 改版

使用者下班後自動推進 `?ui=next` 版面改版。**每一輪都從這份檔案重新開始** —— 對話可能已被 compact、session 可能已重開，所以任何「記在腦子裡」的東西都不算數。狀態一律讀檔。

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

**週額度（`seven_day.utilization`）≥ 60 → 立刻停止本輪**，不寫任何碼，把「因額度停手」記進交班檔，不再排下一輪。

這是使用者 2026-08-31 明確裁決的數字，理由是保住隔天上班的額度。週額度重置在 **9/3 13:00（台北）**，中間都是同一桶。

5 小時額度撞到不用停 —— 它每 5 小時自己回滿，等下一輪即可。

### 2. 校準（狀態可能被別人改過）

```bash
cd /home/odoo/odoo-v2 && git pull --ff-only origin master
```

**待辦來源，依此優先序**：

1. `OAA-UI-NEXT-CORRECTION-SPEC.md` —— 自稱「目前唯一有效進度」，含 `NEXT-UX-001`~`007` 九項需求與各項「尚未完成」驗收欄
2. `OAA-UI-NEXT-ROUND2-SPEC.md` —— 「執行狀態總表」與 **§9 GodUI 全面校準**（ROUND2 範圍內唯一未做的）

兩份**管不同範圍不是互相取代**。真的對不上時以 CORRECTION 為準，並把矛盾記進交班檔，不要自己調和。

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
- commit 訊息格式 `[UI Next]: 為什麼（不是做了什麼）`
- **只 commit，不 push**。push 留給使用者早上審完決定

### 6. 排下一輪

做完接著下一件，不空等。額度閘門沒過或待辦清空則收工。

---

## 硬規則

**cwd 會漂移。** Bash 的工作目錄跨呼叫保留，`cd app` 之後再 `ls .claude/` 會找不到檔案並看起來像「檔案被刪了」（2026-08-31 實際踩到）。每個指令自己帶絕對路徑或先 `cd /home/odoo/odoo-v2`。

**需要拍板的事：有錨點才自己決定。** 使用者裁決是「先選一個做，記下來早上審」，理由是「規格書內參考的對象應該很明確」。所以：

- 找得到明確錨點（GodUI 元件規格、AskMe 實際畫面、同專案既有寫法、spec 白紙黑字）→ **選一個做**，把「選了什麼、根據哪個錨點、還有什麼選項」記進交班檔
- 找不到錨點 → **跳過**，記進交班檔。這條守住 `CLAUDE.md` 的 NEVER guess intent

spec 內已知待拍板：§7.3 九種 action mode 補到什麼程度、§4.4 的 13 處圖示卡在凍結 View 要不要分家。

**不動核心與別人的碼。** 只碰 `app/public`（前端）與必要的 `app/server`。改 `app/public` 前先載入 `platformDev` skill（配色 dark-mode 硬規則在那）。

**改完 `.agents/skills/` 要跑** `node scripts/sync-skills.js`（Codex 讀的是 `.agents/skills/` 的實體副本，不同步時完全沒有徵狀）。

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
- `RWD_TOKEN` 於 **2026-09-02 13:55 到期**。過期症狀是截到登入頁而不是內容頁 —— 看到就停手記進交班檔，不要繼續截一整輪沒用的圖
- **截圖門禁自我比對全綠 ≠ 正確**（它比的是自己）。淺色其實是深色、中文變豆腐框都只有人眼開圖看得到。通過後一定要自己 Read 幾張真圖抽驗

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
3. `RWD_TOKEN` 過期且該輪需要截圖驗證
4. 連續兩輪測試紅燈修不好（陷入迴圈，換人比較快）
5. 撞到需要使用者拍板、且找不到錨點的事，**且**剩下的待辦都被同一個決定卡住
