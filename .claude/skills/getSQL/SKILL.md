---
name: getSQL
description: Use when querying remote PostgreSQL databases via SSH-SQLM API at localhost:5000, running SELECT statements, listing available connections, or inspecting table structures.
---

# SSH-SQLM 遠端資料庫查詢 Skill

你可以透過 SSH-SQLM 的 API 查詢遠端 PostgreSQL 資料庫。
SSH-SQLM 服務運行在 `http://localhost:5000`。

## 限制

- **只允許 SELECT 查詢**，任何 INSERT / UPDATE / DELETE / DROP / ALTER 等修改操作都會被拒絕
- 支援 `WITH`（CTE）語法
- 不允許多語句（SQL 中不可包含分號，結尾分號除外）
- 查詢逾時 120 秒

## 使用流程

### 第一步：列出可用連線

```bash
curl http://localhost:5000/ai/connections
```

回傳範例：

```json
{
  "ok": true,
  "connections": ["gcp-openclaw", "hj-鴻伍-正式", "立勝補習班-正式"]
}
```

從清單中選擇要查詢的連線名稱。

### 第二步：執行 SELECT 查詢

用選定的連線名稱帶入 `connection`，寫好 SQL 即可查詢，不需要指定資料庫等參數（已在連線設定中預設好）。

```bash
curl -X POST http://localhost:5000/ai/select \
  -H "Content-Type: application/json" \
  -d '{"connection":"立勝補習班-正式","sql":"SELECT id, login, active FROM res_users LIMIT 5"}'
```

#### 請求參數

| 參數 | 必填 | 說明 |
|------|------|------|
| connection | 是 | 連線名稱（從第一步取得） |
| sql | 是 | SELECT 語句 |
| db_name | 否 | 資料庫名稱，不填則用連線的預設值 |

#### 成功回傳

```json
{
  "ok": true,
  "columns": ["id", "login", "active"],
  "rows": [
    ["2", "admin", "t"],
    ["6", "user1", "t"]
  ],
  "row_count": 2
}
```

#### 錯誤回傳

```json
{
  "ok": false,
  "error": "只允許 SELECT 查詢，不允許 DELETE"
}
```

## 常用查詢範例

### 查看資料表結構

```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'res_partner' ORDER BY ordinal_position
```

### 查看所有資料表

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
```

### 查詢記錄數

```sql
SELECT COUNT(*) FROM res_partner
```

### 使用 CTE

```sql
WITH active_users AS (SELECT id, login FROM res_users WHERE active = true) SELECT * FROM active_users LIMIT 10
```

## 注意事項

1. 先用 `/ai/connections` 確認可用連線，不要猜測連線名稱
2. 查詢前可先用 `information_schema` 確認欄位名稱，避免 SQL 錯誤
3. 大表查詢請加 `LIMIT`，避免回傳過多資料
4. 如果查詢失敗，檢查 `error` 欄位的錯誤訊息
