---
name: docs-handoff-tracked
description: 2026-09-23 起產品化規格書與記憶快照已 git add -f 進版控（commit 11f7b982），always.md 第 8 條只對其餘 docs/ 成立
metadata: 
  node_type: memory
  type: project
  originSessionId: c758734f-aaf5-4014-900e-d5666762288d
  modified: 2026-09-23T03:52:27.987Z
---

2026-09-23：使用者要換機繼續產品化工作，明確要求把規格書上 git，並在被告知
`kingsmvp0913/odoo-v2` 是**公開 repo**（內含客戶名、主機拓樸、當時未修的漏洞筆記）後
裁決「照推，確認可公開」。

已用 `git add -f` 納入版控（commit `11f7b982`，151 檔）：

- `docs/superpowers/specs/2026-09-11-productize-*.md`＋同日 `*-design.md`（設計）
- `docs/superpowers/plans/2026-09-1*.md`、`2026-09-2*.md`（施工規格；此 repo 的
  `specs/` 放設計、`plans/` 放施工規格，與字面直覺相反）
- `docs/superpowers/research/2026-09-22-*.md`
- `docs/superpowers/specs/_page/`（規格進度網頁產生器）
- `docs/handoff/memory/` — `~/.claude/projects/-home-odoo-odoo-v2/memory/` 的 125 檔快照
- `docs/handoff/README.md` — 新機器還原記憶的指令

**Why**：`docs/` 整個在 `.gitignore`，規格與 plan 本來傳不到別台機器。

**How to apply**：`.claude/rules/always.md` 第 8 條「`docs/` 不進版控、不要 `git add -f`」
現在只對**其餘** docs/ 檔案成立，上述清單是刻意的例外——看到它們出現在 `git status`
不是誤入，是正常追蹤。規則本文未修改（改專案規則檔要使用者同意）。
新增其他產品化規格後要一併 `git add -f`，否則換機那端看不到。
2026-09-24 起改成自動化（`scripts/lib/handoff.js`）：
- 舊機器換機前跑 `node scripts/lib/handoff.js --snapshot` 刷新快照（排除 `PROJECT_MEMORY_PREFIXES`
  列的客戶專案記憶，目前 hungjou／raifong／kangyue／ucpt，共 12 則；保留 114 則）。
- 新機器 `./install.sh` → `scripts/setup.js` 會自動還原記憶＋`~/.claude` 的 CLAUDE.md／RTK.md／
  graphify skill／settings.json（**只補不覆蓋**；本機無 `rtk` 時自動不寫那條 hook）。
- 還沒在真的第二台機器上實跑過 `install.sh`，只驗到單元測試（9 支）＋假 HOME 實跑還原。
記憶快照仍不會自己更新，要手動跑 `--snapshot`。

相關：[[productize-saas-decision]]、[[spec-progress-annotation]]
