---
name: stale-memory-blocks-work
description: 待辦清單自己會腐爛——2026-08-12 一輪就拆掉四個「查到一半就下結論、之後沒人回頭驗」而變成擋路事實的記錄；含四個實例與該用什麼方式複驗
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7838e378-5e62-4a4d-a69e-922eea0d06fd
---

使用者問「還有什麼未完成的嗎」，我第一份答案有一半是在複誦腐爛的記錄。追問之下，**四條「未完成」
其實都不是沒做，是記錄錯了**：

| 記錄說 | 實際 | 錯在哪 |
|---|---|---|
| 「這台裝不了 codex」 | `npm config set prefix ~/.npm-global` 後 3 秒裝完 | 只驗到「不能裝進 root 擁有的 `/usr/lib/node_modules`」就外推成「做不到」 |
| 「E2E 只有 odoo19(id 4) 能驗」 | 它是 **0 repo、0 任務的空殼**，永遠跑不到那關 | 只看 `e2e_disabled` 欄位，沒查它有沒有 repo |
| 「7 個專案被刻意關掉 E2E」 | 新建專案**預設**就關（INSERT 寫死 true） | 把「預設值」誤讀成「有人決定關掉」 |
| 「4 筆明碼待重啟轉檔」 | 早就轉完了 | 沒回頭驗；且我複驗時用 hex regex 去比對 base64 密文，差點二度誤判 |

**Why**：這四條的共同結構是——**在事情查到一半時下了結論，之後沒人回頭驗證，它就從「暫時的觀察」
變成「擋路的事實」**。危害不是資訊過期，而是它們會讓人**放棄嘗試**：照「只有 odoo19 能驗」那條走，
再試一百次 E2E 也不會成功。

**How to apply**：
- 記憶裡任何「做不到／不可能／只能靠 X」的**否定式斷言**，引用前先花 30 秒實測。否定式斷言最貴，
  因為它會直接終止探索，而且沒人會去挑戰它。
- 特別警戒「因為 A 所以做不到」這種**單一證據的外推**。當初的證據（npm root 是 root 的）本身沒錯，
  錯在結論的範圍遠大於證據能支撐的範圍。
- 複驗時注意**驗證方法本身也可能是錯的**（hex vs base64 那次）。查不到預期結果時，先懷疑自己的
  查法，再下「沒做」的結論。
- 寫記憶時，把「已驗證的事實」與「當時的推論」分開寫。推論要標明**還沒驗**，否則下次讀的人
  （包括我自己）會當成事實。

相關：[[codex-provider-spec-blocked]]、[[e2e-disabled-runtime-errors-escape]]、
[[plaintext-credentials-in-odoo-settings]]、[[baseline-selfcheck-green-is-not-correct]]
