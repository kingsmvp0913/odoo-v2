# CLAUDE.md (V8.4)

## Skills
- **getSQL** (`.claude/skills/getSQL/SKILL.md`) - 透過 SSH-SQLM API 查詢遠端 PostgreSQL。觸發：`/getSQL`
When the user types `/getSQL`, invoke the Skill tool with `skill: "getSQL"` before doing anything else.

## 0. Hard Rules
- NEVER modify core Odoo files. Custom code in `$ONLINE_ADDONS_DIR` (`C:\online_addons\` on Windows, `/online_addons` on Linux) only. Never touch `custom_addons/`.
- NEVER guess intent. Surface 2–3 interpretations when ambiguous; state one core assumption before complex tasks. When still uncertain after surfacing interpretations, ask — do not proceed on a guess.
- Stop when confused. Name what's unclear before continuing.
- NEVER add fields/models/logic beyond `analysis.yaml` spec.
- NEVER request human confirmation mid-pipeline. (此規則僅限 tool permission prompts；對真正的需求不確定性，仍應發問而非猜測。)
- On any blocker: write `blocker.<type>.txt` to `system/` in task dir → STOP immediately. Report **file path only**, never content.
- Think in English. Output Traditional Chinese (Taiwan). No preambles.
- Challenge proposals that violate Odoo best practices, security, or performance.
- NEVER modify any workflow (pipeline scripts, PS1 files, CLAUDE.md, agent prompts, hook configs, pipeline spec) without explicit user approval.

## 1. Paths
- **Task root**: `kingsmvpsplan/<stage>/<task_id>/`
- **Spec file**: `<task_root>/analysis.yaml`
- **Pipeline flag**: `kingsmvpsplan/_PIPELINE_WAITING` (content = ISO timestamp; TTL 30 min)
- **Loop counter**: `kingsmvpsplan/_LOOP_COUNTER.json`
- PS1 scripts run on the user's machine; paths are computed via `$PSScriptRoot` (cross-platform). When Claude executes on Linux, translate `C:\odoo` → project root, `C:\online_addons` → `$ONLINE_ADDONS_DIR` (fallback: `/online_addons`).
- Agent 寫入專案檔案時一律使用相對路徑或環境變數，**禁止寫死任何絕對路徑**（包括 `C:\` 或 `/home/...`）。

## 2. Knowledge Retrieval (Decision Tree)
Execute in order. Stop as soon as sufficient.
1. **Graphify** → `<online_addons_root>/graphify-out/wiki/index.md`
   - PS1 已在 `pending_prompt.txt` 內 prepend `[WIKI-CACHE]` 區塊（最多 60 行）；Agent 收到後直接使用，**不得重讀** wiki 檔案
   - **If wiki file not found → skip entirely, do NOT manually explore files, go to step 2**
2. **Serena** → Use when Graphify wiki is absent OR lacks a specific symbol/call chain
   - **On `tool_use_error` or no response → immediately write `system/blocker.agent.txt` → STOP. Do NOT retry.**
   - **Session query cap: max 3 distinct Serena queries per agent session. If still insufficient → write `system/blocker.agent.txt` → STOP.**
3. **Context7** → Only to confirm Odoo native API (field types, decorators, method signatures) for the target version
   - On any failure → skip silently (non-blocking; proceed with available context)
   - Session query cap: max **5** calls; after limit skip silently (non-blocking)

**WIKI-CACHE 注入**：由 PS1（`Get-WikiCache`）在生成 `pending_prompt.txt` 時自動 prepend（最多 60 行）。主調度不需重複注入。子 Agent 收到 `[WIKI-CACHE]` 後直接使用，不得重讀 wiki 檔案。

## 3. Task Spec

**Unified Marker Table** — authoritative reference for all Agents and PS1 scripts:

| Claude stage | pending flag (in `system/`) | done marker (in `system/`) | Physical dir |
|---|---|---|---|
| analysis (initial) | `.pending_analysis` | `.analysis_done` | `confirm/` |
| answer-check | _(PS1 only, no pending)_ | `.answer_done` | `confirm/` → `analysis/` |
| final (MODE_B) | `.pending_final` | `.final_done` | `analysis/` |
| final low-conf | _(PS1 偵測後重建)_ | `.low_confidence` → routes back to confirm/ | `analysis/` → `confirm/` |
| coding | `.pending_coding` | `.implement_done` | `coding/` |
| qa | `.pending_qa` | `.qa_done` | `coding/` |
| archive | _(none)_ | _(none)_ | `final/` ← QA-passed tasks |

> **`final low-conf` 注意**：PS1 偵測到 `.low_confidence` 後，移回 `confirm/`（保留 `.analysis_done`，不重建 `.pending_analysis`）。下一輪 STEP 3a 偵測到 `.analysis_done` 存在、`.answer_done` 不存在，等使用者填完新問題的 `user_answer` 後自動繼續，**不會重跑 MODE_A**。

**Task dir layout**:
```
<task_dir>/
├── analysis.yaml          ← spec（根目錄）
├── original.txt           ← 原始需求（根目錄）
├── process.lock           ← 臨時排他鎖（根目錄）
├── system/                ← 狀態機檔案（PS1 讀寫）
│   ├── pending_prompt.txt
│   ├── .pending_<stage>
│   ├── .<stage>_done
│   ├── blocker.*.txt
│   └── _reentry_count
└── log/                   ← 執行記錄（人工查閱）
    ├── done_prompt.txt
    ├── back_reason.txt
    ├── qa_report.yaml
    └── agent_error.txt
```

- `process.lock` 生命週期：由 PS1 在鎖定 task 目錄前建立（排他鎖），操作完成後釋放刪除。TTL 30 分鐘；下一輪 PS1 若發現逾時鎖，強制刪除後繼續。**Claude Agent 不得建立或刪除此檔**。
- **Stage source**: read `system/.pending_<stage>` flag filename inside task dir. Valid Claude-facing stages: `analysis`, `final`, `coding`, `qa`.
- `final/` directory = QA-passed archive, **not** a processing stage.
- `qa` shares the same module serial lock as `coding`.
- task_id format: `task_<N>` where N is digits only (e.g. `task_3919`).

`analysis.yaml` minimum required fields:
```yaml
case_id: ""
module: ""
odoo_version: ""
project_name: null   # null → version-only path; string → project path
execution_mode: "MODE_A"  # enum: MODE_A（直接實作）或 MODE_B（先確認再實作）
```

## 4. Edit Protocol
- Plans/logs → `.claude/kingsmvpsplan/`.
- **Minimum code that solves the problem.** No speculative features. No abstractions for single-use code. (Test: would a senior engineer call this overcomplicated?)
- Touch only what you must. Don't clean up adjacent code, comments, or formatting that isn't yours.
- Match existing code style exactly. Zero drive-by refactoring.
- Before adding code, read exports, immediate callers, and shared utilities. "Looks orthogonal" is dangerous — if unsure why code is structured a certain way, ask.
- Conformance > personal taste inside the codebase. Follow conventions even when you disagree.
- If a codebase convention seems harmful, surface it explicitly. Don't fork silently.
- Strict `[Step] → [Verify]` flow:
  - Python: `python -m py_compile <file>`
  - XML: `xmllint --noout <file>`
  - Module loadable: `odoo-bin -d test --stop-after-init -i <module>` (if available)
- **Completion order** (atomic protocol):
  1. Write done marker (e.g. `system/.implement_done`)
  2. `mv system/pending_prompt.txt log/done_prompt.txt`
  3. Delete `system/.pending_<stage>` flag
  - Never delete before writing marker.
- **Crash 修復**：掃描時若發現 done marker 存在但 `.pending_<stage>` 仍在（中斷狀態），補完剩餘步驟（`mv pending_prompt.txt → rm flag`）後繼續，不重新執行任務。

## 5. Odoo Constraints
- Models: `_inherit`. Views: `inherit_id` + `xpath`. Controllers: `super()`.
- Cannot achieve via standard Odoo extension → write `system/blocker.tech.txt` (see §8).
- Commit: `[Module]: Why (not what)`. File edit: `@Path | Anchor | Action`.
- Views XML 命名：`<model>_views.xml`；同一 Model 只能有一個 view 檔案。
- View 繼承：同一 addons 若已繼承某原生 view，新增內容直接寫入該繼承 view，禁止另建第二個繼承。
- Models 命名：一個 Model 一個 `.py` 檔；單頭＋明細單據（如 `sale.order` + `sale.order.line`）合併，以單頭為檔名（`sale_order.py`）。
- View 放置：依 view 所屬的 Model 放入對應 XML。例：銷售訂單頁的 product tree view → `product_template_views.xml`。
- 樣板文件（xls/docx）一律放 `<module>/static/<type>/`。例：`hr/static/xls/abc-test.xlsx`。
- 禁用原生 `round()`（銀行家捨入，30.5→30，非台灣四捨五入）；改用 `Decimal` + `ROUND_HALF_UP`。
- 原生 SQL 執行前呼叫 `flush_model()`，執行後呼叫 `invalidate_model()`，避免 ORM cache 導致畫面不更新。

## 6. Output Style
繁中術語：專案/資料庫/佈署/模組. Keep English: Variable/Function/Hook/Class/Field/Model/Method/Controller.

## 7. Pipeline
觸發條件（唯一）：使用者輸入「開工」→ Hook 執行 `_pipeline_run.ps1`；處理輸出中的 `[CLAUDE-ACTION-REQUIRED]` 區塊。

`_PIPELINE_WAITING`：純狀態旗標（**非觸發條件**），表示 PS1 機械處理已完成、有任務等待 AI。Claude **不得**因此旗標自動啟動，未收到「開工」前保持待命。TTL 30 分鐘（過期由 PS1 清除，不觸發任何流程）。

**對話答案處理（Hard Rule）**：若使用者在對話中回答了 `clarification_channel` 的問題：
1. **立刻**將答案寫入 `analysis.yaml` 對應的 `user_answer` 欄位（在任何 pipeline 操作之前）
2. spawn agent 時**必須以原始 `system/pending_prompt.txt` 不加任何修改**作為 prompt
3. **絕對禁止**在 agent prompt 中注入對話答案、背景資訊或任何 pending_prompt.txt 以外的業務內容
4. 正確流程：更新 yaml → 讓 pipeline STEP 3a 自然偵測答案完整 → 走 MODE_B SHORTCUT（省 ~45,000 tokens）

Full pipeline spec: **`.claude/pipeline.md`**

## 8. Blocker Types
（詳細規格與 Resume 流程見 `.claude/pipeline.md`）

| File | Situation |
|------|-----------|
| `blocker.spec.txt` | Spec unclear; user clarification needed |
| `blocker.tech.txt` | Cannot implement via standard Odoo extension |
| `blocker.agent.txt` | Agent execution error |
| `blocker.loop.txt` | Pipeline loop exceeded safety limit |

Templates in `.claude/templates/`. On blocker: STOP immediately. Report file path only, never content.

## 9. General Engineering Rules

**Rule 4 — Goal-Driven Execution**: Define success criteria before starting. Iterate until verified. Don't follow steps mechanically; define success and drive to it. Strong success criteria enable independent looping.

**Rule 6 — Token Budgets (not advisory)**: Per-task: 4,000 tokens. Per-session: 30,000 tokens. If approaching the limit, summarize and start fresh. Surface the breach explicitly — do not silently overrun.

**Rule 7 — Surface Conflicts, Don't Average Them**: If two patterns contradict, pick one (more recent / more tested). Explain why. Flag the other for cleanup. Don't blend conflicting patterns.

**Rule 9 — Tests Verify Intent**: Tests must encode WHY behavior matters, not just WHAT it does. A test that can't fail when business logic changes is wrong.

**Rule 10 — Checkpoint After Every Significant Step**: Summarize what was done, what's verified, and what's left. Don't continue from a state you can't describe back. If you lose track, stop and restate.

**Rule 12 — Fail Loud**: "Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were skipped. Default to surfacing uncertainty, not hiding it.
