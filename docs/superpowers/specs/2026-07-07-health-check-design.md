# odoo-v2 工作平台全面健檢 — 設計文件

日期：2026-07-07
狀態：已核准（使用者選定方案丙：多 agent 平行深查）

## 背景與目標

odoo-v2 是網頁模式的開發工作流程平台（Node pipeline 驅動 Claude agents）。使用者三大目標依優先序：

1. **穩定運作** — 能用程式處理的都用程式處理，考慮執行過程的意外
2. **準確率** — 分析、QA、自動測試三道關卡有效篩選
3. **省 token** — 在前兩項確保的前提下極致節省

觸發事件：任務 52「報價單的客戶下面增加備註T欄位」——一個極簡單任務跑了兩天未完成，
coding×6、qa×6，共 4.77M tokens。驗屍已證實三個根因（列入報告，不重查）：

- **根因 A**：`__pycache__/*.pyc` 未被 gitignore/清理 → merge 反覆失敗
- **根因 B**：部署測試區失敗一律退回 coding，未區分環境問題 vs 程式問題 → coding 被冤枉重跑
- **根因 C**：`deploy-testing.js` 的 `extractOdooError()` 在 log 無 ERROR 行時擷取失效，
  blocker 只存到 Odoo 版本 banner → 診斷資訊丟失，人工介入無從下手

全系統至今 15 個任務、約 7.5M tokens；另觀察到 6 個任務停在 `cs_running`、4 個停在
`cs_data_needed`（疑似無人接手的卡點，待資料層查證）。

## 範圍

**包含**：`app/server/`（含 pipeline、routes、tests）、`app/public/`、`.claude/`
（agents、skills、CLAUDE.md、settings）、`start.ps1`、`install.ps1`、
`data/config.json`（僅檢查結構與安全性，不得輸出秘密值）、平台自身資料庫（唯讀 SELECT）。

**排除**：`repos/`、`odoo-envs/`、`node_modules/`、`kingsmvpsplan/`、Odoo 原始碼、
任何修補動作（全程唯讀，報告先行）。

## 原則

- 全程唯讀，不改任何程式碼
- 每個發現必附 `檔案:行號` 證據；禁止「感覺不好」式發現
- 每個發現標注：嚴重度（P0 事故級／P1 高／P2 中／P3 建議）＋影響目標（穩定／準確／token）
- 任務 52 三個根因直接列為已證實發現，查察 agent 不重報，但相鄰問題要報

## 執行架構（Workflow 三階段）

### 階段一：平行深查（4 個查察 agent 同時跑）

| Agent | 對象 | 檢查項目 |
|---|---|---|
| 資料層 | 平台 DB（唯讀） | 卡住任務為何卡住、task_events 全掃異常、token 離群點、孤兒記錄 |
| 流程層 | `runner.js` + pipeline 全部 handler | 完整狀態機圖、逐條失敗路徑：server 重啟恢復、API 錯誤/timeout、git 操作失敗、重試歸因、計數器歸零、併發鎖 |
| Agent 層 | `.claude/agents/*.md` + JS 呼叫端 | 輸出 JSON 解析強健度、model 配置是否過殺、重跑帶什麼 feedback、placeholder 注入完整性、prompt 冗餘 |
| 專案層 | tests、config、前端、routes | 測試是否驗證意圖、金鑰與 API 面安全、前後端狀態清單同步、死碼 |

### 階段二：交叉驗證（adversarial）

每個 P0/P1 發現派一個獨立驗證 agent 對照實際程式碼試圖推翻；被推翻的剔除或降級。
採 pipeline 式：某層查完即開始驗證該層，不等全部層完成。

### 階段三：綜合

主迴圈（非 agent）彙整為單一報告 `docs/health-check-2026-07-07.md`，含：

1. 發現總表（嚴重度排序，每項含證據、影響目標、修補方向）
2. 任務 52 驗屍對照（根因 A/B/C ＋ 新發現如何解釋該事故）
3. 修補路線圖建議：分「快速止血」（小補丁，立即可做）與「需設計」（動狀態機／流程，需再 brainstorm）兩類

## 完成標準

- 4 層全部查完，無層被跳過
- 所有 P0/P1 發現經過獨立驗證
- 報告可供使用者直接決策「修哪些、什麼順序」
- 健檢本身 token 預算：約 1～2M

## 後續

報告經使用者審閱後，另行 brainstorm 修補方案（不在本設計範圍內）。
