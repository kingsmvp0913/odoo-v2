---
name: improve-channel-stalled-silently
description: 自動改善通道 2026-09-04 起整條停擺的三段真因鏈、破快取清單過期害前端改動看不到，以及健檢頁／改善提案頁的職責重分工；含「判文字長短只能量 DOM」
metadata: 
  node_type: memory
  type: project
  originSessionId: bafe800a-6f4d-4952-84e9-b54cee7e0396
---

`[[health-fix-channel-verified]]` 記的「修正通道已實跑驗證」在 08-21 是真的，但 **09-04 之後整條停擺**且畫面零訊號。2026-09-05 全部修完並 push（`0dd75a34`→`d5c3c717`，測試 4147→4154 零回歸）。

## 停擺的三段真因鏈

1. **真因當場蒸發**。claude CLI 自己判定失敗時，訊息在 stdout 的 result 事件（`subtype`／`is_error`），而 `claude-runner.js` 在非 0 exit 只讀 stderr（是空的），只留「exited with code 1」。feedback_triage 那關 `taskId=null`，連 `task_events` 都不落地 ⇒ **9/4 那晚為什麼連掛 5 次至今不明**。已修：stderr 空時改用 result 事件的錯誤字面。
2. **一次暫時失敗＝永久卡死**。`triageOne` 把「執行失敗」與「看不懂」共用同一條 `rejectBack`（退回 `status='new'`），但 `fetchApprovedFeedback` 只撈 `approved` ⇒ 退回去的再也不會被重試。已修：執行失敗回 `transient:true`、維持 approved，由呼叫端走既有 `fix_attempts` 飢餓防線。
3. **黑洞**。健檢提案 approved 後會被 `openFeedbackForFinding` 開成 feedback 單，而 `fetchHealthCandidates` 排除「已開單」的 ⇒ 那張單一旦不是 approved，兩條路都撿不到。缺陷 2 修好後不再新生。

**查證線索**：`token_usage` 的 `agent_type='feedback_triage'`／`status='error'`（recorded_at 緊接健檢 `finished_at`、每筆 duration ~1500ms＝CLI 啟動就死）；`feedback.triage_note` 存著「執行失敗：…」；`health_check_runs` 一直沒有 `cadence='nightly-fix'` 的列——因為批次在「沒有候選」時**早退在 INSERT 之前**（`nightly-fix.js:593`），所以「昨晚有沒有跑」查無可查。

## 改了前端使用者卻看不到（獨立缺陷，同日發現）

`index.js` 的 `VERSIONED_ASSETS` 列死六個檔，其中兩個早就不存在（ui-next 已把 `UiNextPages.js` 拆成 `pages/` 26 支、`ui-next-pages.css` 拆成 9 支）⇒ **改任何一支 View 或分頁 CSS，版本號都不會變**，使用者永遠拿快取的舊碼、畫面零徵狀。加上 `index.html` 自己沒帶 `Cache-Control`，整套 cache-busting 從頭被繞過。已改成掃目錄 ＋ `no-cache`。
⚠ 既有測試只動 `ui-next.css`（剛好在那份清單裡）⇒ 全綠卻擋不住。**測試挑的檔案就是它的鑑別力來源**。
另：那支測試把 mtime 推到未來且不還原 ⇒ 下一輪的 `now+60s` 可能還小於殘留值，版本號不變 → 單跑綠、全跑紅。改成「比目前送出的版本號再 +60s」保證單調遞增，並在 afterAll 收回。

## 兩頁的職責重分工（09-05 使用者裁決）

- **健檢紀錄頁＝純 log**。原本的七張提案卡片、四顆裁決鈕、裁決理由輸入框，以及「修這條 → 採用 → 推上 GitHub → 合併並重啟」整條鏈**全部移除**（使用者：「直接拿掉不要了」，理由是已核准的提案每晚自動跑）。剩四欄列表（時間／等級／要不要改善／提案數）＋點列展開看該輪產出。
- **改善提案頁（`AdminFeedback`）＝所有處置**。核准／駁回／刪除／立即執行改善。狀態欄改由 `stateOf` 產生：翻譯掛掉時 status 仍是 approved，只印「已核准」會把失敗藏起來。
- 兩支守衛測試跟著搬家：retire-prefix 從 `isMachineRetired` 改釘 `AdminFeedback` 的 `stateOf`；「擋下這條」那支改成**擋住有人又把裁決鈕加回健檢頁**。
- `POST /api/admin/nightly-fix` 早就存在但**前端從來沒有入口**，已補在改善提案頁。

## 前端通則

**判一段文字「長到需要收合」只能量 DOM，不能用字數估**——中英混排與換行讓同樣字數高度差很多，門檻 180 有 5 條、260 仍有 2 條「掛了按鈕但根本沒被截」，按下去畫面完全不動。改成量 `scrollHeight` 比摺疊上限（`overflow:hidden` 不改變 scrollHeight）。**只收主文等於沒收**：主文常剛好四行內，底下的細節區塊一路攤開，卡片照樣佔滿畫面。
摺疊的淡出要用 **mask 不要疊漸層 `::after`**：後者得寫死背景色，套進表格列後 hover 換底色就露出色差。
`.pill` 是 inline-block 短標籤，**套在整句訊息上會被壓成一個字一行的直條**（「執行失敗：claude exited with code 1」變成 6 行寬 1 字）——那就是使用者說的「跑版」。長訊息用一般文字塊＋左側色條。
驗證手法見 [[ui-next-frontend-verify-loop]]。

⚠ 使用者尚未實測「立即執行改善」那條路徑（09-05 收工時他正要重啟後測）。
