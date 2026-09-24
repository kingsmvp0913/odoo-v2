# 換機接手包

這個目錄的用途只有一個：**讓另一台機器（和另一個 AI）從零接手這個平台的開發。**

`docs/` 整個在 `.gitignore` 內（見 `.claude/rules/always.md` 第 8 條）。本目錄與產品化規格書是
刻意用 `git add -f` 納入版控的例外，其餘 `docs/` 內容仍不進版控。

## 在新機器上：一道指令

```bash
git clone <repo> odoo-v2 && cd odoo-v2
./install.sh          # Windows 用 .\install.ps1
```

`install.sh` → `scripts/setup.js` 會依序處理：系統套件（Node 20／Git／Python3／Chrome／
PostgreSQL／xmllint／Docker）→ `data/config.json` → 建 DB role/db → `npm install` →
Claude Code CLI 與訂閱登入 → 5 個官方 plugin → Codex CLI → **rtk** → VPN Gateway 與 AI 沙盒映像 →
**接手包還原**（本目錄）→ 啟動平台。

接手包還原這一步做的事（`scripts/lib/handoff.js`）：

| 項目 | 去處 |
|------|------|
| `memory/` — 114 則平台開發記憶 | `~/.claude/projects/<repo 路徑 slug>/memory/` |
| `claude-home/CLAUDE.md`、`RTK.md` | `~/.claude/` |
| `rtk-config/` — rtk 的過濾與顯示設定 | `~/.config/rtk/` |
| `claude-home/settings.json` | 合併進 `~/.claude/settings.json` |

> 接手包**不帶 graphify skill**：平台的 graphify 自動索引 2026-08-08 已移除，`install.sh` 也不裝
> `graphify` CLI，帶過去只會得到一個一跑就找不到執行檔的指令。要用就自己
> `pip install graphifyy networkx --user --break-system-packages`（PEP 668 環境需要後兩個旗標）。

三個刻意的行為，不是 bug：

- **只補不覆蓋**。新機器上已存在的記憶與設定一概不動——覆蓋會把後來更新過的事實打回快照當時的舊版。
- **記憶目錄名自動推導**。Claude Code 依工作目錄分存記憶，slug 是 repo 絕對路徑把分隔符換成 `-`
  （`/home/odoo/odoo-v2` → `-home-odoo-odoo-v2`）。clone 到別的路徑不必手改。
- **`rtk` 裝不起來時不寫入那條 hook**。寫了會讓之後每一次 Bash 呼叫都去跑一個不存在的指令。
  `rtk` 不在本 repo，由 `scripts/lib/rtk.js` 從官方 release（`github.com/rtk-ai/rtk`）抓預編譯檔放進
  `~/.local/bin`；Windows 沒有官方預編譯檔，會印連結後跳過。裝好後重跑
  `node scripts/setup.js --skip-start` 就會把 hook 補上。

## 安裝腳本做不到、必須人工補的

1. **`claude` 訂閱登入** — 安裝中會跳出登入畫面，此步無法自動化。
2. **金鑰**。`data/config.json` 不進版控（`JWT_SECRET`／`APP_SECRET`／DB 密碼由 setup 互動產生或詢問）。
   選填 `ANTHROPIC_API_KEY`。GitHub PAT、客戶資料庫連線密碼存在平台 DB 內，要在網頁上重新輸入。
   ⚠ **`APP_SECRET` 是舊 DB 內客戶憑證的解密金鑰**：若哪天要把舊資料搬過來，必須連同舊的
   `APP_SECRET` 一起帶，換了就全部解不開。
3. **資料**。新機器的 DB 是空的（專案、任務、用量紀錄、wiki 全無）。要搬就用 `data/backups/` 的
   每日備份還原，並帶上舊 `APP_SECRET`。
4. **企業版 addons**（`/enterprise/`）、**Odoo 核心原始碼**、**embedding 模型權重**（`data/models/`，
   約 130MB，首次啟動自動下載）、**RWD 截圖用的 Chromium 與中文字型** — 都不進版控，缺了各自重抓，
   指令見 `DEPLOY.md` 與 `app/rwd/README.md`。
5. **反向代理／網域／TLS** — 見 `DEPLOY.md`「掛在既有網域的子路徑下」。舊機器上的
   `BIND_HOST`、埠池、nginx 容器名寫在 `data/config.json` 與 `.env`，兩者都不在版控，要照舊機器重填。
6. **Docker 群組**要重登才生效；沒生效時 VPN Gateway 那步會 `[SKIP]`。

## 換機前，在舊機器上要做的

```bash
node scripts/lib/handoff.js --snapshot    # 把本機活記憶刷進 docs/handoff/memory/
git add -f docs/handoff docs/superpowers  # docs/ 在 .gitignore，一定要 -f
git commit && git push
```

快照會**排除客戶專案專屬的記憶**（代號清單在 `scripts/lib/handoff.js` 的
`PROJECT_MEMORY_PREFIXES`），因為接手的是平台開發這件事，且本 repo 是公開的。
被保留的記憶內文仍可能出現客戶代號與 `[[已排除的記憶]]` 連結——連結指不到東西是正常的，不是錯誤。

## 新 AI 的閱讀順序

1. `.claude/CLAUDE.md`（專案硬規則）與 `.claude/rules/always.md`（13 條常駐規則，含測試怎麼跑、
   commit 禁用 `git add -A`、改 skills 要同步）
2. `~/.claude/projects/<slug>/memory/MEMORY.md` — 記憶索引，每行一則，點進去看
3. `AGENTS.md`、`DEPLOY.md`
4. `docs/superpowers/specs/2026-09-11-productize-*.md` — 產品化總覽與分期計畫，**進行中的工作從這裡接**
5. `.claude/skills/` 底下的 skill（查 DB、查 wiki、除錯任務、健檢…）

> 此 repo 的 `specs/` 放設計、`plans/` 放施工規格，與字面直覺相反。
> 改完規格 §0 進度表要跑 `node docs/superpowers/specs/_page/build-specs-page.js`。

## 注意

記憶檔記錄的是**寫入當下**為真的事，會腐爛。引用前先確認檔案、函式、旗標還在
（`memory/stale-memory-blocks-work.md` 就是在講這件事）。
