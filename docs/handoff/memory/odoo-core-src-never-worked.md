---
name: odoo-core-src-never-worked
description: 「agent 跑去 WebSearch 抓 Odoo 原始碼」真因＝lib/odoo-core-src.js 從 8/5 上線起一次都沒成功過（docker cp 死在 point_of_sale 的字型 symlink）；已修 17c9b50，三版核心已解出、免重啟生效
metadata:
  node_type: memory
  type: project
  originSessionId: c112a11a-8ffa-4ead-b135-92dc6ae92a1a
---

2026-08-11 追「各關靜默改用 WebSearch」時挖出來的。**先看這條，別再重造輪子**：平台早有
`app/server/lib/odoo-core-src.js`，會把 `odoo-idx:<major>` image 內的核心 addons 解壓到
`data/odoo-core/<major>/addons`，並由 `coreSourceGuidance()` 把路徑寫進六個關卡的 prompt
（`{{odoo_core_src}}`，走 `source-routing.md`），教 agent「先在這裡 Grep，這是真相來源，比 Context7 準」。

**但它從上線（8/5）起一次都沒成功過**：`data/odoo-core/` 底下只有 `.addons.tmp`，沒有 `addons`
也沒有 `.extracted` → `cachedCoreSrc()` 恆為空 → 每關都走「只用 Context7」那條分支。加上
[[context7-quota-exhausted]]，兩條查證管道同時斷掉，agent 只剩 WebSearch 抓 github raw。

**根因**：`docker cp` 寫入檔案系統時會驗證 symlink 目標在不在複製範圍內。odoo-idx:17 的
`point_of_sale/static/src/fonts/Inconsolata.otf` 指到 image 的 `/share/fonts/truetype/…`，
cp 於此回 `invalid symlink` 並 **exit 1（2 秒就死，不是逾時）**，已複製的 387/643 個模組留在
tmp、`rename` 永遠等不到。模組按字母序複製，停在 p 開頭 —— 與現場殘留數字完全吻合。

**修法（`17c9b50`，本地 commit 未 push）**：`docker cp <cid>:<src> -` 吐 tar 串流，本機 tar 解開。
tar 原樣保存 symlink、不驗證目標。實測 643/686/685 全數解出，三版各 4~5 秒（比原本寫檔還快）。
自己用 `spawn` 接管道而非 `sh -c 'a | b'`——管道的 exit code 只反映最後一段（rules/always #12）。

**現況**：17/18/19 三版都已解壓完成、marker 在。`coreSourceGuidance()` 是純同步 `fs.existsSync`，
所以**不必重啟 server 就已生效**（重啟只是為了載入新的 extract 碼，供日後新版本用）。

**判讀與陷阱**：
- 這個 bug 逃過了 14 支測試，因為測試把 docker 全 mock 掉——測到的是「呼叫了什麼」而非意圖。
  補的兩支測試鎖的是「dest 必須是 `-`」與「cp 非 0 不得寫 marker」。
- `detectBroadScan` 回傳的是**物件** `{blocked, reason}` 不是布林；我用 `fn(c) ? ...` 驗證，
  物件恆 truthy → 五條指令全印 BLOCK，差點據此改守衛。已確認守衛對 `data/odoo-core` 放行、
  對 `find /`／`odoo-envs` 照擋，**不需改動**。
- 曾據此推薦「做一支 MCP 查核心原始碼」，在不知道本機制存在的前提下。知道後應撤回：agent 用
  Claude Code 內建 Grep/Read 比 MCP 固定介面強（可 glob、看上下文、逐步縮小），且這條已寫好。

**分工**（既有 prompt 已寫明）：核心 addons 原始碼（原生 view/xpath/class 實作）→ 本機唯讀路徑；
ORM 本體（`models.py`／`fields.py`／`http.py`）、版本差異、API 概念 → Context7。

相關：[[context7-quota-exhausted]]、[[e2e-disabled-runtime-errors-escape]]
