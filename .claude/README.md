# Kingsmvps Pipeline (V8.5)

* 輸入「**開工**」，Claude 自動完成抓待辦任務 → 需求分析 → 實作 → QA
* 輸入「**codex開工**」，改由 OpenAI Codex 執行 AI 階段（Claude Code 不可用時可直接在 Codex 輸入「開工」）
* 輸入「**同步**」，只拉取最新 Odoo 任務到 `start/`，不觸發 pipeline。

---

## 安裝

### 前置需求

- PowerShell 7+（`pwsh`）
- Python 3.x
- Claude Code CLI（已登入）
- OpenAI Codex（備援，`npm install -g @openai/codex`）

### 設定步驟

1. **設定環境變數**（在 PowerShell profile 或 Claude terminal 執行）
   * [System.Environment]::SetEnvironmentVariable("ODOO_PASSWORD", "你的密碼", "User")
   * [System.Environment]::SetEnvironmentVariable("ODOO_SERVICE_PASSWORD", "你的密碼", "User")

2. **確認 `project_version_map.json` 已填寫**（`.claude/project_version_map.json`，專案與 Odoo 版本對照）

### 進階環境變數（選填）

| 環境變數 | 預設值 | 說明 |
|---------|--------|------|
| `PIPELINE_MAX_LOOPS` | 20 | Pipeline 循環次數上限，超過寫 `blocker.loop.txt` |
| `PIPELINE_MAX_REENTRIES` | 2 | 單一任務 QA 失敗退回次數上限 |
| `PIPELINE_MAX_LOWCONF` | 3 | 單一任務低信心度退回次數上限，超過升級 `blocker.spec.txt` |

---

## 怎麼用

1. 在 Odoo 建立任務
2. 在 Claude 輸入「**開工**」（或「**同步**」只拉取新任務不開工）
3. 需要填寫確認問題或是低信心度的時候，Claude 會暫停等你在 `analysis.yaml` 填完後再繼續。
4. 等待完成（任務出現在 `final/` 即代表通過 QA）

> **低信心度**：即使所有問題都已答覆，若生成規格的信心度低於 0.9，Claude 會補提新問題並退回 `confirm/` 等待補充，不會強行進入實作階段。退回超過 3 次（`PIPELINE_MAX_LOWCONF`）會自動升級為 `blocker.spec.txt`，需人工介入確認需求。

---

## 任務來源

Pipeline 同時從兩個 Odoo 來源拉取任務：

| 來源 | 系統 | task_id 格式 | 所需環境變數 |
|------|------|-------------|------------|
| 來源 1 | ideaxpress.biz（project.task） | `task_odoo_N` | `ODOO_PASSWORD` |
| 來源 2 | service.ideaxpress.biz（service.question.feedback） | `task_service_N` | `ODOO_SERVICE_PASSWORD` |

未設定對應密碼時，該來源靜默略過。

---

## 任務流向

```
Odoo 任務（雙來源）
   │ 自動同步 (curl.py / curl_service.py)
   │ pipeline 第一輪同時對待處理任務的 repo 執行 git pull
   ↓
start/       新任務
   │ 分析agent初步分析，產生問題確認檔
   ↓
confirm/     待確認
   │ 填寫問題，答案全部填寫且為有效答案後往下一步
   ↓
analysis/    分析agent產出完整技術規格SD
   │  │
   │  ├─ confidence >= 0.9 → 往下一步開始實作
   │  └─ confidence < 0.9  → 退回confirm 補充問題（超過3次→blocker.spec）
   ↓
coding/      由工程師agent實作中，完成後 Claude 自動執行 品管agent
   │ QA 通過，不通過的話回到confirm 確認
   ↓
final/       ✓ 完成（已歸檔）

stop/        ⏸ 暫停開發（手動移入，不參與 pipeline 掃描，手動移出才恢復）
```

---

## 多工說明

同一階段有多個任務時，Claude 自動並行處理：

- **需求分析 / confirm**：最多 5 個並行(目前訂閱方案較低，怕token不夠用才有這個限制)
- **實作 / QA**：同模組序列，不同模組並行（避免檔案衝突）
- **stop/ 任務**：被 pipeline 完全略過，不計入任何統計

---

## QA 檢查項目

| 類型 | 項目 |
|------|------|
| 規格合規 | Model、Field、View、Security 符合 analysis.yaml |
| 程式品質 | 不得在迴圈內查詢、不得用裸 SQL、`sudo()` 必須有說明 |
| 程式品質 | compute + store 必須有 depends、不得硬編碼 ID、不得用裸 except |

---

## Blocker 類型

| 檔案 | 情境 | 處置方式 |
|------|------|---------|
| `blocker.spec.txt` | 規格不清，需澄清 | 讀檔後填寫決策，刪除 blocker 檔，重新觸發 |
| `blocker.tech.txt` | 技術上不可行 | 調整需求或接受替代方案，刪除 blocker 檔 |
| `blocker.agent.txt` | Agent 執行錯誤 | 查看錯誤內容，修正後手動重跑 |
| `blocker.loop.txt` | 循環超過安全上限 | 查看原因，刪除 `_LOOP_COUNTER.json` 重置後重新執行 |
| `blocker.git.txt` | git pull 失敗 | 手動 `git pull` 對應 repo，解決衝突後刪除 blocker 檔 |

Blocker 模板在 `.claude/templates/` 目錄。

---

## 遇到問題

| 狀況 | 處置 |
|------|------|
| Claude 停下來說有 blocker | 查看對應任務目錄的 blocker 檔路徑，修復後 `touch system/.blocker_resolved`，再輸入「開工」 |
| MODE_A 等待填寫 | 打開 `confirm/task_N/analysis.yaml`，填寫所有 `user_answer` 欄位（單行純量，不可用 YAML literal block）|
| MODE_B 低信心退回 | 同上；Claude 新增的問題也在 `analysis.yaml` 的 `clarification_channel` 裡 |
| QA 一直失敗 | 查看 `coding/task_N/log/qa_report.yaml` 的 issues 說明 |
| Pipeline 沒有自動觸發 | 確認 `_PIPELINE_WAITING` flag 是否存在且未超過 30 分鐘 |
| 任務卡住診斷 | `find kingsmvpsplan -name "blocker.*.txt"` 一行查所有 blocker |
| Odoo 任務沒收到完成通知 | 設定環境變數 `ODOO_PASSWORD`；未設定時通知靜默跳過 |
| git pull 失敗（blocker.git.txt） | 手動進入 repo 目錄執行 `git pull`，解決衝突後刪除 blocker 檔再輸入「開工」 |
| 想暫停某任務開發 | 將任務目錄手動移入 `stop/`；想恢復時手動移回對應 stage 目錄 |
| 想停用 Odoo 同步（緊急） | 在 `kingsmvpsplan/` 建立空檔 `_ODOO_DISABLED`；刪除後恢復同步 |

---

## 目錄結構

```
<repo_root>/
├── AGENTS.md                   Codex AI 全域指令（.codex/ 的鏡像）
├── kingsmvpsplan/              任務狀態目錄（Claude / Codex 共用）
│   ├── start/                  新任務暫存（curl.py 同步後）
│   ├── confirm/                初始分析完成，等待 user_answer
│   ├── analysis/               答案完整，等待 MODE_B 規格生成
│   ├── coding/                 實作與 QA 進行中
│   ├── final/                  QA 通過歸檔（唯讀）
│   ├── stop/                   暫停開發任務（手動移入/移出）
│   └── log/
│       └── pipeline_run_summary.yaml
│
├── .claude/
│   ├── scripts/
│   │   ├── _common.ps1             共用函數庫（含 TOML 解析）
│   │   ├── _pipeline_run.ps1       「開工」Claude pipeline 入口
│   │   ├── _pipeline_trigger.ps1   UserPromptSubmit hook（「開工」/「codex開工」/「同步」）
│   │   ├── _sync.ps1               「同步」獨立同步入口
│   │   ├── analysis.ps1            STEP 1-3（Claude/Codex 共用）
│   │   ├── coding.ps1              STEP 4（共用）
│   │   └── qa.ps1                  STEP 5-6（共用）
│   ├── tools/
│   │   ├── curl.py                 Odoo 來源1 任務同步
│   │   ├── curl_service.py         Odoo 來源2 任務同步
│   │   └── send_message.py         Odoo 訊息發送
│   ├── agents/
│   │   ├── requirements-analyst.md     Claude 版 agent 提示
│   │   ├── senior-software-engineer.md
│   │   └── qa-analyst.md
│   ├── templates/              Blocker 模板
│   ├── CLAUDE.md               Claude AI 指令
│   ├── pipeline.md             Pipeline 完整規格
│   ├── README.md               本文件
│   ├── project_version_map.json
│   └── settings.json           Claude hooks 與權限設定
│
└── .codex/
    ├── AGENTS.md               Codex AI 全域指令
    ├── agents/
    │   ├── requirements-analyst.toml   Codex 版 agent（prompt + model 設定合一）
    │   ├── senior-software-engineer.toml
    │   └── qa-analyst.toml
    └── scripts/
        └── _pipeline_run_codex.ps1    「codex開工」Codex pipeline 入口
```

## Stage 標記一覽（Unified Marker Table）

| Stage | .pending_* flag | Done marker | 物理目錄 |
|---|---|---|---|
| analysis (初始) | `.pending_analysis` | `.analysis_done` | `confirm/` |
| answer-check | (PS1 自動，無 pending) | `.answer_done` | `confirm/` → `analysis/` |
| final (MODE_B) | `.pending_final` | `.final_done` | `analysis/` |
| final 低信心度 | (PS1 偵測 .low_confidence) | `.low_confidence` → 退回 confirm/ | `analysis/` → `confirm/` |
| coding | `.pending_coding` | `.implement_done` | `coding/` |
| qa | `.pending_qa` | `.qa_done` | `coding/` |
| archive | — | — | `final/` |

---

## Plugins 與 MCP

### Plugins（啟用中）

| Plugin | 用途 |
|--------|------|
| **superpowers** | 核心 skill 框架：brainstorming、TDD、systematic debugging、parallel agents 等工作流程技能 |
| **context7** | 即時抓取第三方套件文件（Odoo API、框架 method signature），避免訓練資料過時 |
| **hookify** | 分析對話記錄，建立 hook 規則防止 Claude 重複犯相同錯誤 |
| **code-review** | PR/分支程式碼審查 skill |
| **security-guidance** | 安全性審查與建議 |

### 自訂 Skills

| Skill | 用途 |
|-------|------|
| **graphify** | 將程式碼/文件轉換成知識圖譜（HTML + JSON），並輸出 `graphify-out/wiki/index.md` 供 pipeline 的 wiki cache 注入使用；觸發指令：`/graphify` |

### MCP Servers（啟用中）

| MCP | 用途 |
|-----|------|
| **serena-online** | 程式碼智能導航：跨檔案符號搜尋、find references/implementations、call chain 追蹤，範圍限定 `online_addons/`（降低 token 消耗；原生 Odoo API 改由 Context7 負責） |

> **知識檢索優先順序**（見 CLAUDE.md §2）：Graphify wiki → Serena → Context7

---

