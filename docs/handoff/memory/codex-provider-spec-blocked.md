---
name: codex-provider-spec-blocked
description: 根目錄 CODEX-PROVIDER-SPEC.md（pipeline agent 可選 AI 供應商）未實作；**「這台裝不了 codex」是錯的、08-12 已裝好 0.147.0**，真阻礙只剩 OpenAI 憑證；含 §9 七題已實測到的四題答案
metadata: 
  node_type: memory
  type: project
  originSessionId: ca582294-9e8a-4694-975c-4027d636c586
---

`CODEX-PROVIDER-SPEC.md`（已進版控，根目錄）＝讓 24 支 pipeline agent 各自選 Claude Code 或 OpenAI Codex 執行。2026-08-08 評估結論：**規格品質高，但現在開不了工。**

**未實作已確認**：`agent-runner.js`／`codex-runner.js` 不存在；`agent-loader.js:26` 仍是一維 `ALLOWED_MODELS`；`AdminAgents.js:10` 仍硬寫清單；目標分支 `claude/codex-workflow-integration-jeer01` 不存在。

**Why（三個硬阻斷）**：
1. §9 的 7 個未決事項全部要實跑 `codex exec` 才有答案，而規格自己寫「不得靠猜」。沒答案就寫不出來的是核心：`codex-runner.js` 的事件解析（§3.2 對照表一半標「待確認」）、`PROVIDERS.codex.models` 白名單、`auth-signature.js` 的 codex 認證失敗 pattern。
2. ~~這台裝不了 codex~~ ← **✗ 這條是錯的，2026-08-12 推翻**。當時只驗到「`npm root -g` 是 root 擁有的 `/usr/lib/node_modules`、無 sudo」，就推論成「裝不了」——但 **npm 全域安裝根本不需要 root**：`npm config set prefix /home/odoo/.npm-global` 後 `npm i -g @openai/codex` 3 秒裝完（已裝，`codex-cli 0.147.0`，binary 在 `/home/odoo/.npm-global/bin/codex`）。
   **教訓**：「權限不足以走預設路徑」≠「做不到」。[[container-no-root-no-apt]] 講的是 apt／系統目錄，不要外推到所有安裝行為。
   **真正剩下的阻礙只有一個：OpenAI 認證憑證**（`codex login status` → `Not logged in`、無 `OPENAI_API_KEY`），在使用者手上。
3. 規格 §8 自己寫明「端到端無法在開發容器驗證」，§6.3 六項驗收全要在平台主機跑。

**§9 七題：2026-08-12 無憑證實測已答掉四題**（`codex-cli 0.147.0`）：
- **`codex exec` 參數順序**：`codex exec [OPTIONS] [PROMPT]`；有 `-m/--model`、`-C/--cd <DIR>`（指定工作根目錄）、`-o/--output-last-message <FILE>`、`-i/--image`、`-c key=value`（覆寫 config.toml）。子指令 `resume`／`review`。
- **`--sandbox` 與 `--yolo` 是否互斥**：**問題本身就過時**——這版沒有 `--yolo`，對應旗標是 `--dangerously-bypass-approvals-and-sandbox`（另有 `--dangerously-bypass-hook-trust`）。
- **`--json`**：存在，語意是 `Print events to stdout as JSONL`。已觀察到的 event type：`thread.started`（帶 `thread_id`，resume 要用）、`turn.started`、`item.completed`（`item.type` 可為 `error`）、`error`、`turn.failed`。**完整 item type 清單仍需有憑證的成功執行才能收齊。**
- **認證失敗字面**（`auth-signature.js` 要的 pattern）：`401 Unauthorized: Missing bearer or basic authentication in header`，會先 websocket 重試 5 次、再 fallback HTTPS 重試 5 次（**約 25 秒**），最後 `{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer..."}}`，exit code **1**。⚠ 重試期間每次都吐 `{"type":"error"}` 事件——runner 不能一看到 `error` 事件就判定失敗，要等 `turn.failed`。

**兩個規格沒寫、會讓 runner 直接壞掉的坑**（實測踩到）：
- **非 git repo 目錄會直接拒跑**：`Not inside a trusted directory and --skip-git-repo-check was not specified`。pipeline 若在暫存目錄呼叫 codex 必爆。
- **stdin 沒關會卡住**：不給 `< /dev/null` 會停在 `Reading additional input from stdin...`。`claude-runner.js` 現有的 spawn 方式要確認有處理。

**仍需憑證才能答的三題**：model 識別字白名單／是否回報 resolved model id／sandbox 是否擋 workspace 外**讀取**（第 6 題單獨決定批次三 qa 能不能上）。

**How to apply**：
- **唯一關鍵路徑已縮短成一件事：拿到 OpenAI 憑證**（`codex login` 或 `OPENAI_API_KEY`），跑一次成功的 `codex exec --json` 收齊 item type 與 model id，剩下全是下游實作。
- **不要先做「不需要 codex 的半套」**（provider 資料模型、二維白名單、`/api/admin/providers`）。`PROVIDERS.codex.models` 填不出來 → 做完是「只有 Claude 一家、codex 下拉是空的」框架，驗不出對錯還多一層分派要維護。
- **錨點複驗（2026-08-08）**：抽查 12 處，`agent-loader.js:26/251`、`AdminAgents.js:10`、`with-resume.js:13-14`、`agent-result.js:66`、`spec-review.js:66`、`clarify-chat.js:131`、`db.js:539`、24 支 agent 全部準確。**兩處要修正**：
  - §4.4 說改 `health-data.js:17-21` 的單價 CASE — **該段已不存在**，寫規格後被重構抽成 `app/server/lib/token-cost.js` 的 `costSql()`，`health-data.js` 與 `token-report-routes.js` 共用。修法方向不變但只需改一處。
  - §2.1 的「呼叫端共 19 處」要重數：grep `runClaude` 命中 22 個檔（含註解提及），需逐一分辨。
- 規格點出的坑我複驗後認同，最狠的是 §5.4 約束二的 `analysis-project → playwright-spec` 跨關卡 session 配對：名字看不出關聯，加上 `writeSpecTour`（`task-agent.js:367`）刻意 best-effort 靜默吞錯，破掉只剩「tour 沒產出」這個無指向性症狀。規格要求 `updateAgent()` 硬校驗而非文件提醒，是對的。
