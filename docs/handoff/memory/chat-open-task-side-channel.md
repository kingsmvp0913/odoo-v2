---
name: chat-open-task-side-channel
description: 對話 AI 用 <open-task> 側通道請前端打開「建立任務」視窗——第三條側通道的落地與兩個刻意取捨
metadata: 
  node_type: memory
  type: project
  originSessionId: 187f9436-820d-40f7-b1c2-6185713f4c45
  modified: 2026-09-18T10:00:35.371Z
---

2026-09-18 實作，已 push `de25c212`（**欠平台重啟**：動到 `app/server/**.js`）。

**起因**：使用者在對話裡說「建個任務改一下」，AI 回「這邊不能建任務，請你自己去開」。
真因兩層：它在容器裡碰不到瀏覽器；而且 chat prompt 從頭到尾沒提過輸入框旁那顆 ＋（建立任務）按鈕，
所以連「請你去按那顆」都講不出來。

**做法**：比照既有 `<memory>`／`<wiki-drift>` 加第三條側通道 `<open-task>`，內容是一行 JSON
`{"title":…,"content":…}`。`extractTaskDraftBlock` 放 `pipeline/chat-to-task.js`（與 `draftTaskFromChat` 同居），
`chat-agent.js` 剝掉後隨本輪回應交給前端，`ProjectChat.js`（**只動 ui-next**）在 `send()` 的 `request.then`
裡開窗預填。人確認後才真的建立，human-in-the-loop 不變。

**兩個刻意取捨（別當成漏做回頭「修」）**：
1. **草稿用 AI 這一輪自己寫的字，不回頭再叫一次 `draftTaskFromChat`。** 使用者剛在回覆裡讀到
   「標題叫 X」，視窗跳出來卻是另一份重寫的文字，會被當成系統出錯。使用者當面選的（甲案）。
2. **代價：這條路不帶對話裡的圖片**（挑圖只有 `draftTaskFromChat` 會做）。prompt 裡明寫「要帶圖請他改按 ＋」。

**契約變更**：`chatReply` 回傳從字串改成 `{ reply, taskDraft }`。呼叫端只有 `chat-routes.js`，
但 5 支測試取過回傳值，已一併改。路由回應的 `taskDraft` 在沒有草稿時**不帶這個欄位**（不是 null）。

**測試**：`chat-agent.test.js` ×3（剝除正文／壞 JSON 靜默略過／缺欄位視同沒有）、
`chat-routes.test.js` ×2（有草稿原樣回傳／沒草稿不帶欄位）。全跑 5502 passed／exit 0（動手前基線 5497）。

⚠ **未實跑**：沒開過真的一場對話驗證 AI 會吐這個標籤、視窗會跳出來。要等平台重啟。
⚠ 改了 `chat.md` body ⇒ `promptVersion` 換版 ⇒ 進行中的對話 resume 會變 fresh（設計行為，見 agentPrompt skill）。

相關：[[skill-bootstrap-overwrites-container-env]]（同一場對話挖出來的另一個問題）、
[[ui-next-production-cutover]]（09-16 起前端只動 ui-next）、[[platform-restart-kills-container]]（重啟要在主機做）
