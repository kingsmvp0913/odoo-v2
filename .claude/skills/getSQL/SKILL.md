---
name: getSQL
description: Use when querying remote PostgreSQL databases via v2 platform AI endpoint at localhost:3939, running SELECT statements, listing project connections, or inspecting table structures.
---

# 資料庫查詢 Skill（v2）

透過 v2 工作平台查遠端資料庫（唯讀 SELECT）。支援 PostgreSQL / MSSQL / MySQL——連線清單會回 `db_engine`，**務必依它寫對應方言**。v2 需運行於 `http://localhost:3939`，不需另外啟動桌面服務。

## 流程

### 第一步：判斷當前專案

依當前處理中的專案、開啟檔案路徑（如 `online_addons/<專案>/`）、對話主題，推斷對應的 v2 專案名稱（folder_name 或 name）。

### 第二步：列出該專案連線

```bash
curl "http://localhost:3939/ai/db/connections?project=<專案名>"
```

回傳範例：

```json
{
  "ok": true,
  "connections": [
    { "id": 1, "name": "hj-鴻久-正式", "db_engine": "postgres", "project": "鴻久" }
  ]
}
```

- **回傳 1 筆**：直接使用其 `id`；記下 `db_engine` 決定方言。
- **回傳多筆**：列給使用者選擇。
- **回傳 0 筆**：提示使用者到該專案「資料庫查詢」分頁新增連線（`http://localhost:3939/projects/<id>/db`）。

### 第三步：執行 SELECT 查詢

```bash
curl -X POST http://localhost:3939/ai/db/query \
  -H "Content-Type: application/json" \
  -d '{"connection_id": 1, "sql": "SELECT id, login FROM res_users LIMIT 5"}'
```

成功回傳：

```json
{
  "ok": true,
  "columns": ["id", "login"],
  "rows": [["2", "admin"], ["6", "user1"]],
  "row_count": 2
}
```

錯誤回傳：

```json
{
  "ok": false,
  "error": "只允許 SELECT 查詢，不允許 DELETE"
}
```

## 限制

- 只允許 SELECT / WITH，禁多語句（不可含分號，結尾分號除外）。
- 大表查詢加 `LIMIT`；先用 `information_schema` 確認欄位。

## 依 db_engine 寫方言

| | postgres | mssql | mysql |
|---|---|---|---|
| 限筆數 | `LIMIT n` | `SELECT TOP n ...` 或 `OFFSET n ROWS FETCH NEXT m ROWS ONLY` | `LIMIT n` |
| 識別字引號 | `"col"` | `[col]` | `` `col` `` |
| 字串接合 | `\|\|` | `+` | `CONCAT()` |
| 系統表 | `information_schema` / `pg_*` | `information_schema` / `sys.*` | `information_schema` |

不確定引擎時，先看第二步清單回的 `db_engine`；別把 pg 語法套到 mssql（`LIMIT` 在 mssql 會直接報錯）。

## 常用查詢範例

```sql
-- 查看資料表結構
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'res_partner'
ORDER BY ordinal_position

-- 查看所有資料表
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name

-- 查詢記錄數
SELECT COUNT(*) FROM res_partner

-- 使用 CTE
WITH active_users AS (SELECT id, login FROM res_users WHERE active = true)
SELECT * FROM active_users LIMIT 10
```
