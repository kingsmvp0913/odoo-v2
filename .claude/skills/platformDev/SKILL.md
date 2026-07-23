---
name: platformDev
description: Use when developing the platform app itself — app/server Node backend (routes, pipeline, tests) or app/public frontend (views, CSS). Covers jest/pg-mem/supertest conventions, test pairing rules, frontend structure, and the CSS variable / dark-mode color rules (moved here from CLAUDE.md §3).
---

# platformDev — 平台本體（app/）開發慣例

## Overview
這是開發**平台自己**（`app/` 的 Node server 與 `app/public` 前端）時的慣例。客戶 Odoo 模組開發規則不在此——那在 CLAUDE.md §0–§2（由 agent-loader 注入 pipeline）。

## 跑測試
```bash
cd app && npm test                                   # 全套（jest --runInBand --forceExit）
cd app && npx jest server/tests/<name>.test.js       # 單檔
```
- **DB 用 `pg-mem`**（記憶體 Postgres），route 用 `supertest`——測試不碰真 DB、不需服務在跑。
- `--runInBand` 是刻意的（共享模組狀態），別平行化。
- **配對慣例**：每個新 server 模組／route 檔配一個 `app/server/tests/<name>.test.js`（現有 100+ 檔全數如此），修 bug 先補會抓到該 bug 的測試。

## 後端結構速覽
- `app/server/*-routes.js`：HTTP API（`index.js` 掛載）；`/ai/*` 端點掛 `loopbackOnly`（只准本機，供 agent curl）。
- `app/server/pipeline/`：pipeline 各關 runner 與共用件——agent 定義載入（`agent-loader.js`，改 prompt 先看 **agentPrompt** skill）、`claude-runner.js`（spawn claude CLI）、`runner.js`/`task-agent.js`(流程編排)。
- `app/server/lib/`:跨模組工具(git、crypto、attachments、ssh-sql…)。
- `app/server/db.js`:schema 唯一真相(`migrate()` idempotent;加欄位走 ALTER 清單模式)。
- `app/server/cron.js`:背景批次(退回分類、wiki-drift 分類與套用…)。

## 前端結構（`app/public`）
- 無框架 vanilla JS：`js/views/*.js` 各頁 view、`js/store.js` 狀態、`js/socket.js`（socket.io 即時事件）、`js/api.js`（fetch 包裝）、`js/dialog.js`／`js/theme.js`。
- 元件外觀對照 `styleguide.html`；新 UI 先看有沒有現成 class。

## 配色／dark-mode 硬規則（原 CLAUDE.md §3 條文，真相在此）
- 配色一律走 `app.css` 的 CSS 變數／dark-aware class（如錯誤框套 `.error-msg`）。
- **禁止**在 inline style 寫死淺色 `background`（`#fff`/`#fef2f2`/`#f8fafc` 等）而不同時寫死可讀文字色——否則深色模式文字色吃 `var(--text)` 翻白＝隱形。
- 底色需區隔時用 `var(--bg)`/`var(--surface)` 等變數,勿寫死。

## Common Mistakes
- 動 `db.js` schema 忘了走 ALTER 清單（直接改 CREATE TABLE 對既有 DB 無效——`IF NOT EXISTS` 不會補欄位）。
- 新 `/ai/*` 端點忘掛 `loopbackOnly` → 對外暴露無認證端點。
- 前端 inline style 寫死 `#fff` 背景 → 深色模式隱形字（上方硬規則）。
- 改 pipeline agent 的 prompt 或共用片段卻沒看 **agentPrompt** skill → 契約靜默壞掉。
