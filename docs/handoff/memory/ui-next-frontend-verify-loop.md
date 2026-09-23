---
name: ui-next-frontend-verify-loop
description: 改完 ui-next 前端要自己截圖驗證的完整手法（自簽 JWT、量 computed 值），與模板字串裡反引號會炸掉整支檔的陷阱
metadata: 
  node_type: memory
  type: project
  originSessionId: 79fe7f3b-2968-480c-a646-b2587c0840f3
  modified: 2026-09-11T02:07:11.459Z
---

前端沒有自動化測試（rules/frontend.md #30），但**不必等使用者回報**——playwright 已裝在 repo 內，可以自己開畫面截圖 + 量 computed 值。2026-09-03 改任務對話時全程靠這個迴圈驗完。

**取得能登入的 token**：`~/.claude/nightshift.env` 的 `RWD_TOKEN` **會過期**（症狀：截到登入頁，或 `/api/tasks` 回 `Invalid token`）。自己簽一顆：

```bash
export RWD_TOKEN=$(cd app && node -e "const jwt=require('jsonwebtoken');const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync('../data/config.json','utf8'));
console.log(jwt.sign({userId:2},cfg.JWT_SECRET,{expiresIn:'2h'}));")
```
`JWT_SECRET` 與 `DATABASE_URL` 都在 `data/config.json`（不在 `.env`）。userId 要對：`GET /api/tasks/:id` 帶 `user_id = $2 OR isAdmin` **且 `is_hidden = false`**——「Task not found」多半是這兩條之一，不是路由壞掉。實測 `review_pending` 的任務全都 `is_hidden=true`，要驗那一關得暫時翻旗標再翻回去。

腳本骨架照抄 `~/.claude/nightshift-ref/verify-zoom.js`（`PLAYWRIGHT_BROWSERS_PATH` 指到 `app/rwd/.pw-browsers`、`XDG_DATA_HOME` 指到 `.fontroot` 否則中文變豆腐框）。兩個判讀點：
- **`fullPage:true` 截不到捲動內容**——真正在捲的是 `.ui-next-main`（見 [[ui-next-css-traps]]），要先 `e.scrollTop=e.scrollHeight` 再截。
- 光看圖不夠，順手 `p.evaluate()` 回傳 `getComputedStyle` 與 `getBoundingClientRect`：改寬度那次就是靠「chat 的 grid 第二欄 777px vs 任務頁 902px」定位問題，肉眼看不出 125px。

**要驗「按下按鈕後的行為」而不寫真資料**（2026-09-11 #25 送出跳頂驗證）：
- 拿元件實例：`el.__vueParentComponent` 在這個 build **拿不到**（找不到元件）。改走 router：找有 `__vue_app__` 的元素 → `config.globalProperties.$router.currentRoute.value.matched.at(-1).instances.default`，就能直接呼叫 `load()`／`reject()` 等 method。
- 防寫入兩層：頁內把全域 `Api.post`／`Api.postForm` 換成假的（`const` 全域在 `p.evaluate` 裡直接可見），**再加** `p.route('**/api/**')` 把所有非 GET 在網路層 fulfill 掉並記下來——進頁本身就會打 `POST inbox/task/:id/read`，只 stub Api 擋不到它。
- 量 `.ui-next-main` 的 `scrollHeight - scrollTop - clientHeight`，送出前後各量一次；腳本在 session scratchpad 的 `repro-scroll.js`／`verify-send-scroll.js`。

**要證明「桌機完全沒變」用網路層 A/B，不要拿舊截圖比**（2026-09-11 手機版 `45c34a5c`）：
共用 checkout 上別的 session 會同時改 CSS／資料也會跳，「改前截的圖 vs 改後」差異分不出是誰造成的。
改用同一時刻開兩個 context：A 用 `ctx.route` 攔 `/`、`ui-next.css`、`UiNextApp.js` 把自己的改動字串替換回去（替換不到要印警告），B 原樣；
加 `animation/transition:none` 後 pixelmatch 比。1440/1024/768×14 頁×深淺色 84 組全 0 才算數。腳本在該 session scratchpad 的 `desk-ab.js`。
手機規則一律寫進 `ui-next-pages/10-mobile.css`（整份只有一個 `@media (max-width:767px)`）；`@media` 內的 selector 不計入跨檔重複基線。
**未驗**：`100dvh` 讓對話輸入框不被網址列擋住，無頭瀏覽器沒有伸縮網址列，只能真機看。

**模板字串裡的 HTML 註解不能出現反引號**（2026-09-05 又中一次：健檢自動改善通道的 `a791fe13` 在 TaskDetail 註解寫 `` `v-if="..."` ``，任務詳細頁整頁打不開、導回首頁；已修 `757782ab`。**沒有任何測試會擋這個**——jest 不載前端檔，deploy 也不管平台自身前端）。View 檔的 `template:` 是 template literal，註解裡寫 `` `> div:first-child` `` 會提前結束字串。症狀極難認：瀏覽器 console 只有 `Unexpected token ':'`、整支 View 沒定義、router 靜默把你導回 `#/`，畫面停在「載入中...」。**`node --check <該檔>` 一秒定位**，改前端後養成跑一次的習慣。
