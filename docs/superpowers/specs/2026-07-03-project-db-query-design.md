# 專案級資料庫查詢（getSQL 併入 v2）— 設計文件

日期：2026-07-03
狀態：待 review

## 1. 目標與背景

目前查遠端 Odoo PostgreSQL 靠桌面的獨立服務 **SSH-SQLM**（`localhost:5000`，Flask + paramiko），連線設定散在 `connections/*.json`，且每次要手動啟動。

目標：把查詢能力**併入 v2**，連線設定改成**專案級、UI 管理**（比照使用者管理），同時保留 **AI（Claude Code）透過 skill 查詢**的能力。只做**唯讀 SELECT 查詢**，不開放連線以外的任何寫入/檔案操作（原服務的 file_read/file_write/exec 不移植）。

### 使用者故事
- **人**：進專案 →「資料庫查詢」分頁 → 管理該專案的 DB 連線 → 選連線、輸入 SELECT、看結果表格。
- **AI**：使用者處理某專案時 `/getSQL` → skill 依當前 context 推斷專案 → 抓該專案連線（1 個直接用、多個才問）→ 執行 SELECT。

## 2. 連線本質（沿用原服務）

連線**不是** PG tunnel，而是 SSH 到主機後執行 psql：
- **docker mode**：`docker exec -i <container> psql -U <db_user> -d <db_name> --csv`（需 sudo）
- **local mode**：`sudo -u <sudo_user> psql -d <db_name> --csv`

SQL 以 base64 編碼經 stdin 傳入避免 shell 注入。輸出為 CSV，第一列為欄名。

## 3. 資料模型（新表 `db_connections`）

```
db_connections
  id                SERIAL PK
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  name              TEXT NOT NULL            -- 連線顯示名
  ssh_host          TEXT NOT NULL
  ssh_port          INTEGER NOT NULL DEFAULT 22
  ssh_user          TEXT NOT NULL
  auth_type         TEXT NOT NULL DEFAULT 'password'  -- 'password' | 'key'
  ssh_password_enc  TEXT                     -- AES-256-GCM 密文（auth=password）
  ssh_key_path      TEXT                     -- 金鑰路徑（auth=key）
  connect_mode      TEXT NOT NULL DEFAULT 'docker'    -- 'docker' | 'local'
  docker_container  TEXT                     -- docker mode
  db_user           TEXT                     -- docker mode
  sudo_user         TEXT                     -- local mode
  db_name           TEXT NOT NULL
  description       TEXT
  created_at        TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(project_id, name)
```

隨專案 cascade 刪除。回傳前端一律**不含** `ssh_password_enc`。

## 4. 後端

### 4.1 `lib/ssh-sql.js`（移植核心，純邏輯優先可測）
- `validateSelectOnly(sql)`：移植原 python 邏輯 — 去尾分號、禁分號多語句、首字須 `SELECT`/`WITH`、剝除字串常量與註解（`--`、`/* */`、單引號、dollar-quote）後擋 `INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE/COPY/EXECUTE/CALL/INTO`。回傳錯誤訊息或 null。
- `buildPsqlCmd(conn, sql)`：依 connect_mode + 有無 password 組出指令（base64 + docker exec / psql `--csv` + sudo），對齊原 `_build_psql_cmd`。
- `runSelect(conn, sql)`：`validateSelectOnly` → `buildPsqlCmd` → 用 **ssh2** 連線 exec → 過濾 `[sudo]` 提示 → 解析 CSV → `{ ok, columns, rows, row_count }`。
- `encrypt(text)` / `decrypt(text)`：AES-256-GCM，金鑰由 `APP_SECRET` 環境變數衍生（scrypt）。

### 4.2 `db-query-routes.js`（人用，需登入 `verifyToken`）
- `GET    /api/projects/:id/db-connections`         列出（不含密碼）
- `POST   /api/projects/:id/db-connections`         新增（password 進來即加密存）
- `PUT    /api/projects/:id/db-connections/:cid`    更新（password 空白＝保留舊值）
- `DELETE /api/projects/:id/db-connections/:cid`    刪除
- `POST   /api/projects/:id/db-connections/:cid/query`  跑 SELECT（body: `{ sql }`）

### 4.3 AI 專用 endpoint（本機免登入，只綁 127.0.0.1）
- `GET  /ai/db/connections?project=<name>`  依專案名/folder_name 回連線清單（id + name + project）；不帶 project 回全部（含所屬專案）
- `POST /ai/db/query`  body `{ connection_id, sql }` → 跑 SELECT

安全：`/ai/*` 以中介層檢查 `req.socket.remoteAddress` 為 loopback（127.0.0.1/::1），非本機一律 403，不需 token。

## 5. 前端

### 5.1 專案頁分頁式 topbar
`← 返回 | 專案名 | [設定] [資料庫查詢] [Wiki] [Chat]`
Wiki/Chat 由設定頁區塊移到 topbar 分頁（導向既有 `/projects/:id/wiki`、`/chat` 路由）。

### 5.2 新 view `ProjectDbQuery.js`（路由 `/projects/:id/db`）
- **上半：連線管理** — table（名稱/主機/模式/DB）+ 新增/編輯/刪除，照 `AdminUsers.js` 風格。表單欄位隨 auth_type、connect_mode 動態顯示。
- **下半：查詢** — 選連線 + SQL textarea + 執行按鈕 + 結果表格（columns/rows）+ 錯誤訊息。

### 5.3 設定頁重整
`ProjectDetail` 只留：Git repos、同步來源對應、Odoo 測試環境。Wiki/Chat 按鈕上移。

## 6. getSQL skill 更新
`.claude/skills/getSQL/SKILL.md` 改為：
1. 依當前 context（處理中的專案、開啟檔案路徑、對話主題）推斷對應 v2 專案名。
2. `GET http://localhost:3939/ai/db/connections?project=<name>`。
3. 回傳 1 筆 → 直接用；多筆 → 列出請使用者選；0 筆 → 提示到該專案設定連線。
4. `POST http://localhost:3939/ai/db/query` `{ connection_id, sql }` 執行 SELECT。

## 7. 安全
- 只允許 SELECT（後端 `validateSelectOnly`，人用與 AI 用共用）。
- SSH 密碼 AES-256-GCM 對稱加密存 DB，連線時解密；`APP_SECRET` 未設則 server 啟動報錯。
- 人用 route 需登入；AI route 只綁 loopback。

## 8. 測試策略
- **`validateSelectOnly`**：TDD，涵蓋 SELECT/WITH 通過、DML/DDL 擋下、字串內出現關鍵字不誤判、多語句擋下。
- **`buildPsqlCmd`**：docker/local × 有無 password 四分支輸出正確。
- **`encrypt/decrypt`**：round-trip 還原、密文不等於明文。
- **routes**：CRUD + query（mock `runSelect`）；`/ai/*` loopback 檢查。
- **`runSelect`（ssh2）**：用一筆真實連線（如 gcp-openclaw）做整合驗證，確認能查到資料。
- 前端 view：語法檢查 + 手動驗證。

## 9. 依賴與設定
- 新增 npm：`ssh2`
- 新增環境變數：`APP_SECRET`（加密金鑰來源）
- 資料遷移：`db.js` migrate 新增 `db_connections` 表；桌面 `connections/*.json` 由使用者透過新 UI 重新建立（或後續提供匯入，非本期範圍）。

## 10. 非目標（YAGNI）
- 不移植原服務的 file_read/file_write/exec_command（只做 SELECT 查詢）。
- 不做連線跨專案共用（連線一律專案級）。
- 不自動從 json 匯入（先手動在 UI 建立）。
- 不保留桌面 SSH-SQLM 服務為備援（完全由 v2 取代）。
```
