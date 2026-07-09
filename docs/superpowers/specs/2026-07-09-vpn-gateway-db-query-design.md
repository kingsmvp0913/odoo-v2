# 多 VPN 資料庫連線（VPN Gateway）— 設計文件

日期：2026-07-09
狀態：待 review

## 1. 目標與背景

`db-query` 功能（見 [`2026-07-03-project-db-query-design.md`](./2026-07-03-project-db-query-design.md)）讓 v2 透過 SSH 連到客戶主機執行 `psql`。但部分客戶（如鴻久）的 SSH host 只能透過 VPN 才能路由到，且：

- 客戶提供的 VPN 種類不固定（目前鴻久是包裝過的 OpenVPN，帳密登入）。
- 未來需要 VPN 才能連的客戶會持續增加（目前已知 4 個以上）。
- v2 未來會部署在**共用主機**（多人同時用），可能會有人同時查詢「不同 VPN」的專案，必須能併發在線，不能一次只接一條 VPN。
- v2 主程式本身可能換機器、未來也可能拆成多台主機——VPN 的連線能力不應該綁死在「v2 現在跑在哪」。
- 成本敏感：不希望每個客戶都得開一台專屬機器/VM。

目標：在既有 db-query 架構上加一層「VPN Gateway」，讓有 VPN 需求的連線可以透過**輕量、可併發、免代管**的方式連通，且使用者端設定越少越好。

## 2. 關鍵事實與決策

### 2.1 客戶端 VPN 的真實樣貌
檢視鴻久提供的 VPN 用戶端（桌面 `鴻久VPN/` 資料夾）發現：它是包了 GUI 外殼的**標準 OpenVPN**（內含 `openvpn.exe`、標準 `.ovpn` 設定檔、`auth-user-pass` 帳密登入、`redirect-gateway def1` 全隧道）。沒有憑證、沒有 MFA、沒有廠牌專屬協定。這代表：
- 可以在 Linux 上用標準 `openvpn` CLI **無頭（headless）** 撥號，行為等同雙擊 GUI。
- 目前**沒有實際案例**需要 Windows-only 廠牌 GUI client（如 FortiClient 硬體金鑰）。若未來真的遇到，屬於另一個設計問題，本次不處理（YAGNI，見第 10 節）。
- `redirect-gateway def1`（全隧道）代表多個此類 VPN **不能共存在同一個網路堆疊**（會搶預設路由），確認需要「每個連線各自獨立網路環境」。

### 2.2 架構決策：VPN Gateway 抽象層（Docker 容器 + SOCKS 代理）
- 每個需要 VPN 的 `db_connection`，對應一個**輕量 Docker 容器**：容器內跑 `openvpn` 撥號 + 綁在 VPN 網卡上的 SOCKS5 代理（如 microsocks）。
- v2 的 SSH 連線邏輯（`lib/ssh-sql.js`）連線前，若該連線設定了 SOCKS port，就先建立 SOCKS 底層 socket 再交給 ssh2（ssh2 支援自帶 `sock` 參數），沒有就跟現在一樣直連。
- v2 主程式完全不需要知道「VPN 是什麼」，只認得「這條連線要不要先走某個 SOCKS 位址」——v2 換機器、加新主機都不影響這層。
- 容器是**共用同一台 Linux 主機**上的多個輕量 process，不是各自獨立的 VM，符合成本考量；且因為是各自獨立的 network namespace，天然解決「多個全隧道 VPN 同時在線互不衝突」與「併發查詢」兩個需求。

### 2.3 排除方案
- **單機多 VPN（`ip netns`/policy routing，不用容器）**：仍然綁死在單一 Linux 主機、無法處理未來可能出現的 Windows-only client，排除。
- **每客戶一台專屬 VM**：成本隨客戶數線性增加，使用者已明確表示不接受，排除。
- **SSH ProxyJump 取代 SOCKS**：耦合在 SSH 協定上，若未來查詢以外的用途需要走同一條 VPN（不確定但可能），SOCKS 更通用。維持用 SOCKS。

## 3. 使用者體驗（最小設定原則）

在既有「新增資料庫連線」表單上，只新增：
- 「VPN 設定檔」上傳欄位（`.ovpn`，選填）
- 「VPN 帳號」／「VPN 密碼」（選填，密碼加密存放）

使用者上傳後，畫面上不出現「容器」「port」「SOCKS」這些字眼——存檔即完成設定，之後查詢自動生效。沒有獨立的「VPN Gateway 管理頁面」。

## 4. 資料模型

延伸 `db_connections` 表（`2026-07-03` 設計文件定義），新增欄位：

```
vpn_enabled       BOOLEAN NOT NULL DEFAULT false
vpn_config_enc    TEXT      -- 加密後的 .ovpn 檔案內容（AES-256-GCM，同 lib/crypto.js）
vpn_username      TEXT
vpn_password_enc  TEXT      -- 加密（同上）
vpn_socks_port    INTEGER   -- 系統自動分配，供之後重啟/重用容器辨識
vpn_container_name TEXT     -- 例如 vpn-conn-<id>，docker 操作用固定名稱
```

回傳前端一律不含 `vpn_config_enc`/`vpn_password_enc`。

## 5. 元件

### 5.1 通用 Docker image
Repo 內建一份 `app/server/lib/vpn-gateway/Dockerfile`：基底裝 `openvpn` + `microsocks`，entrypoint 讀環境變數/掛載的設定檔撥號，撥通後啟動 SOCKS 代理。所有客戶共用同一份 image，不用每個客戶各寫一份 Dockerfile。

### 5.2 `app/server/lib/vpn-gateway.js`（新模組）
- `allocateSocksPort(usedPorts)`：從固定範圍（如 11000-11999）挑一個未被目前有效連線占用的 port。純函式，易測。
- `ensureGatewayRunning(conn)`：查詢前呼叫的**唯一對外入口**。內部邏輯：容器已存在且 running → 直接回傳；容器不存在 → 呼叫內部 `startGateway(conn)` 用 `docker run -d --name <container_name> --cap-add=NET_ADMIN -p 127.0.0.1:<port>:1080 -v <暫存 ovpn 檔>:/config/client.ovpn:ro -e VPN_USER -e VPN_PASS <image>` 起容器，再輪詢等待 SOCKS port 就緒（逾時 20-30 秒回錯）。`startGateway` 不對外匯出，只被 `ensureGatewayRunning` 呼叫。
- `stopGateway(conn)` / `removeGateway(conn)`：刪除連線時清容器，仿現有 `env-agent.js` 的 `cleanupProjectEnv()` 模式，避免孤兒容器占用 port。

### 5.3 `lib/ssh-sql.js` 的改動
`sshExec` 新增：若 `conn.vpn_socks_port` 有值，先用 `socks` npm 套件的 `SocksClient.createConnection` 建立底層 socket，作為 ssh2 `Client.connect({ sock, ... })` 的 `sock` 參數；否則行為不變。`buildPsqlCmd`/`parseCsv`/`runSelect` 的簽名與邏輯不變，兩種連線方式（有無 VPN）共用同一條程式路徑。

## 6. 資料流

查詢一筆有 VPN 的連線：
1. 使用者在「資料庫查詢」頁選連線、輸入 SQL、執行。
2. `POST .../db-connections/:cid/query` 讀出連線設定，解密 SSH 密碼與（若有）VPN 密碼。
3. 若 `vpn_enabled`：呼叫 `ensureGatewayRunning(conn)`，確保容器活著、SOCKS port 就緒。
4. `runSelect(conn, sql)` 透過該 SOCKS port 執行既有 SSH exec + `buildPsqlCmd` + CSV 解析流程，不因是否走 VPN 而改變。
5. 結果照舊回傳前端。

## 7. 錯誤處理

- **VPN 撥號失敗/逾時**：`ensureGatewayRunning` 逾時（20-30 秒）後回傳明確中文錯誤，附帶容器最後幾行 log（過濾密碼），不無限等待。
- **VPN 中途斷線**：查詢前的健康檢查偵測到 SOCKS 連不出去，嘗試重啟容器一次，仍失敗才回錯給使用者。
- **併發查詢同一條連線**：多個使用者查同一個連線＝共用同一個容器/port，SSH exec 各自獨立，不衝突。
- **刪除連線**：務必連容器一起清掉，避免孤兒容器長期占用 port/資源。

## 8. 安全性

- VPN 帳密與 `.ovpn` 內容比照 SSH 密碼，走 `lib/crypto.js` 的 AES-256-GCM 對稱加密，`APP_SECRET` 衍生金鑰。
- SOCKS 代理只綁 `127.0.0.1:<port>`，不對外開放，只有 v2 主程式能連。
- Docker 容器需要 `NET_ADMIN` capability（openvpn 建立 tun 裝置必要），但不需要 `--privileged`，也不掛載主機其他目錄。

## 9. 測試策略

- `allocateSocksPort`：純函式，mock 已佔用 port 清單，驗證挑到未使用的最小值。
- `startGateway`/`stopGateway`：mock `execFileSync`，驗證 docker 指令組裝正確性，比照 `scripts/lib/postgres.js`／`lib/ssh-sql.js` 現有測試風格，不需要真的跑 Docker。
- `sshExec` 的 SOCKS 分支：mock `socks` 套件的 `SocksClient.createConnection`，驗證有/無 `vpn_socks_port` 時行為正確、回傳的 socket 有正確傳給 ssh2 的 `sock` 參數。
- 真實 Docker + 真實 VPN（用鴻久那份 `.ovpn`）整合驗證：手動執行，不進 CI，驗證後不留臨時腳本（比照 `2026-07-03` 設計文件 Task 5 Step 5 的做法）。

## 10. 安裝/部署整合

Docker 是這個功能的系統相依，應併入「一鍵安裝」專案（`docs/superpowers/plans/2026-07-09-one-click-install.md`）既有的 `scripts/lib/*.js` idempotent 模組模式：
- `install.ps1`/`install.sh` 新增 Docker 安裝（比照 Node/Git/Python/Chrome/uv/PostgreSQL 那批）。
- 新增 `scripts/lib/docker.js`：確認 docker daemon 可用、確保 VPN gateway image 已 build/pull。
- 這個依賴是**軟性**的：只有使用者建立「需要 VPN」的連線時才用到，不應擋住完全不需要 VPN 的使用者的安裝流程。

**現況**：一鍵安裝專案目前由另一個 session 正在實作中（非本次設計範圍），本次**不直接修改**該 plan 檔案，避免與進行中的工作衝突。待對方完成後，另外補一個小 task 把上述 Docker 安裝步驟接上去。

## 11. 非目標（YAGNI）

- 不支援 Windows-only 廠牌 VPN GUI client（如需硬體金鑰/MFA 的專屬 client）——目前無實際案例，之後真的遇到再設計。
- 不做進階網路層方案（policy routing、`ip netns` 手動管理）——Docker 容器已經滿足隔離與併發需求。
- 不做 Gateway 跨主機排程或負載平衡——目前規模（4+ 客戶、單一共用主機）不需要。
- 不做 VPN 連線狀態的即時監控 UI——查詢當下才確保連線就緒即可，不用常駐儀表板。
