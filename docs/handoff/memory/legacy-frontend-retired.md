---
name: legacy-frontend-retired
description: 09-22 舊版前端整個刪掉（26 檔 9292 行）；連帶四個功能從此沒有畫面，且盲刪會白畫四頁而測試全綠
metadata: 
  node_type: memory
  type: project
  originSessionId: d3f6087f-9fd1-4b18-b7c1-56a61fb1fa49
  modified: 2026-09-22T07:07:15.829Z
---

2026-09-22 使用者裁決「舊版的其實可以完全退役」，`app/public/js/views/` 26 個檔、9,292 行全部刪除，`?ui=legacy` 入口移除，commit `62fcaa59`。

**Why:** 政策上早就「不維護」，但當天它兩度因後端契約改動而**壞在成功路徑上**（`applyFix` 拿掉 `inflight` 欄位、`findings/:id/fix` 從物件改成陣列 → `[]` 是 truthy），每次都要有人回頭修一份沒人在用的碼。

⚠ **盲刪會白畫四個頁面而且測試全綠**：`index.html` 無條件載入 `js/views/*`，而 ui-next 有 9 個常數其實定義在舊版檔案裡（`AR_KIND_*`、`PF_BUSES`/`PF_KIND_COLOR`、`HC_SEV`/`HC_LAYER`/`SEV_BY_RANK`/`HC_CADENCE`、`ANSWER_ALLOWED`）。靜態測試看不出常數不見了。

**連帶失去畫面的四個功能（後端端點都還在，只是沒有入口）**：健檢提案的人工處置（採用／推送／合併／捨棄）與裁決、**整個收件匣頁**（`read-all` 與 snooze 沒有 UI 了，badge 與逐張自動已讀仍在）、任務頁的單張健檢、任務清單的具名篩選組合（saved views）。使用者已知並接受，理由是改用夜間批次自動跑。

**How to apply:** 有人問「某某功能哪去了」先查這四項。要救的做法是**搬到 ui-next**，不是還原舊版——已經沒有退路可退了，這也讓人工瀏覽器驗收從「應該做」變成「必須做」。刪除時 11 個「掃到幾個檔」的守衛母體數字全部重新從樹上數過（不是減到綠為止），掃描對象只剩空集合的守衛直接刪掉而非改成永遠綠的空殼。
