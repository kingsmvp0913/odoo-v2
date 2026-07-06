# CLAUDE.md

> 註：舊的 PS1「開工」pipeline 已退役，全部改走網頁模式（`app/` 內的 Node pipeline）。
> 本檔僅保留仍適用的通用開發規則。

## Skills
- **getSQL** (`.claude/skills/getSQL/SKILL.md`) - 透過 SSH-SQLM API 查詢遠端 PostgreSQL。觸發：`/getSQL`
When the user types `/getSQL`, invoke the Skill tool with `skill: "getSQL"` before doing anything else.

## 0. Hard Rules
- NEVER modify core Odoo files or `custom_addons/`. 自訂程式一律寫在「當前任務所在的 repo／addons 目錄」內——實際路徑由執行時的 agent prompt 指定；不得寫死或存取工作目錄以外的絕對路徑（如 `online_addons`）。
- NEVER guess intent. Surface 2–3 interpretations when ambiguous; state one core assumption before complex tasks. When still uncertain after surfacing interpretations, ask — do not proceed on a guess.
- Stop when confused. Name what's unclear before continuing.
- NEVER add fields/models/logic beyond the task's agreed spec.
- 寫入專案檔案時一律使用相對路徑或環境變數，**禁止寫死任何絕對路徑**（包括 `C:\` 或 `/home/...`）。
- Think in English. Output Traditional Chinese (Taiwan). No preambles.
- Challenge proposals that violate Odoo best practices, security, or performance.
- 不得在未經使用者明確同意下修改工作流程設定（hook、`settings.json`、CI、本檔）。

## 1. Odoo Constraints
- Models: `_inherit`. Views: `inherit_id` + `xpath`. Controllers: `super()`.
- 無法透過標準 Odoo 擴充達成 → 明確向使用者說明，不要硬幹或繞過。
- Commit: `[Module]: Why (not what)`. File edit: `@Path | Anchor | Action`.
- Views XML 命名：`<model>_views.xml`；同一 Model 只能有一個 view 檔案。
- View 繼承：同一 addons 若已繼承某原生 view，新增內容直接寫入該繼承 view，禁止另建第二個繼承。
- 新建 module（addon）命名一律以 `idx_` 開頭（例：`idx_sale_note`）；沿用既有 module 時不改名。
- Models 命名：一個 Model 一個 `.py` 檔；單頭＋明細單據（如 `sale.order` + `sale.order.line`）合併，以單頭為檔名（`sale_order.py`）。
- View 放置：依 view 所屬的 Model 放入對應 XML。例：銷售訂單頁的 product tree view → `product_template_views.xml`。
- 樣板文件（xls/docx）一律放 `<module>/static/<type>/`。例：`hr/static/xls/abc-test.xlsx`。
- 禁用原生 `round()`（銀行家捨入，30.5→30，非台灣四捨五入）；改用 `Decimal` + `ROUND_HALF_UP`。
- 原生 SQL 執行前呼叫 `flush_model()`，執行後呼叫 `invalidate_model()`，避免 ORM cache 導致畫面不更新。

## 2. Edit Protocol
- **Minimum code that solves the problem.** No speculative features. No abstractions for single-use code. (Test: would a senior engineer call this overcomplicated?)
- Touch only what you must. Don't clean up adjacent code, comments, or formatting that isn't yours.
- Match existing code style exactly. Zero drive-by refactoring.
- Before adding code, read exports, immediate callers, and shared utilities. "Looks orthogonal" is dangerous — if unsure why code is structured a certain way, ask.
- Conformance > personal taste inside the codebase. Follow conventions even when you disagree.
- If a codebase convention seems harmful, surface it explicitly. Don't fork silently.
- `[Step] → [Verify]`：Python `python -m py_compile <file>`；XML `xmllint --noout <file>`；可載入性 `odoo-bin -d test --stop-after-init -i <module>`（若可用）。

## 3. Output Style
繁中術語：專案/資料庫/佈署/模組. Keep English: Variable/Function/Hook/Class/Field/Model/Method/Controller.

## 4. General Engineering Rules

**Rule 4 — Goal-Driven Execution**: Define success criteria before starting. Iterate until verified. Don't follow steps mechanically; define success and drive to it. Strong success criteria enable independent looping.

**Rule 6 — Token Budgets (not advisory)**: If approaching context limits, summarize and start fresh. Surface the breach explicitly — do not silently overrun.

**Rule 7 — Surface Conflicts, Don't Average Them**: If two patterns contradict, pick one (more recent / more tested). Explain why. Flag the other for cleanup. Don't blend conflicting patterns.

**Rule 9 — Tests Verify Intent**: Tests must encode WHY behavior matters, not just WHAT it does. A test that can't fail when business logic changes is wrong.

**Rule 10 — Checkpoint After Every Significant Step**: Summarize what was done, what's verified, and what's left. Don't continue from a state you can't describe back. If you lose track, stop and restate.

**Rule 12 — Fail Loud**: "Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were skipped. Default to surfacing uncertainty, not hiding it.
