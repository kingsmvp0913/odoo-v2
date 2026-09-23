---
name: odoo-v2-repo-is-public
description: 平台 repo kingsmvp0913/odoo-v2 在 GitHub 是公開的——含漏洞細節、客戶名、內網資訊的文件絕不能 push
metadata: 
  node_type: memory
  type: project
  originSessionId: 1629885e-a788-49eb-9b57-0b3e853ed318
  modified: 2026-09-11T07:31:48.297Z
---

2026-09-11 實測：未帶認證 `curl https://api.github.com/repos/kingsmvp0913/odoo-v2` 回 **200** ⇒ repo 公開（本機無 `gh`，只能這樣驗）。

使用者要我「push 規格上去看」時我擋下來問：五份產品化規格（見 [[productize-saas-decision]]）寫了未修的漏洞利用方式（AI `echo $APP_SECRET`）、內部 IP 與開放埠、客戶名（鴻久／鴻伍／慈雲）與 DB 大小。使用者改選「做成只有他看得到的 claude.ai 私人網頁」。

**Why:** push 到公開 repo＝把攻擊指南公開；另 rules/always.md 第 8 條本就規定 `docs/` 不進版控、禁 `git add -f`。

**How to apply:**
- 使用者要「推上去看」任何含安全弱點、客戶資料、內網拓樸的文件 → 先講 repo 是公開的，改用私人 artifact 或 SendUserFile。
- commit 訊息與版控內的註解也會公開——寫到客戶名、正式機位址時要意識到這點。
- 未處理的疑慮（沒問使用者）：平台原始碼本身公開，攻擊者可自行讀出同樣的弱點；要不要轉 private 是使用者的決定，下次合適時提一句。
