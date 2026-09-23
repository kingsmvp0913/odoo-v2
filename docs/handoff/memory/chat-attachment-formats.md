---
name: chat-attachment-formats
description: 對話附件從「只收圖」開放成收 PDF／Office／CSV 的做法與四個踩到的守衛；未重啟未實測
metadata: 
  node_type: memory
  type: project
  originSessionId: 2257bedf-7ce6-4a24-bbff-e739f8c09ee7
  modified: 2026-09-09T04:19:55.360Z
---

2026-09-09 把 chat 附件從 `image/*` 開放成也收 PDF／Excel／Word／PowerPoint／CSV／TXT／LOG／XML／JSON／PO，上限 10MB→25MB。全跑 4576→4597 全綠、零回歸。已 push（`7ad8fafc`，master）。**⚠ 尚未重啟 server、前端一次都沒開瀏覽器看過。**

**架構決定（會影響之後任何「再加一種格式」的改動）**
- 檔型清單是**兩份**：後端 `app/server/lib/attachments.js`（`CHAT_TEXT_MIMES`／`CHAT_BINARY_EXTS`／`CHAT_ACCEPT`／`CHAT_FILE_MAX`）與前端 `app/public/js/chat-file-types.js`（`window.CHAT_FILE_TYPES`）。`server/tests/chat-file-types.test.js` 用 `vm` 跑前端那支再比對兩邊。漂移的症狀是「檔案挑得到、送出被打回」，畫面只有一句泛用錯誤。
- **純文字類是唯一必須信副檔名的一類**（csv/txt/log/xml/json/po 沒有 magic bytes）。把關改成「內容確實是文字（無 NUL、控制字元 <5%）」＋副檔名決定 mime。**刻意不驗 UTF-8**——台灣客戶匯出的 CSV 常是 Big5，嚴格驗會全擋掉。
- `.xls`／`.doc` 檔頭完全相同（OLE2 `D0CF11E0A1B11AE1`），靠 buffer 裡的 UTF-16LE stream 名稱分辨（`Workbook`／`Book` → xls，`WordDocument` → doc）。已用真的 .xls 驗過，不只合成 buffer。
- `.xlsm` 的 magic bytes 就是 `.xlsx`，所以只出現在 accept 清單、不出現在驗證清單。
- 非圖片一律不 inline（下載端點的 `safeMimetype` 只放圖片），所以「信副檔名」不構成 XSS 風險。
- 前端 previews 陣列對非圖片存**空字串**，模板 key 因此從 `:key="url"` 改成 `:key="index"`（多個空字串會被 Vue 當同一個節點）。`loadAttachmentThumbs` 也改成只抓圖片——非圖片可以 25MB，一進對話全拉進記憶體只為畫一列檔名。

**AI 端**：agent 拿到的是路徑、自己 Read。Read 開不了 Office 二進位，所以 `chat-agent.js` 的 `ATTACHMENT_READ_HINTS` 依副檔名附讀法（openpyxl／python-docx／xlrd／zipfile），**只在真的有那種檔時才掛**。三個套件都已實測讀得出真檔。`.doc` 這台**沒有任何可用解析工具**（antiword／catdoc／libreoffice 全無），prompt 明講「讀不出來、不要猜、請使用者改存 .docx」——這是 fail loud，不是遺漏。
⚠ openpyxl／python-docx 原本只是 `graphifyy` 順帶拉進來的相依（在 `~/.local`），等於哪天 graphifyy 換相依就靜默失效。已在 `Dockerfile` 明確加一行裝 openpyxl／python-docx／xlrd。

**四個守衛的踩雷（都不是我猜的，是實際紅過）**
1. `frontend-ui-next.test.js` 要求 ui-next CSS **每個 selector 都以 `.ui-next` 開頭**。`button.ui-next-file-chip` 會紅，要寫成 `.ui-next-file-chip[type="button"]`。
2. `frontend-image-preview.test.js` 掃 `openImage(` 起算 400 字元不得含 `window.open`——**連註解裡的字面都算**。我在註解寫「用 <a download> 而不是 window.open(blobUrl)」就紅了。
3. 用 `src.indexOf('addNewChatFiles(files)')` 抓 handler 會**先撞到呼叫端**（`this.addNewChatFiles(files);`），錨點要帶 `' {'`。
4. 整檔掃「不得再有 `10 * 1024 * 1024`」會誤判：`UiNextApp.js` 裡還有意見回饋那條路，它刻意維持只收圖、10MB。要逐個 handler 切片檢查。

**沒動的**：意見回饋（`uploadChatImages` 維持只收圖）、任務附件（`uploadAttachmentFiles` 本來就無過濾，什麼都收）。對話轉任務的複製是 format-agnostic，不必改。

相關：[[upload-entry-points-map]]、[[ui-next-css-traps]]
