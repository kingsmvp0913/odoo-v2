# 盤點：layout 類 inline style 待遷移清單

> 由 `app/rwd/inventory/scan.js` 產生（`cd app && npm run rwd:inventory` 可重跑）。
> 對應規格 `RWD-C-SPEC.md` Block 2／3。遷移完重跑一次，剩餘處數即進度。

## 總計

**0 處 inline style / 0 檔**（分類命中 0 次——同一處可同時屬多類）

| 類別 | 命中 |
|---|---|


## 分批

| 批次 | 處數 | 範圍 |
|---|---|---|


依「處數平衡」分批，不是依檔案大小：`TaskDetail.js`／`TokenReport.js` 的 127 處是**全部** inline style，
layout 類其實只有 14／17 處，照檔案大小分會讓兩批相差三倍。

## 遷移規則（規格 §2.2，不可放寬）

抽出的 class 內容**與原 inline style 逐字相同**：不順手改值、不合併相似規則、不改順序。
想調整的值一律留到後續 Block、在 media query 內處理。
驗收是像素級的——桌機截圖 diff 必須為 0。

---

