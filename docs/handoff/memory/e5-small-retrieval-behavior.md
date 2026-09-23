---
name: e5-small-retrieval-behavior
description: multilingual-e5-small 在本專案真實 wiki 上的實測行為：LIKE 0 筆的三題都命中前二，但分數區間只有 0.80–0.90、切塊改善有限——「效果不好」先別急著調參
metadata: 
  node_type: memory
  type: reference
  originSessionId: d7d09721-74a2-44c2-9fbc-7fdbfe36d57d
---

2026-08-08 用 28 頁真實 wiki（鴻久）實測 `Xenova/multilingual-e5-small`（384 維，CPU）：

- **語意檢索確實補得到 LIKE 的洞**：「庫存沒有扣掉」「權限設定」「照片存不進去」三題 LIKE 都是
  **0 筆**（agent 會讀成「wiki 沒記載」），向量分別命中第 2、1、1 名。「照片存不進去 → NAS 補寫
  排程缺檔」這種零字面重疊的關聯是 LIKE 結構上做不到的。
- **分數區間極窄**：全庫落在 0.80–0.90，最高與最低只差 0.07。排序訊號本來就弱，別把「分數都很高」
  當成 bug，也別設絕對分數門檻——只能看名次（規格用 RRF 正是為此）。
- **切塊的效果比預期小**：28 頁切出 102 塊（3.6 塊/頁）後，只有「庫存沒有扣掉」從第 3 名進步到
  第 2 名，其餘三題與整頁不切一樣。目前 wiki 平均 478 字/頁，多數頁切完只有 1–2 塊。
- **仍有失敗案例**：「庫存沒有扣掉」第 1 名始終是無關的 NAS 頁。這是這顆模型的區分度上限，
  靠 LIKE 那條腿補精確詞，不是靠調切塊參數。
- 模型載入約 11 秒（一次），三段推論 21 ms。備援 repo 是 `nixiesearch/multilingual-e5-small-onnx`；
  **`onnx-community/multilingual-e5-small` 不存在**（HF API 回 401）。

**重跑驗證的方法**：`probe3.js` 那類腳本（切塊→embed→對真實 wiki 排序→與 LIKE 對照）比任何單元
測試都有說服力，因為檢索品質本來就測不出來。要點：用 `passage:`／`query:` 前綴、`pooling:'mean'`
＋`normalize:true`（之後 cosine 就是內積）、同一頁多塊命中取最佳名次不累加。

**Why:** 檢索品質沒有單元測試測得到，「效果不好」時最容易做的事是調切塊字數——而實測顯示那不是
主要施力點。有這組基準數字才分得出「模型的上限」與「我弄壞了什麼」。

**How to apply:** 日後有人回報語意搜尋不準，先確認是不是落在「wiki 根本沒寫」那一類
（階段 0 的 `wiki_search_misses` 就是為了分辨這個而做的），再看名次而非絕對分數，最後才動切塊參數。
相關：[[semantic-search-stage1-progress]]
