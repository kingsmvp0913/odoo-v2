---
name: auto-fix-deny-deadlock
description: 改善通道三提案互鎖（2026-09-14）：守門碼在 DENY⇒自己的 bug 只能人工修；複檢基線漏 suite 數把未知當 0；原始碼字面 NUL byte 讓 diff 不可審
metadata: 
  node_type: memory
  type: project
  originSessionId: 75cf5825-ea9a-4df0-b938-2215773ba434
  modified: 2026-09-14T00:59:14.006Z
---

2026-09-14 修好並 commit（`d659ecfd`／`3dab7d80`），全套 4818 passed／0 failed（基線 4811）。**未重啟**——新欄位 `finding_fixes.baseline_suite_failed` 要等 server 起來跑 migrate 才存在。

## 最該記住的：DENY 清單造成的死結

`finding-fix.js` 的 DENY 擋掉守門碼本身（`finding-fix.js`／`nightly-fix.js`／`fix-verify.js`／`fix-review.js`／`feedback-merge.js`／`retire-prefix.js`／`maintenance.js`／`ui-preview.js` ＋ 四支 `.md`）。所以**自動通道永遠修不掉守門碼自己的 bug**：那種提案必然連撞三次「動到不該動的檔案」然後自動退場。

⇒ 看到退場理由是「動到不該動的檔案」時，先判斷是不是這一類。是的話**直接人工修，不要重送**——重送一次就是白燒一輪完整 platform_fix。這是設計的已知代價，不是缺陷。

當時三條互鎖：153（複檢基線）碼在 DENY 修不了 → 163（入口就攔 DENY-only 提案）是它的解藥卻被 153 的 bug 擋 → 164 被 NUL byte 擋。

## 兩個技術陷阱

1. **基線欄位缺值不可當 0**。`compareToBaseline` 原本寫 `Number(base.suiteFailed || 0)`，而 `fix-verify.js` 根本沒撈那一欄 ⇒ 工作區只要有一支 suite 載不起來就恆判退步。判讀線索：**同一組數字開發關 pass、複檢關 fail**（開發關手上有 suiteFailed，複檢關沒有）。
2. **原始碼裡的字面 NUL byte** → git 前 8000 byte 見到就判 binary → diff 只剩 `Binary files differ` → 審核關看不到內容必駁回。檔案其實沒壞。改成 unicode 逸出寫法，執行期字元相同（sha1 已實測相同）。已由 `app/server/tests/source-nul-byte.test.js` 掃目錄把關；在此之前**測試全綠、畫面零徵狀**。
   ⚠ 用 Write 工具寫「含逸出序列的註解」時，工具會把它轉成真正的 NUL byte——我自己當場踩了一次，是新加的守衛測試抓到的。

相關：[[improve-channel-stalled-silently]]、[[nightly-fix-verify-gate]]
