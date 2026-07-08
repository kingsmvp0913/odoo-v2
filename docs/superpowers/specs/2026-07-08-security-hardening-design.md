# 主題 E：安全批次 — 設計文件

日期：2026-07-08
狀態：已核准
健檢對應：報告第六節 E 批次（password_enc 可逆加密、DB query 端點不驗歸屬、playwright prompt 明碼密碼）。

## 背景與目標

E 是健檢最後一批安全發現。使用者定調**信任模型需收緊——一般 user 不該全權**。三目標之外的安全軸，但方向明確。

**已完成、剔除**：U15（install.ps1 補產 APP_SECRET／ANTHROPIC_API_KEY）已於第一批止血完成（install.ps1:79/92-99、72-73）。

**核准決策**：
- E-2 採「每專案專用 E2E 測試帳號」，取代使用者真實密碼（系統不再持有任何使用者可還原密碼）。
- E-3 收緊 `/api/` DB 路由為 admin-only。
- E-3 的 `/ai/db/*`（getSQL skill 用、loopback 無 token）**本輪不加 token**：它是伺服器本機行程攻擊面、非「一般 user」問題（web 一般 user 碰不到 loopback），加 token 會影響 getSQL 操作且只換到縱深防禦邊際收益。

## 元件

### E-1：playwright 憑證改走環境變數（P3，不再進 prompt 明碼）

- `claude-runner.js` `runClaude` 新增 `env` 選項：spawn 時 `env: { ...process.env, ...opts.env }`。
- `playwright-agent.js`：**只有密碼（敏感值）走 env var `E2E_PASSWORD`**；login（帳號名、非機密）維持 `{{login}}`、`{{test_url}}` 照舊。`{{password}}` 從 prompt 移除。
- `playwright.md`：移除「登入密碼：{{password}}」，改指示「登入密碼從環境變數 `E2E_PASSWORD` 讀取，**勿寫死在測試腳本內**」；帳號仍以 `{{login}}` 提供。
- 效果：密碼不再出現在 terminal 串流回顯，也不會被寫進腳本被 `git add -A` 收進版控。

### E-2：每專案專用 E2E 測試帳號（取代使用者真實密碼）

- migration：`projects` 加 `e2e_test_login TEXT`、`e2e_test_password_enc TEXT`。
- `PATCH /api/projects/:id`（已是 requireAdmin）接受 `e2e_test_login`／`e2e_test_password`；password 以 `encryptSafe` 存 `e2e_test_password_enc`（write-only，不回傳明文）。
- 前端 `ProjectDetail.js` admin 設定區加兩欄：E2E 測試帳號（login）＋密碼（write-only，留白＝不改）。
- `playwright-agent.js`：改讀專案 `e2e_test_login`／解密 `e2e_test_password_enc`；未設定 → stopped「請先於專案設定填入 E2E 測試帳號」（清楚可行，取代目前 fallback 到 user 密碼）。
- **移除 auth.js 三處 password_enc 寫入**：setup（存 null）、登入補寫（刪整段）、改密（刪該 field）。
- migration：把既有 `users.password_enc` 全部設 null（系統即刻停止持有可還原的使用者密碼）；`password_enc` 欄位保留（不 drop，避免 schema 風險），僅永久留空。

### E-3：`/api/` DB 連線路由收緊為 admin-only（一般 user 不該全權）

- `db-query-routes.js`：POST／PUT／DELETE `/api/projects/:id/db-connections*` 與 `/api/projects/:id/db-connections/:cid/query` 加 `requireAdmin`（管理憑證、對正式 PG 送 SELECT 均限管理員）。
- GET `/api/projects/:id/db-connections`（僅 `PUBLIC_COLS`、無密文）維持 `verifyToken`（一般 user 可看清單 metadata）。
- `requireAdmin` 沿用 project-routes 既有 middleware（確認其 export／可共用；否則於 auth.js 提供）。
- 前端 `ProjectDbQuery.js`：對非 admin 隱藏/停用查詢與管理入口（後端已擋，前端一致避免誤導）。
- `/ai/db/*`：維持現狀（見決策）。

## 測試計畫（Rule 9 驗證意圖）

E-1：
1. runClaude 帶 `env` → spawn 收到合併後的環境變數（含 E2E_PASSWORD）。
2. playwright-agent 送給 runClaude 的 prompt 不含密碼明文（但含 login／test_url）。

E-2：
3. PATCH project（admin）設 e2e_test_login/password → 存 e2e_test_password_enc（密文，非明文），回傳不含明文。
4. playwright-agent 有專案 E2E 帳號 → 用它（env 帶專案帳密）；無 → stopped 且訊息含「E2E 測試帳號」。
5. auth 登入不再補寫 password_enc（登入後該欄仍為 null）。
6. migration 後既有 users.password_enc 皆為 null。

E-3：
7. 非 admin 對 POST/PUT/DELETE/query db-connection → 403。
8. admin → 正常；GET 清單一般 user 仍 200（僅 metadata）。

回歸：既有 db-query、auth、playwright、project 測試在調整後通過。

## 範圍與非目標

- 不加 `/ai/db/*` token（決策）；loopback 邊界維持。
- 不 drop `password_enc` 欄位（只清 null），降 schema 風險。
- 不做 KMS／外部金鑰管理（YAGNI；已藉專案測試帳號大幅縮小攻擊面）。
- E2E 以專案共用測試帳號執行（不再逐使用者身分），符合 E2E 驗證新行為的需求。
