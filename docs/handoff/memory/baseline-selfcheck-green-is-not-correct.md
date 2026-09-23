---
name: baseline-selfcheck-green-is-not-correct
description: 截圖門禁的自我比對全綠不代表基線是對的——它比的是基線跟自己；2026-08-07 因此漏掉兩個致命缺陷，靠人眼開圖才發現
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f67467ed-ef4b-4119-bb27-cd1c8e0790c1
---

建立 RWD 截圖基線時跑 `rwd:check`，印出「比對 120 組｜相同 120｜桌機回歸 0｜門禁：通過」，我一度把它當成基線可用的證據。**它不是**——那一步比的是剛拍的基線跟同樣條件再拍一次，拍錯了也一樣全綠。

實際漏掉的兩個缺陷，都只有**人眼開 PNG 看**才會發現：

1. **淺色基線其實是深色**。截圖前注入 `localStorage.theme='light'`，但 `app.js` 在 `auth/me` 回來後呼叫 `ThemeManager.syncFromServer(me.odoo_settings.theme)`，`theme.js` 註解寫明「以後端為準」，把注入值蓋掉。截圖帳號後端設 dark → 63 張登入頁的淺色全是深色。事後可用 md5 比對 light/dark 檔案驗證（相同＝壞掉）。
2. **中文全是豆腐框**。截圖容器 `fc-list :lang=zh` = 0。截圖仍有決定性（門禁全綠），但字寬失真，而 RWD 判「手機會不會擠爆」靠的就是字寬。

**Why**：自我比對只驗決定性，不驗內容正確。內容正確沒有任何機器把關（基線不進版控，也沒有 review）。
**How to apply**：任何「產基線→自我比對→通過」的流程，通過之後**一定要抽看幾張真圖**。至少一張需登入頁的 `__light`（確認真的是淺色）、一張手機圖（確認中文是字不是方框）。這條已寫進 `docs/RWD-C-SPEC.md` §9.5。

相關：[[rwd-project-status]]。
