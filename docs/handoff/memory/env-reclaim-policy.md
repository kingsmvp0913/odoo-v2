---
name: env-reclaim-policy
description: 測試環境回收政策 2026-08-07 定案——主動回收關閉，改「池滿才徵收，否則等晚上 23:00 統一關」；含兩個已修的誤殺 bug 與資源實際比例
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d525950-725e-459c-b3e3-0862a6832ebc
---

使用者回報「測試環境一直中斷」，追出兩層原因並定案新政策（2026-08-07，commit `b740fda` + `d0beefd`，已 push）。

**⚠ 需重啟 `odoo-v2` 容器才生效**（migration 也在啟動時跑）。
✅ **2026-08-10 複查：已於 08-08 09:32 重啟生效**，`odoo_envs.started_at` 欄位確認存在。

## 政策

主動回收預設關閉，稀缺真的發生時才處理：

| 機制 | 新預設 | 原值 |
|---|---|---|
| `ENV_IDLE_TIMEOUT_MIN`（背景閒置回收） | **0＝停用** | 60 分 |
| `ENV_MAX_LIFETIME_HOURS`（壽命保底） | **20 小時** | 8 小時 |
| `EXTERNAL_IDLE_MIN`（對外名額背景回收） | **0＝停用** | 20 分 |
| `ENV_IDLE_TIMEOUT_PRESSURE_MIN`（池滿徵收） | 15 分（不變） | — |
| `ODOO_ENV_SHUTDOWN_TIME`（夜間全停） | 23:00（不變） | — |

理由：埠池 100 個、對外名額 10 個、專案只有 8 個——沒人在等資源，卻為了不存在的短缺去踢正在用的人。稀缺發生時 `port-reclaim`（埠池滿）與 `acquireExternalSlot`（名額滿）會當場徵收，收尾交給 `nightlyShutdown`。專案數長到超過池子，這兩條會自動生效，不必回頭改設定。

**這三個變數 `start.sh` 都沒 export、`config.json` 也沒設**，所以改碼內預設值即生效。（`start.sh` 只注入 `JWT_SECRET`／`APP_SECRET`／`PORT`／`DATABASE_URL`／`PROJECT_PORT_MIN`／`PROJECT_PORT_MAX`／`ANTHROPIC_API_KEY`。）

## 兩個已修的誤殺 bug

1. **壽命上限比錯欄位**（真凶，`d0beefd` 前的 `b740fda` 修）。`sweepIdleEnvs` 拿 `created_at` 判「開機多久」，但 `odoo_envs` 是 `UNIQUE(project_id)`、停機只改 status 不刪列、重啟走 `ON CONFLICT DO UPDATE`，`created_at` 永遠停在「該專案第一次建環境」（實測 1~14 天前）。於是建立逾 8 小時的專案一開機就滿足壽命條款，下一輪 sweep（每 10 分）立刻收掉。**只打真人**：pipeline 有 `deploy_testing`／`playwright_running` 擋著，真人點畫面不產生任務。修法：新增 `odoo_envs.started_at`，轉 `running` 時寫入，判定用 `COALESCE(started_at, created_at)`。
2. **徵收門檻不可與背景回收共用**。`findReclaimableSlot` 原本也讀 `idleMinutes()`；背景回收設 0 後，徵收條件退化成「閒置 > 0 分鐘」＝幾乎恆真，池滿時連正在操作的人都被踢。已抽出 `pressureIdleMinutes()`（讀 `ENV_IDLE_TIMEOUT_PRESSURE_MIN`）。實測共用會讓既有的「池滿且無閒置可徵收 → 拋錯」一併失效。

## 判讀陷阱

- **`odoo_envs.created_at` ≠ 本次開機時間**，是該列首次建立時間，永不重設。要看本次開機用 `started_at`。
- 診斷「是不是被誤收」看 `updated_at - last_active_at`（停機時刻減最後活動）。修復前實測：`created_at` 未滿 8 小時的兩個環境走到正確的 60 分門檻（61.3／63.9 分），其餘六個全在 3.6~7.1 分鐘內被殺——分界線精準落在 8 小時，這是定位根因的決定性證據。
- **測試的 fixture 曾把錯誤假設寫死**：`env-idle-sweep.test.js` 的 `mkEnv` 原本把 `created_at` 與啟動時間塞成同一個值，所以永遠測不出來。現已拆成 `createdMinAgo`／`startedMinAgo` 兩個參數，並分兩層測（明確傳門檻＝測機制、不傳＝測政策預設值）。

## 資源實際比例（2026-08-07 實測）

- 埠池 **21000–21099 共 100 個**（`data/config.json` 的 `PROJECT_PORT_MIN/MAX` 蓋掉碼內預設 21000–21019；`teams_settings` 兩欄為 NULL 不覆蓋）。見 [[deployment-topology]]
- 對外名額 **10 個**（`EXTERNAL_SLOT_COUNT` 未設，走預設）——三個資源裡唯一接近專案數的，8 個專案同時被真人看只剩 2 個餘裕
- 專案 **8 個**；機器 187 GB RAM、可用 147 GB，8 個 Odoo 容器不構成壓力
- 容器 `TZ=Asia/Taipei`（`/etc/timezone` 寫 `Etc/UTC` 但 TZ env 覆蓋），23:00 是台北時間
