---
name: agentPrompt
description: Use when editing pipeline agent prompts (.Codex/agents/*.md), shared prompt fragments (source-routing.md / systematic-debugging.md / cs-capability.md), AGENTS.md injected sections, or agent-loader injection config — covers placeholder contracts, result-tag output contracts, memory/wiki-drift side channels, injection order, prompt-version/session-binding effects, and how to verify with jest.
---

# agentPrompt — pipeline prompt 維運守則

## Overview
`.Codex/agents/*.md` 是 17 個 pipeline agent 的 prompt。它們**不是普通文件**——每份都掛著機器契約（placeholder、輸出標籤、注入片段），改壞任何一個都是**靜默失敗**：解析不到 → 該關整輪報廢。改 prompt 前先讀本 skill；程式真相在 `app/server/pipeline/agent-loader.js`。

## 鐵則 1：`{{placeholder}}` 逐一原樣保留
- JS 端 `render(vars)` 會傳入對應資料；移除 placeholder＝資料沒地方放，新增 placeholder＝渲染成空字串（只留 console 告警，agent 拿到空洞 prompt 照跑——最難察覺的準確性殺手）。
- 管理 UI 走 `updateAgent()` 有防護（擋移除 placeholder／擋刪 `<result>`）；**直接改檔案沒有任何防護**，規則要自己遵守。
- 共用片段的 placeholder 一樣算數：`source-routing.md` 用 `{{repo_paths}}`/`{{main_branch}}`/`{{git_branch}}`；`cs-capability.md` 用 `{{project_name}}`/`{{repo_paths}}`。

## 鐵則 2：主輸出契約（`<result>` 標籤）
- **有 `<result>` 契約**（下游用 `agent-result.js` 解析，格式各異——analysis 是 YAML、多數是 JSON）：analysis-project、analysis-reject、chat-to-task、coding-project、cs、library、merge-explain、qa、qa-retry、reject-classifier、respec-patch、spec-review、wiki-drift-classifier、workflow-health。
- **沒有、也不得擅自加上**：`merge`（吐裸檔案內容）、`playwright`（吐說明文字）、`chat`（自然語言回覆）、`deploy-fix`。加了 `<result>` 會破壞該關解析。
- 改契約格式（欄位增減）必須同步改 JS 解析端與對應測試；只改措辭不用。

## 鐵則 3：側通道（`<memory>` / `<wiki-drift>`）
- 只有 chat／cs 有，定義在 `cs-capability.md`，由 `agent-result.extractTaggedBlock` 抽取。
- 設計不變量：**選用**（缺＝沒有，不是錯誤）、**解析失敗靜默略過**（不影響主回覆）、**不進使用者可見正文**（chat 顯示前會剝除）。改 chat/cs/cs-capability 時不得動搖這三點。
- 對應落地：`<memory>` → `troubleshooting.js` 寫 wiki 疑難排解區；`<wiki-drift>` → `wiki-drift.js` 入佇列背景分類。

## 注入架構（agent-loader.js 的十一張名單）
最終 prompt 由上而下：**AGENTS.md 規則 → plain-language → asking-well → 專案備註 → systematic-debugging
→ source-routing → cs-capability → spec-lookup → must-ask → figma → visual-values → questions-contract
→ agent body**。**這個順序不能隨手改**：片段之間有方位詞互相引用（visual-values 寫「理由見上方【figma】」、
cs-capability 寫「見下方【figma】」、各 body 寫「見上方【…】」），順序一動就指向錯的地方且零紅燈——
`agent-loader.test.js` 有一條測試專門釘住它。
靜態片段排前面、per-project 動態值排後面，是為了讓 prompt cache 前綴儘量長（rules/agent-prompt 99）。

| 片段 | 注入對象 | 備註 |
|---|---|---|
| AGENTS.md `full`（過濾 `<!-- platform-only -->` 後整份） | analysis-project、analysis-reject、coding-project、playwright-spec、spec-review | platform-only 段（Skills 清單等）不會進 pipeline |
| AGENTS.md `qa`（只 §1＋§2＋Rule 12） | qa | qa-retry 不注入（--resume 已含 fresh 輪規則） |
| `systematic-debugging.md` | analysis-reject、coding-project | 診斷／修復型關卡 |
| `source-routing.md` | analysis-project、coding-project、qa、qa-retry、analysis-reject、playwright-spec | 在客戶 worktree 內作業的關卡 |
| 專案備註（`project_notes` var） | 開發五關＋chat、chat-to-task、spec-review | 空備註不注入（保 cache 前綴） |
| `cs-capability.md` | chat、cs | **改一處兩關同時生效** |
| `plain-language.md` | analysis-project、analysis-reject、clarify-chat、spec-review、qa、merge-explain、merge-clarify、cs、chat、chat-to-task、library | 產「給人看的文字」的關 |
| `asking-well.md` | analysis-project、clarify-chat、analysis-reject、cs | 產「要使用者回答的問題」的關；spec-review／respec-patch 有自己的反問規則但不吃這片段 |
| `spec-lookup.md` | clarify-chat、spec-review、respec-patch | 對話中要查碼的關；`repo_paths` 為空時整段不注入 |
| `must-ask.md` | analysis-project、clarify-chat、respec-patch、spec-review | 「這三種一律要問」＝發問守則決策樹的剪枝底線。**2026-08-20 新增** |
| `figma-unavailable.md` | analysis-project、clarify-chat、respec-patch、spec-review、chat、cs | 共同核心；拿到細節後走哪個出口留在各 body。chat／cs 原本從 cs-capability 拿，已搬家。**2026-08-20 新增** |
| `visual-values.md` | spec-review、respec-patch | 只給「保護端」；產生端（analysis-project 看截圖量值）規則不同故不吃。**2026-08-20 新增** |
| `questions-contract.md` | analysis-project、clarify-chat、respec-patch | 輸出 `clarification_channel.questions` 的關。**2026-08-20 新增**，取代三份各自手抄（原已漂移）。clarify-chat-retry 刻意不吃（走 --resume，見下） |

## 改動的連鎖效應（promptVersion／session 綁定）
- `promptVersion()` 對「注入片段＋agent body」做 hash，供 session 綁定：**改 agent body、共用片段、或 AGENTS.md 被注入的段落 → 版本變 → 綁定的 resume session（qa-retry、coding resume）強制 fresh**。這是設計行為（讓新指令生效），但代價是掉 prompt cache；批次修改一次改完，別零星多次改。
- 只改 AGENTS.md 的 `<!-- platform-only -->` 段落**不會**變動 promptVersion，對 pipeline 零影響。
- frontmatter：`model` 只允許 haiku/sonnet/opus/fable；frontmatter 邊界只認「裸 `---` 行」，body 內的 `---XXX---` 標記安全。

## 改完怎麼驗
```bash
cd app && npx jest server/tests/agent-loader.test.js server/tests/agent-acceptance.test.js server/tests/chat-agent.test.js
cd app && npm test          # 全套（改共用片段／契約時跑這個）
```
pipeline 各關的行為測試都在 `app/server/tests/`；改哪個 agent 就找同名／相關 test 檔一併看。

## Common Mistakes
- 在 workflow-health 的 `suggested_prompt` 之外的地方改 prompt 卻忘了它的規則同樣適用——所有改動（人工或 UI）都受鐵則 1／2 約束。
- 幫 merge／playwright「補上」`<result>` 求一致 → 該關解析直接壞。
- 改 `cs-capability.md` 只想著 cs，忘了 chat 也吃同一份。
- 把共用規則同時注入首輪與 retry 關（`qa-retry`／`clarify-chat-retry`）→ retry 靠 `--resume` 繼承上一輪對話，
  重送等於重複佔 context（rules/agent-prompt 104）。retry 的 body 只該放「本輪新資訊＋輸出契約＋一句指回」，
  真要強調硬規則就寫成摘要指回，不要整段複製首輪 prompt。
- 為了「減少重複」就抽片段——**判準是「會不會漂移」，不是「重複幾次」**。`Think in English…保留英文術語`
  那句重複 5 份卻逐字相同、內容穩定，抽出來只是多一個檔要維護（2026-08-20 評估後刻意不抽）；反之
  figma／必問三種／視覺值各只重複 3~5 份，但每份措辭都已演化出差異，那才該抽。另注意抽片段
  **通常會讓渲染後的 prompt 變大**（片段是各份的聯集），收益是一致性不是省 token。
- 以為「body 裡把 placeholder 搬到最後」就能救 prompt cache——**注入了含動態值片段（source-routing／
  spec-lookup／cs-capability）的 agent，前綴早在那一層就斷了**，body 內部怎麼排都無效。只有純 body
  的關（workflow-health、health-summary、merge 系、library、分類器）搬動才有效益。
- 大改 coding-project 後奇怪任務全部 fresh 重跑——那是 promptVersion 換版的預期行為，不是 bug。
