---
name: merge-single-point-zeroed-nightly-batch
description: 改善通道 2026-09-07 整晚歸零的真因是 merge 這一支 agent 的 JSON 格式失誤（未跳脫雙引號）＋它是整批候選的單點；已修成「落空就逐條跑」並 push a6d552b6，未重啟未實跑
metadata: 
  node_type: memory
  type: project
  originSessionId: c19224cd-c577-4cec-907a-ed45f11d6049
  modified: 2026-09-08T00:53:07.624Z
---

2026-09-07 夜間批次：4 筆 approved 候選（feedback #11~#14）一條都沒跑到，畫面零徵狀，看起來像「昨晚根本沒跑」。與 [[improve-channel-stalled-silently]] 記的 09-04 停擺**不同真因**——那次是通道卡死，這次通道是通的。

## 真因

merge agent（opus）在 `detail` 裡寫了未跳脫的半形雙引號（`照 "契約" 改`），整份 JSON 解析不出來。`parseAgentResult` 內建的 haiku 補救要把數 KB 中文**一字不改重抄一遍**，抄的過程自己又出錯 ⇒ 回 `[]`。而 `nightly-fix.js` 把「合併」當成必要前提，`!mergedGroups.length` 直接 `return`，早退在 `INSERT health_check_runs` **之前**。

結果三件事同時成立：沒有 `cadence='nightly-fix'` 的批次列、候選 `fix_attempts` 全是 0（不記個別失敗是刻意的，那不是候選的錯）、只留兩行 console.error。**帳面完全乾淨**。

## 查證路徑（下次同樣症狀照走）

1. `token_usage` 篩 `agent_type IN ('feedback_triage','feedback_merge','platform_fix','fix_review','fix_verify')` 看那晚跑到哪一關斷掉——triage 有、merge 有、platform_fix 沒有 ⇒ 死在 merge 到 runFix 之間。
2. `health_check_runs` 沒有該晚的 `nightly-fix` 列 ⇒ 早退在 INSERT 之前（三個早退點都在它前面）。
3. **`prompt_logs` 裡緊接 merge 的那筆 `agent_type='repair'` 就是證據**：它的 prompt 內含「上一次解析失敗的錯誤訊息是『…』」＋**原始壞掉的輸出全文**。這是唯一能看到 agent 實際吐了什麼的地方（`prompt_logs` 只存 prompt，不存 response）。
4. `docker logs --since ... odoo-v2 | grep NIGHTLY-FIX` 拿得到主進程的 console —— ⚠ 這推翻了 [[pipeline-errors-not-in-docker-log]] 的適用範圍：那條講的是 **subagent 子進程**的 console.error，`nightly-fix.js` 這種主進程的 log 進得了容器 log。

## 修法（`a6d552b6` 已 push，測試 4392→4396 零回歸）

- **`identityGroups()`（真正的根治）**：統整落空時每個候選各自成一組照跑。候選在入選時就有可執行的 title／detail／action／layer（意見走 `triageOne` 寫進 feedback，健檢提案本來就有），**這條退路不需要 AI**。合併從此只是省 token 的優化，不是必要前提。刻意不填 layer，讓 `normalizeGroups` 沿用成員的（避免同一道判斷抄兩遍）。
- **`MERGE_MAX_ATTEMPTS=2`**：解析失敗重跑**整支 merge**（換一顆骰子），而不是靠 haiku 補救。只重試解析失敗，CLI 執行失敗不重試（額度／環境問題，同分鐘重跑白燒）。
- **prompt 直接禁用**半形雙引號與換行，而不是教它逸出——要 LLM 在數 KB 中文裡逐個 `\"` 逸出，本身就是失敗來源。（`feedback-triage.md` 走的是教逸出那條路，兩支刻意不同。）

✅ **2026-09-08 當晚實跑通過**：8 候選→統整 7 組，merge 沒落空，`health_check_runs` 有該晚的 `nightly-fix` 列（id 28）。那晚仍「沒跑完」是另外兩個原因，見 [[nightly-fix-fuse-cache-read]]。

## 通則

**「不記帳」的容錯設計會製造靜默**。不把 agent 自己的失敗算在候選頭上是對的，但配上「早退」就等於整晚無痕。容錯的每一條退場路徑都要問一次：這條走完之後，畫面上看得出發生過什麼嗎？
