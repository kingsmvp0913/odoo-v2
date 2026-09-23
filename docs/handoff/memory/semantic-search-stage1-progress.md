---
name: semantic-search-stage1-progress
description: 語意檢索四階段全部做完（7 commit 進 master 未 push）；**server 尚未重啟所以全部沒生效**，前端也沒人工實測過
metadata:
  node_type: memory
  type: project
  originSessionId: d7d09721-74a2-44c2-9fbc-7fdbfe36d57d
---

規格書已執行完畢並移進 `docs/SPEC-semantic-search.md`（該目錄在 `.gitignore` 內，**傳不到別台機器**）。
commit：`69481b5` → `2a2c65b` → `b43338e`(階段 0) → `fac9dd8`(相依) → `4167c6e`(階段 1 核心)
→ `e60b5f9`(觸發點＋階段 2＋階段 3) → `813b1b1`(規格收尾)，全在 master、**未 push**。
測試 `2228 passed / 165 suites / exit 0`（動手前自己量的基線 2210 / 163）。

> ✅ **2026-08-10 複查更正**：server 已於 **08-08 09:32** 重啟，第 1 點**已解除**——`embedding_chunks`
> 有 345 塊、模型權重已在 `data/models/Xenova`，索引也建過了。`wiki_search_misses` 仍 0 筆（效果
> 驗收本來就要等樣本累積）。第 2 點前端人工實測仍未做。重啟方式見 [[platform-restart-kills-container]]。

**還沒做的兩件事：**

1. **server 尚未重啟——上述程式碼一行都還沒生效。** 平台 server 是 PID 33／PPID 1（容器直接拉起），
   kill 掉不確定有沒有東西自動重拉，所以沒動，要由使用者決定時機。首次重啟會背景下載約 130 MB
   模型權重到 `data/models/`，失敗只降級成純 LIKE、不影響啟動。重啟後到管理頁按一次「重建索引」。
2. **前端未人工實測**（本 repo 前端無自動化測試）：管理頁「語意檢索索引」卡片的狀態顯示、
   重建按鈕、輪詢進度，**含深色模式**。見 [[baseline-selfcheck-green-is-not-correct]]。

**最容易誤判的兩件事**（都不會報錯，只會安靜地少東西）：

- `searchProject` 不帶 `kind` 時，wiki 與 analysis_yaml 的塊住同一個 bucket，搜 wiki 會撈到任務塊，
  而它的 `wikiPageId` 是 null → 被濾掉，**症狀是「命中數量對得上、內容卻少幾筆」**。
- agent prompt 新增 placeholder 沒在 JS 端供值會渲染成**空字串**，agent 拿到 `project=` 的空網址，
  查無結果卻完全不報錯（這次 `{{project_slug}}` 就得同步改 `task-agent.js`）。

**Why:** 「碼已 commit 但 server 沒重啟」這個狀態最容易讓下一個人誤判成功能壞掉。
而規格已經移進 `.gitignore` 的 `docs/`，換一台機器就讀不到，接手時只剩 commit 訊息與這則記憶。

**How to apply:** 接手先讀 `docs/SPEC-semantic-search.md` 頂部那段「執行狀態」（七處實作偏離＋四個坑
都寫在那），不需要重讀對話。效果驗收要等 `wiki_search_misses` 累積一兩週才有樣本。
相關：[[e5-small-retrieval-behavior]]
