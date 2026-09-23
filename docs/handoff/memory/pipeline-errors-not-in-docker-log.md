---
name: pipeline-errors-not-in-docker-log
description: "除錯 pipeline agent 失敗別指望 docker logs——[CS-AGENT]/[RUNNER]/[TOKEN-LOGGER] 等 console.error 全沒進容器 log"
metadata: 
  node_type: memory
  type: reference
  originSessionId: ab34cc46-1c82-4e77-b0b7-75a5415989d6
---

實測（2026-08-04，掃 `docker logs odoo-v2` 07-30→08-04 全量）：pipeline 各 agent 的 `console.error` 前綴 `[CS-AGENT]`／`[TASK-AGENT]`／`[QA-AGENT]`／`[RUNNER]`／`[TOKEN-LOGGER]`／`[DEPLOY]`／`[MERGE]` **各 0 筆**，儘管 token_usage 當期有 ~25 筆 status='error'。對照 `[GRAPHIFY]`(7)／`[updateMainClone]`(2)／`[vpn]`(11)／`[entrypoint]`／socket `connected:` 都在。

`start.sh` 結尾 `exec node app/server/index.js` 沒有重導輸出，理論上 stdout+stderr 都該進 docker json-log，但 pipeline 錯誤實際就是沒出現（根因未確認，可能與輸出被緩衝、或錯誤集中在重啟/被殺窗口而未 flush 有關）。

**影響**：查失敗任務真因時，`token_usage` 只有 0 token/null model/無訊息、`task_events` 是整段終端串流噪音大（見既有 pipeline 規則 #96）、docker log 又沒有——三處皆難。真因常已不可考。除錯優先靠 `blocker_content`（但會被 resume 覆蓋）＋時間線旁證（重啟事件 `收到停止訊號`／`AI Dev http`）。

修這個缺口（讓 pipeline 失敗含 err.message 落到持久 log）是 [[token-report-aborted-fix-pending]] 列的待辦之一。
