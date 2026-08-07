# 規格書：任務列表篩選持久化（Saved Views）

> 目標讀者：在正式機執行本改動的人或 agent
> 規模：階段 1 純前端單檔；階段 2 需一個後端端點。與其他規格無依賴，隨時可插。

---

## 1. 要解決什麼

`TaskList.js` 的 `data()`（第 99-127 行）全部是字面初始值：

```js
filter: 'needs_action',  sort: 'updated_desc',  search: '',
projectFilter: '',  ownerFilter: '',  statusFilter: '',  sourceFilter: '',
releaseFilter: 'all',  showAllUsers: false,
```

`mounted()`（第 187 行）只掛了 socket callback，**沒有 localStorage、沒有讀 route query**。

結果：篩了「A 專案＋等待審核＋我的」，重整瀏覽器就全部回到預設。手機上更費事——篩選列預設收起（`filtersOpen: false`，第 128 行，因為 8 個控制項佔掉半個畫面），得先展開再點四個下拉。

---

## 2. 設計

### 2.1 兩階段，各自可獨立上線

| 階段 | 內容 | 範圍 | 儲存位置 |
|---|---|---|---|
| 1 | 記住上次用的篩選 | 純前端，單檔 | localStorage |
| 2 | 具名 view（存 2-3 組常用） | ＋一個後端端點 | `users.odoo_settings.saved_views` |

階段 1 完成即可上線，階段 2 非必要。

### 2.2 抄既有的雙軌模式

`theme.js` 已建立本專案的偏好儲存慣例（檔頭第 1 行：「localStorage 即時套用（避免閃爍）+ 登入後同步個人設定」）：

- **localStorage** → 即時、免等 API、無閃爍
- **DB** → 跨裝置，登入後 `syncFromServer` 以後端為準

分工判準（來自既有程式碼）：

- `notify-client.js:1` 桌面通知旗標**只存 localStorage**，理由寫在註解：「權限本就 per-browser」
- `theme.js` **兩邊都存**，因為換裝置要一致

套用到本規格：

- **「上次用的篩選」→ 只存 localStorage**。這是「我這台機器上次看到哪」，per-browser 語意正確，不值得為它打 API
- **「具名 view」→ 存 DB**。使用者刻意命名保存的東西，換裝置該跟著走

### 2.3 ⚠️ 必須用專用端點（本規格最重要的約束）

**`PUT /api/settings` 是整包覆寫，不是 merge。** `Settings.js:78-82` 的註解記錄了實際事故：

> 「PUT /api/settings 整包覆寫 `odoo_settings`（不是 merge），所以得先鋪回載入時的整包，否則**深色模式偏好會被這次儲存從後端刪掉**——本機 localStorage 還在，要換裝置或開無痕視窗才發現永遠回淺色。」

既有解法是為 theme 開專用端點 `PUT /api/settings/theme`（`theme.js:21`）。

**階段 2 必須比照，新增 `PUT /api/settings/views` 做局部更新。** 若圖省事走 `PUT /api/settings`，會重演同一個事故——這次是把 theme 和 saved_views 互相蓋掉。

### 2.4 儲存欄位

**存**（篩選條件）：`filter`、`sort`、`projectFilter`、`ownerFilter`、`statusFilter`、`sourceFilter`、`releaseFilter`、`showAllUsers`

**不存**：

- `search` —— 每次要找的字串不同，記住它會讓下次開啟看到「空無一物的列表」而想不起原因
- `filtersOpen` —— 純版面狀態，且手機／桌機行為不同（≥641px 時切換鈕是 `display:none`）
- `batchMode`、`selectedIds` —— 操作中狀態

### 2.5 具名 view 的儲存形狀（階段 2）

存進 `users.odoo_settings.saved_views`：

```js
[{ name: '我的待審核', filters: { filter: 'review_pending', ownerFilter: 3, ... } }]
```

> **關於 `odoo_settings` 這個欄位名**：它的原始語意是 Odoo 連線設定，但 theme、`teams_user_id` 都已塞在裡面，事實上已是「per-user 雜項設定」的家。本規格**沿用既有慣例**而非新增欄位（專案規則：Conformance > 個人品味；Touch only what you must）。若日後要正名，應該連 theme 一起搬——不在本規格範圍。

上限建議 10 組，超過時前端擋下並提示，避免 JSONB 無限膨脹。

---

## 3. 實作步驟

### 階段 1（純前端）

**檔案**：`app/public/js/views/TaskList.js`（唯一）

1. `data()` 的初始值改為「先讀 localStorage，讀不到才用現有預設」
2. 對 §2.4 的每個欄位加 watcher（或在既有的篩選變更處）寫回 localStorage
3. key 命名比照既有慣例（`theme.js` / `notify-client.js` 都用模組內 `const KEY = '...'`）
4. **讀取要包 try/catch**：`localStorage` 可能被停用（`Settings.js:130` 已有「localStorage 已停用」的處理先例），壞掉時要退回預設值而非白畫面

新增一顆「重設篩選」按鈕——記住篩選之後，使用者需要一鍵回到預設，否則會困在自己上次設的條件裡想不起怎麼清空。既有的 `activeFilterCount`（第 165-168 行）已經在算「還有幾個條件生效」，把按鈕放它旁邊。

### 階段 2（＋後端）

1. `server/settings.js` 新增 `PUT /api/settings/views`，**只更新 `odoo_settings.saved_views` 這個 key**，其餘 key 原樣保留
2. `GET` 現有設定時一併回傳 `saved_views`
3. 前端側欄列出具名 view，點擊套用；提供「儲存目前篩選為…」
4. 授權：`WHERE user_id = req.userId`，不需額外 admin 檢查（規則 92）

---

## 4. 驗證

### 4.1 前端沒有自動化測試

`.claude/rules/frontend.md` 第 30 條：**Jest 不涵蓋 Vue view，改動一律需瀏覽器人工實測，含深色模式。**

人工測試清單：

- [ ] 設定四個篩選 → 重整 → 條件仍在
- [ ] 「重設篩選」→ 回到 `needs_action` 預設
- [ ] 深色模式下新按鈕配色正確
- [ ] 手機寬度（<641px）篩選列收起狀態下功能正常
- [ ] 無痕視窗（localStorage 空）→ 走預設值，不報錯
- [ ] 瀏覽器停用 localStorage → 不白畫面
- [ ] 階段 2：換裝置登入 → 具名 view 跟著走
- [ ] 階段 2：存了 view 之後去個人設定頁按「儲存」→ **回頭確認 view 和深色模式都還在**（這條直接驗 §2.3 的坑）

### 4.2 前端硬規則

- **第 31 條**：從 `app/public/styleguide.html` 挑 token／共用 class，禁目測填 px、禁寫死顏色
- **第 32 條**：寫死的淺色系顏色在深色模式會維持亮底，語意色走 `app.css` 共用 class
- **第 33 條**：`app.css` **從未定義 `.btn-secondary`**，用它等於裸按鈕
- **第 34 條**：Vue 3 Options API 放在 `computed` 的東西，呼叫端不能加括號（加了直接 TypeError 白畫面）
- **第 36 條**：引用 helper 前先讀 `api.js`／`dialog.js` 核實（`Api.del` 實際只有 `delete`；`confirmDialog` 只吃物件不吃字串）

動 `app/public` 前先載入 **platformDev** skill。

### 4.3 階段 2 的後端測試

```bash
cd app && npm run test:quiet 2>&1 | grep -vE '^PASS |^$'
```

supertest 覆蓋：局部更新後**其他 key（特別是 `theme`）必須原樣保留**——這是 §2.3 事故的迴歸測試，必須有。

route 層測試的授權走 `createApp` + auth/setup 取得 token，不要用私有 signer 造（規則 22）。

改 `app/server/**.js` 後必須重啟 server（規則 3）。

---

## 5. 風險與回滾

| 風險 | 對策 |
|---|---|
| 使用者困在上次的篩選、以為任務不見了 | §3 階段 1 的「重設篩選」按鈕；`activeFilterCount` 已顯示生效條件數 |
| localStorage 被停用 | 讀取包 try/catch，退回預設值 |
| 階段 2 覆寫掉 theme | 專用端點（§2.3）＋ §4.3 的迴歸測試 |
| 舊資料無 `saved_views` key | 讀取時 `?? []`，**不要用 `||`**（規則 46） |

**回滾**：階段 1 純前端，`git revert` 即可（localStorage 殘留無害，下次讀到就是舊 key）。階段 2 不含 DDL（只是 JSONB 內多一個 key），revert 後該 key 留在資料裡不影響任何讀取。

---

## 6. 明確不做

- **不做 view 分享／團隊共用** —— 那需要 `project_members` 之類的授權層，本 repo 沒有（規則 11）
- **不記住 `search`** —— 理由見 §2.4
- **不新增 DB 欄位** —— 沿用 `odoo_settings`（§2.5）
- **不動 `filtersOpen` 的手機／桌機行為** —— 那是既有的 RWD 決策
- **不改任何篩選邏輯本身** —— 只改「初始值從哪來、變更後寫去哪」
