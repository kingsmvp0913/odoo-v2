# 主題 F：Agent 契約強化 — 設計文件

日期：2026-07-08
狀態：已核准
健檢對應：報告第六節 F 批次（解析失敗零重試、貪婪 regex、裸 YAML、model 配置）＋相關 P2/P3 發現。

## 背景與目標

F 是一叢約 11 個「agent 輸出契約」發現。報告核心洞察：**統一輸出契約格式（標記、剝除、重試一次）比逐個修划算**。
最貴的失敗模式是「agent 已花完數十萬 token、只因收尾格式抖動就整輪 stopped＋人工介入」，直打三目標中的穩定與省 token（省 token 主戰場＝失敗迴圈）。

**已完成、剔除本輪範圍**（探查確認）：
- qa.md 已用 `git diff {{main_branch}}...{{git_branch}}` placeholder（root cause A 已修）。
- coding-retry.md 已明示「接續上一輪、只改失敗相關、不動已通過」（主題 B 已做增量修正指示）。

**核准決策**：
- 輸出契約統一改用 Claude 訓練過的 XML 閉合標籤 `<result>...</result>`（取代自訂 `---RESULT-JSON---`／`---END-RESULT---`）。
- coding 重跑升級目標＝opus。
- CLAUDE.md 祖先載入衝突：維持現狀，不搬 worktree 位置（搬遷動到主題 C 剛改的 worktree 生命週期、風險大；commit 衝突因 agent prompt 更具體、實際影響低）。

## 元件

### F-core：統一 `<result>` 契約＋健壯解析＋重試一次（旗艦）

新增模組 `app/server/pipeline/agent-result.js`：

```
extractResult(text) → string|null
  1. 剝除首尾 ``` code fence（含 ```json / ```yaml）。
  2. 取最後一組 <result>…</result> 之間內容（lastIndexOf('<result>')；無閉合標籤則取 <result> 之後到結尾）。
  3. 回傳內層 trim 後字串；找不到 <result> 回 null。

parseAgentResult(raw, { parse, model, signal }) → Promise<any|null>
  1. const inner = extractResult(raw); 若 inner 有值試 parse(inner)，成功即回。
  2. 失敗 → haiku 補救一次：runClaude(REPAIR_PROMPT(raw), { model:'haiku', signal }) →
     對回傳再跑 extractResult + parse。
  3. 仍失敗回 null（呼叫端 stopped）。
  parse 由呼叫端注入：JSON.parse（多數）或 yaml.load（analysis-basic）。
```

REPAIR_PROMPT：固定短 prompt，指示「以下是某 agent 的輸出，只回傳其中的結果資料，包在 `<result></result>` 內，不要任何其他文字」＋ raw。

**契約遷移（md）**：
- 5 支既有 envelope agent：`analysis-project`／`coding-project`／`coding-retry`／`playwright`／`qa` 的 `---RESULT-JSON---`…`---END-RESULT---` → `<result>`…`</result>`。
- `cs`／`library`：輸出段改為包在 `<result>`（取代「回傳 JSON（不要其他文字）」的裸 JSON 弱約束）。
- `analysis-basic`：輸出仍是 YAML，但包在 `<result>`；分類欄位範例保留。

**解析點改用 parseAgentResult（retry-once 全面接上）**：
- `task-agent.js`（parseResult 呼叫點：analysis-project、coding）：改呼叫 parseAgentResult(raw, { parse: JSON.parse, signal })。
- `qa-agent.js`、`playwright-agent.js`：同上。
- `cs-agent.js`：取代貪婪 `/\{[\s\S]*\}/`。
- `library-agent.js`（3 處）：取代貪婪 regex。
- `analysis.js`（analysis-basic）：改用 parseAgentResult(raw, { parse: yaml.load, signal })，取代裸 `yaml.load`。
- **移除** task-agent 舊 `parseResult`；原 export 的 `parseResult`（qa/playwright 曾 import）由 `agent-result.js` 的 `parseAgentResult`/`extractResult` 取代，呼叫端一律改 import 新模組。

### F-failloud：失敗大聲、阻止靜默劣化

- `analysis-project.md`：補 confirm_pending 的**完整 `<result>` JSON 範例**（含 analysis_yaml 欄位與把問題放進 clarification_channel.questions 的指示），消除「只輸出 {"status":"confirm_pending"} → JS 判無效 stopped」。
- `task-agent.js` analysis 結果分派：未知 status → **stopped**（blocker 說明「分析輸出 status 非預期值」），不再預設放行成 branch_pending（Rule 12）。
- `library-agent.js`：parse 失敗 → 寫 task_logs 留痕（`[wiki 更新失敗] 無法解析 agent 輸出`），不再靜默跳過卻標 done。
- `agent-loader.js` `render()`：偵測未匹配的 `{{placeholder}}`（原 regex 替空字串），有漏傳時 `console.warn('[AGENT-RENDER] 未匹配 placeholder: ...')`。
- `agent-loader.js` `updateAgent()`：若新 prompt 相對舊版**刪除了 `<result>` 標記**、或**移除了舊有的某個 `{{placeholder}}`** → 拒絕更新並回明確錯誤（避免 UI 編輯改壞契約）。

### F-token

- `cs-agent.js`：wiki context 改為**只給頁面標題清單**（分類任務不需全文；取代目前 5 頁全文 join 無上限）。
- `cs.md`：`model: sonnet` → `model: haiku`（純三分類、制式輸出、每工單入口頻率最高）。

### F-escalate

- `task-agent.js` `runCodingOnce`：coding 因下游退回而重跑時（resume 路徑／reentry_count>0）將 model 覆寫為 **opus**；首輪（fresh）維持 agent 預設 sonnet。
- 機制：runClaude 已收 opts.model；在 runCodingOnce resume 分支傳 `model: 'opus'`（不改 agent md 的預設）。
- analysis 幾乎不重跑，不納入。

### F-prompt

- `coding-project.md` commit 段加一句：commit 前確認不含 `__pycache__/`、`*.pyc` 等 build 產物（必要時 `git rm --cached`）。
- CLAUDE.md 祖先載入衝突：維持現狀（見決策），本輪不動。

## 測試計畫（Rule 9 驗證意圖）

F-core `agent-result.js`：
1. extractResult 剝除 ```json fence 後正確取出 JSON。
2. extractResult 取「最後一組」`<result>`（前面有範例 `<result>` 也不誤取）。
3. parseAgentResult：首次 parse 成功不呼叫 haiku（runClaude 未被呼叫）。
4. parseAgentResult：首次失敗 → 呼叫 haiku 一次（model:'haiku'）→ 修復輸出可 parse → 回物件；haiku 也失敗 → 回 null。
5. YAML 路徑（analysis-basic）：`<result>` 包住的 YAML（含 fence）能 yaml.load。

F-failloud：
6. analysis 未知 status（如 'foo'）→ 任務 stopped，不進 branch_pending。
7. library parse 失敗 → task_logs 有留痕。
8. render 漏傳 placeholder → console.warn 被呼叫。
9. updateAgent 刪除 `<result>` 或既有 placeholder → 拒絕。

F-token：
10. cs prompt 的 wiki 段只含標題、不含頁面內文。

F-escalate：
11. coding resume 重跑 → runClaude 收到 model:'opus'；fresh 首輪 → 收到 sonnet。

回歸：所有既有 agent 測試改用 `<result>` 契約後仍通過（envelope 標記字串更新）。

## 範圍與非目標

- 不全面改寫 agent 輸入 prompt 成 `<instructions>/<context>/<task>` 結構（高風險、砸快取、且救不了輸出 parse 失敗——那是輸出端問題）。僅選擇性借用「範例優於形容詞」補弱約束（analysis-basic）。
- 不搬 worktree 位置、不動 CLAUDE.md（P3，影響低）。
- retry-once 用 haiku（最便宜）純做格式修復，不做語意重跑。
