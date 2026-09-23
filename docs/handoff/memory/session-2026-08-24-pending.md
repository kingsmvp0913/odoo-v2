---
name: session-2026-08-24-pending
description: 2026-08-24 收工狀態：測試區一致性四項修正＋YAML 引號 prompt 修正皆已 push，但平台未重啟所以 server 端修正尚未生效；含明天要接的四件事
metadata: 
  node_type: memory
  type: project
  originSessionId: 96c1bc6f-f44b-49a5-83d1-2716a147d3f8
---

2026-08-24 做完並 **push 到 master** 的兩批（測試 3129 → 3168 全綠，exit 0）：

1. `7cf7f48`＋merge `67143d2` — 測試區一致性四項（server 碼）
2. `b45cb09` — YAML 引號規則（三個 agent prompt）

## 明天接手的四件事（依優先序）

> **08-25 進度：第 1、2 項已完成。** 平台已於 08-25 11:19:16 重啟（`ps -eo lstart` 確認），server 碼修正已生效；
> 萊峰19 的 344 個附件檔已全數補回，見 [[raifong19-filestore-loss]]。**第 3、4 項仍未做。**

1. ~~**請使用者在主機下 `docker restart odoo-v2`**~~（✅ 08-25 11:19 已重啟）——`app/server/**.js` 的修正全部還沒生效（常駐進程載舊碼，見 rules/always.md 3）。
   我在容器內 kill node 會連 postgres 一起收掉，見 [[platform-restart-kills-container]]。
   ⚠ agent `.md` prompt 走 mtime 熱載（`agent-loader.js:385-387` 實測確認），**不受此限、已生效**。

2. ~~**萊峰19 還有 344 個附件檔可救**~~（✅ 08-25 已全數補回，仍缺 98 個 17 也沒有）。手法已驗證：19 的資料是從 17 遷移的，
   `store_fname`（內容 sha1）完全相同，可從 `odoo-envs/raifong/filestore/test_raifong/` 複製過去。
   見 [[raifong19-filestore-loss]]。**動 owner 前先查 uid**，見 [[kangyue-filestore-uid-mismatch]]。

3. **task 182（採購修正）停在 stopped，但碼早就完成**——coding agent 確認三條 requirements 在
   `86faa50`／`2df8bab` 就做完了、working tree 乾淨，白卡兩輪在 YAML 格式上。推進方式：
   `POST /api/tasks/182/resolve-blocker` 帶修正指示（會交分診員判 resume/advance/fix/respec）。

4. **respec-patch 與 spec-review 的首輪 prompt 改動尚未被實際觸發過**，只有 analysis 那條線實跑驗證過。
   下一張走到那兩關的任務要回頭確認。見 [[yaml-colon-breaks-spec-parse]]。

## 未做、已知但刻意沒動的

- **應用程式列表圖示沒有真的修好**：15 個選單圖示的 attachment 我從 17 撈回、sha1 逐一驗過、HTTP 全 200，
  但把圖抓下來用眼睛看，內容**本來就是 Odoo 的灰色佔位圖**（相機＋加號）。使用者說「可以了」先放著。
  教訓同 [[baseline-selfcheck-green-is-not-correct]]：sha1 對、200、shell 讀得出 binary，全都證明不了「圖是對的」。
- 提案文件 `docs/proposal-2026-08-24-testenv-consistency.md`（docs/ 在 .gitignore，不會進版控、換機器就沒了）。
