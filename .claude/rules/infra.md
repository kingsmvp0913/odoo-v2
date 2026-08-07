---
paths:
  - "scripts/**"
  - "app/server/lib/**"
  - "app/server/env-agent.js"
---

# 平台開發：基礎設施與腳本

> 抽自 2026-07-29 的記憶整併。完整清單與來源見 `docs/rules-extraction-2026-07-29.md`。

### 安裝／環境
113. **`scripts/` 目錄下的程式不得 `require` npm 套件，DB 操作改用系統 `psql` CLI** — Node 模組解析不跨目錄樹，`scripts/lib/` 往上找不到 `app/node_modules`。
114. **平台的 runtime 相依要補在 `scripts/setup.js`，不是 `install.ps1/.sh`** — native bootstrap 只裝系統套件就交棒 setup.js，補在那裡才同時覆蓋 Windows 與 Linux。
115. **用宿主 Python 跑腳本時 interpreter 一律取 `PYTHON_BIN || (win ? python : python3)`** — Linux 上 pip 裝進 `python3`，呼叫 `python` 會 ENOENT。
115b. **〔2026-08-08 已移除自動索引〕graphify 索引的 pip 相依是 `graphifyy`（import 名是 `graphify`，兩者不同）＋`networkx`** — PEP 668 管制的環境要退 `--user --break-system-packages`，否則全新 Ubuntu 一鍵安裝會讓 repo 一建立就 `graphify_status='error'` 靜默失敗。**現況**：`setup.js` 不再安裝這兩個套件，腳本退居 `scripts/graphify_index.py` 手動工具；此條保留是因為手動跑仍會踩同一個 PEP 668 坑。
116. **pip 安裝要準備 PEP 668 退路**：先普通裝，失敗改 `--user --break-system-packages` 重試，仍 import 不到就 throw（fail loud）。
117. **任何含中文字面量的 `.ps1` 必須存成 UTF-8 with BOM** — PowerShell 5.1 讀無 BOM 檔用系統 ANSI codepage 解碼，與 `chcp` 無關。**此 repo 現有 .ps1 全都沒 BOM**。
118. **平台不自行起 PostgreSQL 容器，用本機 PG——但 5432 可能被既存第三方容器佔走，apt 安裝會自動退到 5434** — 先 `pg_lsclusters` 確認實際 port。改密碼要同時改 role 與 `data/config.json` 的 `DATABASE_URL` 再重啟。
119. **部署機的服務帳號要用 Docker 必須先 `sudo usermod -aG docker <user>` 並重登** — 僅給 sudo 不代表在 docker 群組。
120. **平台綁 `*:3939`；GCP VM 上連不到是 VPC 防火牆（timeout 而非 refused），不要改 app 的 bind 位址** — 解法是放行 3939 或 `ssh -N -L 3939:localhost:3939`。
121. **搬移平台 DB 時必須連 `data/config.json` 的 `APP_SECRET` 一起搬** — `lib/crypto.js` 金鑰只來自 `APP_SECRET`；換了之後所有 `*_enc` 欄位驗章失敗 throw，連線設定報廢只能重填。
122. **池範圍等管理員可調設定要在執行期讀取，不要在模組載入時 snapshot** — 否則改完要重啟才生效。注意 `data/config.json` 內殘留 env 會蓋過新預設值。
123. **配發對外埠必須落在 nginx publish 範圍與 NAT 轉發範圍的交集內** — 超出 NAT 範圍的埠靜默失效。NAT 是同號一對一。現行：測試區 21000–21012、VPN gateway 22000–22999。
124. **資源徵收／回收只做一輪，不要寫成迴圈直到滿足需求** — 迴圈會連環砍掉一整排。

### Docker / Odoo 測試環境
125. **Docker 化 Odoo 測試環境的固定事實**：odoo13/14 的 buster 已 EOL 要指 `archive.debian.org`；新版 base 改 Ubuntu 無 chromium apt 候選要改裝 Google Chrome；image 只有 `python3` 沒有 `python`。
126. **Odoo image 的 entrypoint 會用預設 db 參數蓋掉 `--db_host`** — `docker run` 要改走 `HOST/PORT/USER/PASSWORD` 環境變數（`exec` 才用 CLI 參數）。
127. **Odoo 容器的 `/var/lib/odoo` 必須綁 host 目錄，不能留匿名 volume** — 容器 rm+run 重建即遺失 filestore，但 DB 的 `ir.attachment` 還在 → 每個 asset 請求 500，UI 整個破版。
128. **健康檢查要探實際的 `envHost`，不能寫死 `127.0.0.1`**。
129. **全平台的 docker `ctx.mounts` 只在 `env-agent.js` 的 `dockerCtxFor` 組裝一次** — 掛載相關改動一律改這個單點。
130. **測試區只有 docker 一種建置模式，venv 模式已整個移除** — `teams_settings.env_mode` 與 `teams-routes.js` 相關碼是刻意留下的無害死碼。

### Claude CLI
131. **`spawn('claude')` 只有一處，認證憑證從 `process.env` 注入即可全 pipeline 生效** — headless `claude -p` 共用會過期／被刷新的互動式 OAuth 憑證檔，並發 spawn 在 token 輪替瞬間互相踩空。設 `CLAUDE_CODE_OAUTH_TOKEN` 可讓 claude 無狀態認證。
132. **`claude` CLI 的 `Not logged in` 走 stdout 而非 stderr** — 只掃 stderr 會漏掉，錯誤被吞成泛用 `exited with code 1`。認證失敗應歸類為 transient。
133. **`/api/oauth/usage` 是非官方逆向端點且限流很兇，60s TTL 快取是必需品不是最佳化** — 官方 Admin/Analytics API 給的是 API 花費而非訂閱視窗。抓取失敗必須 fail loud，否則會靜靜卡在 stale snapshot 上。
134. **Claude 用量是全平台單一帳號共用（`~/.claude/.credentials.json`），用量閘門必須是全域的**。
135. **Serena MCP 已用 `--context claude-code` 註冊，不要再調整，也不要從 `/plugins` 另裝** — 該 context 會 strip 掉與 Claude Code 內建重複的工具。Claude Code v2.0.74+ 已內建 LSP。
136. **範圍窄、有明確答案的驗證類 subagent 一律指定 `model: 'sonnet'`** — 數量多，用高階模型會撞 session limit 全數失敗；失敗的 agent 呼叫不會進 Workflow 的 resume 快取。

### VPN（若新主機要用）
137. **起 openvpn 容器必須同時給 `--cap-add=NET_ADMIN` 與 `--device /dev/net/tun`** — 只給 NET_ADMIN 會倒在 `Cannot open TUN/TAP dev`，錯誤訊息完全不指向成因。
138. **docker `-p` 的 userland proxy 在容器內無人 listen 時也會接受 TCP 連線（約 5ms）** — 「連得上轉發埠」不可當作就緒判斷。要用 `docker exec <name> nc -z <真目標>` 輪詢。
139. **openvpn 以 `--daemon` 執行時真正的 log 在容器內 `/tmp/openvpn.log`，不在 `docker logs`**。
140. **L7FW SSL VPN 的 `.ovpn` 內 `#SSLVPN_AUTH_USERNAME=`／`PASSWORD=` 是每 byte XOR 0x05 的混淆值** — 直接存會 AUTH_FAILED，錯誤看起來像帳號被停用。還原：`[...s].map(c=>String.fromCharCode(c.charCodeAt(0)^5)).join('')`。
141. **同一組 VPN 憑證不可同時多重撥號** — server 會踢線。一條隧道的路由本就涵蓋該網段所有目標。
142. **多目標 gateway 的就緒判斷用「任一目標可達」**。
143. **不要為了 split-tunnel 移除 `.ovpn` 的 `redirect-gateway`** — 實測會把路由整個弄壞。

### git 操作（程式化）
144. **`git fetch origin` 抓的是 `.git/config` 的 URL；改了 DB 裡的 repo URL 後必須先 `git remote set-url origin`** — 否則同步顯示成功但內容仍是舊 repo。
145. **辨識 binary／modify-delete 類衝突用 `git ls-files -u`，不要讀檔內容猜** — 這兩類衝突檔內沒有衝突標記。
146. **自動解衝突失敗的檔案要用 `git checkout -m` 還原成衝突標記，不留髒檔**。
147. **在 sync（main→ai-dev）場景，`ours`(stage 2) 是 AI 版、`theirs` 是工程師版，與普通 merge 直覺相反** — `ours` 恆為 merge 的目標分支。任何衝突裁決 UI／prompt 的分支標籤都必須依場景參數化，否則會系統性勸人選錯邊。
148. **帶 per-user PAT 跑 git 時，env 必須同時清掉 `credential.helper` 並設 `GIT_TERMINAL_PROMPT=0`** — 不清會讓機器層憑證搶先導致 commit 歸屬錯人。
149. **PAT 只放該次 git 子行程的 env，絕不寫進共用主 clone 的設定**。
150. **首次 clone 的認證走 best-effort（有 PAT 就帶、沒有退機器憑證），不要硬擋；更新既有 clone 才硬擋**。
151. **塞給 `GIT_ASKPASS` 的 `.sh` shim 必須在 git index 標 `100755`** — index 是 100644 就 Permission denied。此坑**只在 Linux 炸**，Windows 走 `.cmd` 不需執行位元。修法 `git update-index --chmod=+x`。
152. **多 repo 的批次 git 操作，任一 repo 失敗就整批不標記狀態**。
153. **「哪些項目已處理」的清單要在 git 操作之後才查詢並更新** — 開窗期間別人核准的任務也會被一併推上去。
154. **整條分支合併，不要 cherry-pick 挑任務** — 挑著合會讓 commit 血緣分層。

### 流程
155. **寫 plan 時，design 有而 plan 沒認領的條目必須明確標成 out-of-scope 或補一個 task** — 否則會無聲蒸發，逐 task 審查天然看不到。
156. **逐 task 審查看不到跨檔一致性問題，SDD 流程必須額外做一次整枝（whole-branch）審查** — diff 基底平移、旗標蒸發、資料格式的漏改消費端等 Critical 只在疊起來看時才浮現。
157. **改任何存進 DB 的資料格式前，先全庫搜出所有消費端，不能只依賴計畫的檔案清單** — 計畫的檔案清單本身就是盲點成因。
158. **改「餵給 agent 的分支語意」時必須盤過所有吃分支語意的 agent prompt 與 route** — diff 基底散落在 qa-agent／playwright-agent／reject-triage／下載 zip route／審核頁 diff route 等多處。
159. **pipeline「慢」的主因是每關本身就是數分鐘的大 agent 任務，不要往冷啟動鑽** — 單關 2~9 分鐘來自工具迴圈與 1.5~1.8 萬 output tokens。省 token 的主戰場是失敗迴圈而非 prompt 長度。
160. **別為了省 token 去追求共用／常駐 session** — 實測全價 input 僅佔 0.4%，大宗是 output。

