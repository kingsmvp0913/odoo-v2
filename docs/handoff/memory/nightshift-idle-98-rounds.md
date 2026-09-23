---
name: nightshift-idle-98-rounds
description: 夜班連續 98 輪記「無變化」的真因是待辦來源檔早已消失，而 skill 沒寫來源全空要怎麼辦；已修並補上硬規則
metadata: 
  node_type: memory
  type: project
  originSessionId: 690e6cd9-a432-4001-b34a-408893902f2e
---

2026-09-02 查出來的。`docs/nightshift-review.md` 從輪次 27 到 125 全是同一段話：
「維護模式、無變化、額度 37%、測試跳過、六件待拍板事項仍卡在使用者裁決」。

## 真因

`nightShift` skill 的「待辦來源」指向 `OAA-UI-NEXT-CORRECTION-SPEC.md` 與 `OAA-UI-NEXT-ROUND2-SPEC.md`。
**這兩份檔案早就從硬碟消失了**（曾在 repo 根被 commit 過，後來刪除；`docs/` 又在 `.gitignore`，所以也不在那）。

skill 沒有寫「來源找不到時該怎麼辦」⇒ 每一輪都：讀不到待辦 → 判定沒事可做 → 記一筆維護模式 → 排下一輪。
**燒了 98 輪額度去確認同一件事，而且每一輪的交班紀錄看起來都很正常。**

## 修法（commit `8ad67481`）

- 待辦來源改成三層：使用者當面交辦 → 交班檔最後一輪的「仍未做」清單 → 規格書
- 補硬規則：**來源全空 ≠ 無事可做，那是訊號本身壞了 ⇒ 直接停手並在交班檔寫明**
- 規格書可從 git 撈：`git show dca89815:OAA-UI-NEXT-CORRECTION-SPEC.md`、`git show 8842b336:OAA-UI-NEXT-ROUND2-SPEC.md`

## 一併修掉的三個過期事實

- 額度門檻寫死 60%，但使用者當面改過（09-02 給 70%、明言不寫回檔）⇒ 改成每輪問
- 週額度重置時間照推算會失準：**09-02 實測同一場作業內 `utilization` 從 50% 掉到 2%，而記錄的 `resets_at` 還在隔天** ⇒ 一律讀 API 當下值，不要拿推算值分配「還剩幾個百分點」
- `RWD_TOKEN` 的到期日已過且沒人更新 ⇒ 改成寫「很可能已過期」並附換發步驟

**Why**：自動化流程「安靜地空轉」比「大聲失敗」難發現得多——每一輪都成功、都有紀錄、都符合預期格式。
**How to apply**：任何排程／迴圈型工作，如果它的輸入來源是外部檔案，一定要寫「來源不存在」的分支，
且該分支必須**停止並發出訊號**，不可以降級成「這輪沒事做」。
相關 [[ui-next-production-cutover]]、[[stale-memory-blocks-work]]（記憶／文件會腐爛成擋路的假事實）。
