---
name: getLog
description: Use when reading Odoo application logs from a customer's production server to debug a reported error — requires the incident time, returns the surrounding window filtered by level and keyword.
---

# 客戶正式區 Log 讀取 Skill（v2）

透過 v2 工作平台讀客戶正式區 Odoo log（唯讀，不寫入、不即時串流）。v2 需運行於 `http://localhost:3939`。

## 前置：必須先問出事發時間點

這個工具**沒有**「給我最近的 log」這種用法——`at`（事發時間點）是必填參數，沒有就無法呼叫。查之前先向使用者問清楚事發的大概時間；時區可以不確定，但你組請求時必須自己標時區（見下方 `at` 說明）。

> **互動式 session 要先自己取通行碼**（pipeline 派出去的 agent 由平台自動注入，你自己敲的沒有）。
> 在 repo 根目錄執行一次即可：
>
> ```bash
> export AIDEV_AI_TOKEN=$(node -e "process.env.APP_SECRET=require('./data/config.json').APP_SECRET;console.log(require('./app/server/lib/ai-token').aiToken())")
> ```

## 流程

### 第一步：取得該專案連線 connection_id

依當前處理中的專案推斷 v2 專案名稱（folder_name 或 name），比照 getSQL：

```bash
curl -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" "http://localhost:3939/ai/db/connections?project=<專案名>"
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

- **回傳 1 筆**：直接使用其 `id`。
- **回傳多筆**：列給使用者選擇。
- **回傳 0 筆**：提示使用者到該專案「資料庫查詢」分頁新增連線。

### 第二步：查詢 log

```bash
curl -X POST http://localhost:3939/ai/db/log \
  -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"connection_id": 1, "at": "2026-08-10T14:30:00+08:00", "window": 10, "level": "ERROR", "keyword": ""}'
```

成功回傳：

```json
{
  "ok": true,
  "log_mode": "docker",
  "range": { "from": "2026-08-10T06:20:00Z", "to": "2026-08-10T06:40:00Z" },
  "entries": [
    { "ts": "2026-08-10 06:23:45,123", "level": "ERROR", "logger": "odoo.sql_db", "text": "..." }
  ],
  "total_matched": 3,
  "returned": 3,
  "truncated": false
}
```

失敗回傳 `{ "ok": false, "error": "..." }`——見下方「錯誤前綴對照」。

## 參數表

| 參數 | 必填 | 說明 |
|---|---|---|
| `connection_id` | 是 | 第一步取得 |
| `at` | 是 | ISO 8601 時間，**必須帶時區偏移**（`+08:00` 或 `Z`）。沒帶偏移會被拒絕——這是刻意的：沒有偏移會被當成伺服器本機時間解讀，在 UTC 正式機上會靜默差 8 小時 |
| `window` | 否，預設 `10` | 只接受 `10`／`30`／`60`（分鐘），以 `at` 為中心前後各展開該分鐘數 |
| `level` | 否，預設 `ERROR` | `ERROR`／`WARNING`／`INFO`／`ALL`，**門檻語意**：`ERROR` 含 `CRITICAL` 以上、`WARNING` 含 `ERROR` 以上、`INFO` 含 `WARNING` 以上，依此類推 |
| `keyword` | 否，預設空 | 字面比對（非 regex），大小寫不敏感，比對整筆記錄（含 traceback 續行） |

### 硬限制：`level=INFO` 或 `ALL` 時 `window` 只能是 `10`

`INFO` 含每個 HTTP request，資料量遠大於 `ERROR`。若 `level` 為 `INFO` 或 `ALL` 卻帶 `window=30` 或 `60`，請求會直接被拒絕（不會靜默降級成 10）。原因：±60 分鐘的 INFO 量必然觸發截斷——付了撈大範圍的成本，卻只拿到被砍過的前段，不如一開始就用 `window=10`。

## `truncated: true` 的處理

代表資料被截斷（單次回應上限 200 筆記錄或 64KB，先到者停），`note` 欄位會附上「符合 N 筆，回傳 M 筆」。**不可據此推論「時段內就只有這些記錄」**。遇到截斷，正確做法是縮小 `window` 或加 `keyword` 重新查，不要直接拿已回傳的部分當結論。

## 範圍放大策略

客戶講的事發時間常常不準。**先用 `window=10` 撈**，查無異常再放大到 `30`、`60`——不要一開始就用 `60`（範圍越大越容易觸發截斷，也更貴）。

## 錯誤前綴對照

| 前綴 | 意義 | 該怎麼做 |
|---|---|---|
| `[LOG] ... 尚未偵測 log 來源` | 該連線還沒設定 log 讀取來源 | 請使用者到連線設定頁執行「偵測」，不要改用其他方式硬撈 |
| `[LOG] ... 可能已被輪替` | 請求時段早於目前 log 檔的第一筆記錄 | 該時段查不到，**不是**沒有異常——如實告知使用者查詢受限，不要回報「該時段無異常」 |
| `[SSH]` | SSH 連線層失敗 | 檢查該連線的主機／帳密設定，或目標機器本身是否可連 |
| `[VPN]` | VPN 通道未就緒或未設定 | 檢查該專案的 VPN 設定（`.ovpn`、轉發埠） |
| `[LOG]` + 遠端原始 stderr | 遠端指令本身執行失敗（container 不存在、權限不足、journalctl/log 檔解析失敗等） | 實務上多數失敗落在這一類；依 stderr 內容判斷（常見：容器名或 log 檔路徑打錯、該帳號無讀取權限），必要時回連線設定重新偵測 |

## 限制

- 只讀，不支援寫入。
- 不支援即時串流，每次查詢是針對指定時間窗的一次性抓取。
- 不讀已輪替的 `.1`／`.gz` 檔案。
- 回傳內容已自動遮蔽疑似憑證字串（如 password、token 等欄位與 32 字元以上的長字串），非本工具刻意隱藏業務資料。
