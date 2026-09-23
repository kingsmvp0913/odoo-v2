# 換機接手包

`docs/` 整個目錄在 `.gitignore` 內（見 `.claude/rules/always.md` 第 8 條）。
本目錄與產品化規格書是**刻意用 `git add -f` 納入版控**的，目的是讓另一台機器能接手產品化工作。
其餘 `docs/` 內容仍不進版控。

## 內容

- `memory/` — `~/.claude/projects/-home-odoo-odoo-v2/memory/` 的快照（125 檔）。
  `MEMORY.md` 是索引，其餘每檔一則事實，彼此用 `[[slug]]` 互連。

## 在新機器上還原記憶

```bash
mkdir -p ~/.claude/projects/-home-odoo-odoo-v2
cp -r docs/handoff/memory ~/.claude/projects/-home-odoo-odoo-v2/memory
```

路徑中的 `-home-odoo-odoo-v2` 由 repo 絕對路徑推導（`/home/odoo/odoo-v2` → 斜線換成 `-`）。
新機器的 clone 路徑若不同，目錄名要跟著改。

## 產品化規格書位置

> 此 repo 的 `specs/` 放設計、`plans/` 放施工規格，與字面直覺相反。

- `docs/superpowers/specs/2026-09-11-productize-*.md` — 總覽與分期計畫，**從這兩份開始讀**
- `docs/superpowers/specs/2026-09-11-*-design.md` — 各分期設計
- `docs/superpowers/plans/2026-09-1*.md`、`2026-09-2*.md` — 施工規格
- `docs/superpowers/research/2026-09-22-*.md` — 階段 3／4 的前置調查
- `docs/superpowers/specs/_page/` — 規格進度網頁產生器；改完 §0 進度表後跑
  `node docs/superpowers/specs/_page/build-specs-page.js`，再把產出複製到 `docs/`

## 注意

記憶檔記錄的是**寫入當下**為真的事。引用前先驗證檔案、函式、旗標是否還在。
