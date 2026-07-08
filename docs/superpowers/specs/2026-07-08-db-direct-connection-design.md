# 直連 DB 連線模式（DBeaver 直連 TCP）＋連線測試 — 設計文件

日期：2026-07-08
狀態：待 review

## 1. 目標與背景

目前專案級 DB 連線（`db_connections`，UI 在 `ProjectDbQuery.js`）只有兩種 `connect_mode`，且**都需要 SSH 進主機**再跑 psql：

- `docker`：SSH → `docker exec -i <container> psql -U <db_user> -d <db_name> --csv`（需 sudo）
- `local`：SSH → `sudo -u <sudo_user> psql -d <db_name> --csv`

但有些資料庫可以用 **DBeaver 直接 TCP 連線**（host:port + DB 帳密），不需要 SSH、也不在 docker 裡。目前無法登錄這類連線。

目標：**比照現有專案 DB 連線管理方式**，新增第三種 `connect_mode = 'direct'`（直連 TCP），掛在同一套 per-project 連線管理表單／CRUD／查詢面板；並為所有模式加上「連線測試」按鈕。skill（`/getSQL`）與 `/ai/db/*` 路徑不需改動，direct 自動生效。

### 使用者故事
- 進專案 →「資料庫查詢」分頁 → 新增連線時選「直連」模式 → 填 DB 主機/埠/帳/密/庫（可勾 SSL）→ 按「測試連線」確認連得上 → 儲存 → 選連線跑 SELECT。

## 2. 連線本質

新增第三種模式，與現有兩種並存：

| `connect_mode` | 做法 | 傳輸 |
|---|---|---|
| `docker`（現行） | SSH → `docker exec` psql | SSH |
| `local`（現行） | SSH → `sudo -u` psql | SSH |
| `direct`（新增） | `pg.Client` 直接 TCP 連 PostgreSQL | 直連（可選 SSL） |

direct 模式**不 shell-out**、不經 SSH，用專案內建的 `pg` 函式庫直接連線查詢。唯讀防護（`validateSelectOnly` 白名單）與回傳格式三種模式共用，語意不變。

## 3. 資料模型（`db.js` migrate 加欄位）

用既有 `colMigrations` 冪等機制，對 `db_connections` 新增 4 欄：

| 欄位 | 型別 | 用途 |
|---|---|---|
| `db_host` | TEXT | 直連目標主機 |
| `db_port` | INTEGER DEFAULT 5432 | 直連埠 |
| `db_password_enc` | TEXT | DB 密碼（AES-256-GCM 密文，比照 `ssh_password_enc`） |
| `db_ssl` | BOOLEAN DEFAULT false | SSL 開關 |

- `db_user` / `db_name` 沿用既有欄位（語意剛好對）。
- `connect_mode` 值域擴為 `'docker' | 'local' | 'direct'`（欄位本身無 CHECK 約束，免改）。
- **`ssh_host` / `ssh_user` 維持 `NOT NULL` 不動**；direct 模式後端塞空字串 `''` 滿足約束（不改既有約束，最小變更）。

## 4. 查詢分叉（`lib/ssh-sql.js`）

`runSelect(conn, sql)` 開頭依模式分叉：

- `conn.connect_mode === 'direct'` → 新函式 `runDirect(conn, sql)`：
  - 先跑 `validateSelectOnly(sql)`，非 SELECT/含分號一律擋（與 SSH 路徑共用同一函式）。
  - 建 `pg.Client({ host: db_host, port: db_port || 5432, user: db_user, password: db_password, database: db_name, ssl: db_ssl ? { rejectUnauthorized: false } : false, statement_timeout: 120000, connectionTimeoutMillis: 15000 })`。
  - `connect()` → `query(sql)` → `end()`（單次連線，查完即關；不做連線池）。
  - 從 `res.fields` 取欄名、`res.rows` 取資料，組成 `{ ok:true, columns, rows, row_count }`（**與 SSH 路徑相同格式**）。rows 統一轉為字串陣列，對齊現有 CSV 路徑的輸出型別。
  - 連線/查詢失敗 → `{ ok:false, error: '[DIRECT] ' + e.message }`。
- 其他模式 → 現行 `sshExec` + `buildPsqlCmd` 路徑，**完全不動**。

direct 路徑不需要 `buildPsqlCmd` 的 identifier 檢查（不 shell-out）、不需要 base64/CSV（pg 直接回物件）。

## 5. API（`db-query-routes.js`）

### 5.1 建立/更新驗證分叉
POST/PUT 的必填依 `connect_mode` 分叉：

- `direct` → 必填 `name` / `db_host` / `db_user` / `db_password`（新增時必填；編輯留空＝不變）/ `db_name`；**不驗** `ssh_host`/`ssh_user`，後端塞 `''`。
- `docker` / `local` → 維持現行必填（`name`/`ssh_host`/`ssh_user`/`db_name`）。

其他細節：
- `db_password` 以 `encrypt()` 存 `db_password_enc`（比照 ssh_password）。
- INSERT/UPDATE 欄位清單加入 `db_host` / `db_port` / `db_ssl` / `db_password_enc`。
- `PUBLIC_COLS` 加上 `db_host, db_port, db_ssl`（**密碼欄不外露**）。
- `loadDecryptedConn` 多解一個 `conn.db_password = db_password_enc ? decrypt(...) : ''`。

### 5.2 連線測試端點（新增）
`POST /api/projects/:id/db-connections/test`（`verifyToken` + `requireAdmin`）：

- Body：**完整表單值**（`connect_mode`、`ssh_*`、`db_*` …）＋選填 `id`（正在編輯的連線）。
- 組出 `conn` 物件；若密碼欄留空且帶 `id` → 載入該連線已存的 `ssh_password_enc` / `db_password_enc` 解密回填（比照「留空＝不變」）。
- **直接呼叫 `runSelect(conn, 'SELECT 1')`**，回傳 `{ ok, error }`。成功即代表連得上。
- 測試與正式查詢走**同一條 `runSelect` 路徑**，杜絕「測試過但查詢失敗」落差。

## 6. 前端（`ProjectDbQuery.js`）

- `form` 加入 `db_host` / `db_port`(預設 5432) / `db_password` / `db_ssl` / `id` 對應欄位；`resetForm` 同步。
- 連線模式下拉加 `<option value="direct">直連</option>`。
- 依 `form.connect_mode === 'direct'` 用 `v-if` 切換顯示欄位（比照現行 docker/local 切法）：
  - direct 顯示：DB 主機 / DB 埠 / DB 使用者 / DB 密碼（留空＝不變）/ 資料庫名稱 / SSL 勾選；隱藏整組 SSH 欄位。
- `saveConn` 前端必填檢查依模式分叉。
- 按鈕列加「測試連線」：`testing` 狀態顯示轉圈，POST 表單值（含 `form.id`）到 `/test`，`showToast` 回報成功/失敗；三種模式都可按。
- 清單表格「SSH 主機」欄：direct 列改顯示 `db_user@db_host:db_port`（依 `connect_mode` 判斷）。

## 7. getSQL skill / `/ai/db` 路徑

**不改**。`/ai/db/query` 與 `/ai/db/connections` 一樣走 `runSelect()` / 同一張 `db_connections` 表，direct 模式自動生效。skill 端只透過 API，無感。

## 8. 測試（TDD）

- `ssh-sql.test.js`：
  - `runSelect` direct 模式呼叫 pg（mock `pg.Client`）、回傳格式 `{ok,columns,rows,row_count}` 與 SSH 路徑一致。
  - `db_ssl` 開/關帶對 `ssl` 參數。
  - direct 模式下非 SELECT（含分號、DELETE 等）一樣被 `validateSelectOnly` 擋。
  - 連線失敗回 `{ok:false, error}`。
- `db-query-routes.test.js`：
  - direct 模式建立必填驗證（缺 `db_host`/`db_user`/`db_password`/`db_name`）。
  - `db_password` 加密存取；`PUBLIC_COLS` 不外露密碼。
  - `/test` 端點：direct 成功/失敗回報；編輯時密碼留空會回填已存密碼；非 admin 被擋（403）。

## 9. 刻意不做（YAGNI）

- 不做連線池共用（每次查詢單次連線、查完即關）。
- 不做 SSL 憑證驗證（`rejectUnauthorized:false`，比照 DBeaver 常見的「不驗憑證」模式）。
  - **資安取捨**：`rejectUnauthorized:false` 只加密傳輸、不驗伺服器身分，理論上仍可被 MITM。此連線管理限 admin、且目標是使用者本來就用 DBeaver 明文/自簽連的內部庫，故接受此取捨。若日後要收自簽憑證的雲端庫，再擴充「提供 CA 憑證」選項升級為 `rejectUnauthorized:true`。
- 不改 `ssh_host`/`ssh_user` 的 NOT NULL 約束（direct 塞空字串）。
- 不改 skill 檔與 `/ai/db` 路徑。
