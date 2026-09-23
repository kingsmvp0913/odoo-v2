---
name: sync-silent-skip-on-unmapped
description: 「同步壞了」的真因通常是專案的來源對應欄位空了——sync 綁不到專案是 continue 靜默跳過，零訊號；附查證步驟與兩個未修的缺陷
metadata: 
  node_type: memory
  type: project
  originSessionId: 46056b69-a0d7-4b7d-84a3-d928da532aea
---

2026-09-01 使用者回報「同步壞了沒辦法同步進來」。**程式沒壞**：`POST /api/sync/now` 正常回 `{"service":{"added":0,"found":1}}`，
真因是專案 #3（鴻久）的 `projects.service_respondent_name` 變成空的 → `findProjectBySourceName` 回 null → `syncServiceUser` **直接 `continue`** → 那張單永遠不入庫。
把欄位填回「鴻久用戶」後，下一次同步立刻抓進來（task 230）。

## 查證步驟（下次照這個順序，別先讀碼）

1. 打 `POST /api/sync/now`。**`found > 0 && added == 0` 就是綁不到專案，不是連線問題。**
2. 查 `SELECT id,name,odoo_project_name,service_respondent_name,service_contact_name FROM projects` —— 空的就是它。
3. 要直連 eService 驗證的話：`DATABASE_URL` **不在 `.env`，在 `data/config.json`**；而且密碼是加密的，
   `resolveUserOdooSettings` 解不開會拿到亂碼字串、Odoo 回 `AccessDenied`（看起來像帳密錯）。
   正解是把 `data/config.json` 的**每一個** key 都 export 成環境變數再跑。

## 兩個未修的缺陷（使用者已知，尚未拍板要不要修）

- **綁不到專案完全不吭聲**：`sync.js` 是裸 `continue`，沒有 log、沒有提示，回傳的 `found/added` 也分不出「已存在」還是「綁不到」。這是本次從 08/27 拖到 09/01 五天沒被發現的唯一原因。
- **對應表單會把空欄位當「請幫我清空」存進去**：`saveProjectMapping()` 一次送三個欄位、伺服器 `val || null`。表單還沒載完就按儲存、或載入失敗，一按就洗掉，無確認無警告。全庫只有這兩個表單會寫這欄位（ui-next 與 legacy `ProjectDetail.js`），**沒有任何操作紀錄表可回溯是誰清的**。

## 順帶記著

- eService 同步 domain 是 `state='open'` 白名單（刻意，見 `.claude/rules/pipeline.md` #84）。實測 `processing_staff=139` 共 121 張，只有 1 張是 open——**「只找到 1 張」是正常的，不是漏抓**。
- 14 個專案裡長期只有 2 個設了 `odoo_project_name`、1 個設了 `service_respondent_name`。**沒設對應的專案本來就收不到任務**，這不是壞掉。
