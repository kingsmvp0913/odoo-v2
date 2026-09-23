---
name: nightshift-ui-next-handoff
description: UI Next 版面改版夜班：nightShift skill 已建立、使用者三項親口點名的問題、所有裁決（額度 60% 停損／有錨點才決定／只 commit 不 push）、憑證與 AskMe 基準的持久位置
metadata: 
  node_type: memory
  type: project
  originSessionId: d13699e8-9060-453c-96e1-58e04f30d701
---

## 這是什麼

2026-08-31 傍晚，使用者要下班前交辦：做一個 skill，讓我在他下班後自動推進 `?ui=next` 版面改版。skill 已建立在 `.claude/skills/nightShift/SKILL.md`（已跑過 `node scripts/sync-skills.js`）。**細節全在那份 SKILL.md，這裡只記它以外的東西。**

## 使用者親口點名的三件事（優先於 spec 內其他項目）

1. **問答的資料呈現與對話框（Composer）版面**要像 AskMe
2. **舊對話「怪怪的」** —— CORRECTION-SPEC 已有契約：新舊對話「只可有資料狀態差異，不可使用兩套版型或 Composer」
3. **專案區塊「跑版變超醜」**

⚠ 關鍵界定：**「一樣」只指版面效果，不是功能**。原話「功能目前大致上是照目前的，我指的一樣是指版面效果」。不要搬 AskMe 的資料夾／模型選擇／@提及／語音。

## 已定的裁決（別再問一次）

⚠ **以下是「無人值守」時的預設值。使用者在線時會當場改掉，一律以當下交代為準。**
2026-09-02 三條全被推翻過：門檻改 70%（只當次、明言不寫回檔）、要求 push、要求先問再動手。

- **週額度停手門檻**：無人值守 60%（`seven_day.utilization`）。**他在線就問**。
  重置時間讀 API 當下的 `resets_at`，別照推算——09-02 實測同一場作業內從 50% 掉到 2%（見 [[nightshift-idle-98-rounds]]）
- **需要拍板的事：有明確錨點就自己選一個做並記錄，早上給他審**；找不到錨點才跳過。
  **他在線時反過來：先攤開選項讓他挑**（09-02 原話「不要直接改 先評估一下有沒有我要確認的」）
- **只 commit 不 push**（無人值守）。他在線會直接要求 push。
- 交班檔 `docs/nightshift-review.md`（`docs/` 在 .gitignore）

## 持久位置（`/tmp` 的 scratchpad 重開就沒了）

- **憑證** `~/.claude/nightshift.env`（600）：`RWD_TOKEN`（平台，**2026-09-02 13:55 到期**）、`AM_USER`/`AM_PASS`（AskMe: jerry）、`RWD_BASE_URL=http://localhost:8771/`
- **AskMe 基準圖＋OAA 現況圖＋截圖腳本** `~/.claude/nightshift-ref/`
  - `askme-home.png` 是登入後的問答首頁，**今晚的視覺基準**
  - `oaa-*.png` 是重開 server 前的現況，可當 before 對照
- 截圖腳本要用絕對路徑 require playwright（`/home/odoo/odoo-v2/app/node_modules/playwright`），並設 `PLAYWRIGHT_BROWSERS_PATH` 指 `app/rwd/.pw-browsers`、`XDG_DATA_HOME` 指 `app/rwd/.fontroot`（不設字型中文會變豆腐框）

## 判讀陷阱（實際踩到的）

**側欄「專案 CHAT」底下印著 `Not found` ＝ server 跑舊碼，不是版面壞掉。** 2026-08-31 17:36 實測：server 啟動於 17:11:22，但最後 commit 是 17:22:47，`/api/chats/sidebar-projects` 端點在檔案裡卻回 `Not found`，前端把錯誤字串當內容渲染。使用者「專案區塊變醜」有一部分是這個造成的。**重開 server 後要先重截一次再判斷還醜不醜**，否則會去修根本沒壞的 CSS。

**cwd 會跨 Bash 呼叫保留。** `cd app` 之後 `ls .claude/skills/` 回 No such file，看起來像檔案被刪。差點誤判。每個指令自帶絕對路徑。

**`project-chat-one`（`#/projects/:id/chat/:chatId`）在 `app/rwd/routes.js` 是 `covered: false`** —— 截圖門禁根本沒蓋到單一舊對話頁，所以「舊對話怪怪的」一直沒被自動抓到。

**DB 直連 port 5416 在 2026-08-31 是 Connection refused**（platformDB skill 記的 port）。要查 chats 資料得另尋管道或先確認 DB 實際埠。

**Why**：這些狀態全在對話裡，重開 session 就沒了，而 skill 檔只寫「怎麼做」不寫「現在到哪」。
**How to apply**：重開後先讀 `nightShift` skill，再讀本檔補現場狀態。相關 [[claude-usage-widget-stale]]（額度查法）、[[baseline-selfcheck-green-is-not-correct]]（截圖全綠≠正確）、[[platform-restart-kills-container]]（重啟風險）。
