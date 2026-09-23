---
name: deploy-stage-timing-invisible
description: 「部署測試區跑了 25 分鐘」多半是假象——等人審核的 review_pending 不寫 ▶ marker，時間被算進前一關；成功的 deploy 完全不落 log，耗時只能靠前後 marker 反推
metadata: 
  node_type: memory
  type: project
  originSessionId: 724d1cc2-0f15-49ed-8105-5b7de7526876
---

2026-08-11 task 106 的時間軸看起來像「▶ 部署測試區」跑了 25 分鐘，實際 deploy 只花 **79 秒**（下一則 `task_logs` 是 01:32:28「E2E 已依專案設定停用，跳過」），其餘 23.7 分鐘任務停在 `review_pending` 等人按退回。

**為什麼看不出來**：階段 marker 只在 `runner.js:349-351` 派工時寫，`review_pending` 不在 `HANDLERS`（`runner.js:315-335`）也不在 `STAGE_LABELS`（`runner.js:25-32`）——**等人的關卡永遠不留 ▶ 痕跡**，時間視覺上就併進前一關。和 commit `a840af7` 修過的「建立分支跑了 8 分鐘」（其實是出考題）是同一類病，只是換個位置再犯。

**成功的部署零紀錄**：`saveDeployLog`（`deploy-testing.js:188`）五個呼叫點全在失敗路徑；`[DEPLOY] …` 進度走 `notify.emitToUser`，只推 socket 不落 DB；deploy 是純程式關所以沒有 `token_usage`。**因此 `data/logs/deploy-task<N>-*.log` 不存在不代表沒部署**，只代表沒失敗。副作用：同日第 2、3 輪 deploy 各只花 6 秒／5.4 秒走完「升級＋restart＋asset 冒煙」，偏短但資料上無從驗證是否真的完整跑完。

**`data/logs/` 已被單元測試汙染**：1373 個檔中大量 `deploy-task20-timeout-*`、`deploy-task21-envdeath-*`（內容是 `exitCode: ?｜killed: yes` 這種 stub），跑一次全套測試就新增 ~227 個——jest 沒把 `DEPLOY_LOG_DIR` 導去暫存目錄。查真任務 log 時要先認得這批雜訊。

判耗時的正確作法：以 `task_logs` 的內容為準（它記了每關的真實結論），別只看 `task_events` 的 ▶ marker 時間差。相關：[[health-check-green-is-hollow]]、[[token-usage-underreports-cost]]
