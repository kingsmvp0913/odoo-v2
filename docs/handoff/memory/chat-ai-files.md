---
name: chat-ai-files
description: 對話 AI 產出可下載檔案（chatFiles skill＋出貨箱收貨）；沙盒化後三道門全擋住，修法已 push 6221ecb1、映像已重建驗過，欠平台重啟
metadata: 
  node_type: memory
  type: project
  originSessionId: 3f2b6862-5126-4d5c-935b-a33e8f09bb3f
  modified: 2026-09-15T09:46:47.861Z
---

2026-09-15 做完「專案對話 AI 回覆帶下載檔」並 push 到 master（`bef45402`）。全跑 4931→4955 全綠。
**⚠ 未重啟 server、未重建容器、沒有用真的 AI 對話跑過一次**——只驗到：真 xlsx/docx/pdf/png/csv/sql 過得了收貨、SKILL 範例照抄跑得動。

**設計（使用者拍板過的）**
- AI 照 `.claude/skills/chatFiles/SKILL.md` 自己決定要不要做檔；路徑由 `chat.md` 的 `{{chat_files_dir}}` 給。
- 出貨箱 `uploads/chat_<id>/ai/`；回覆 INSERT 後 `lib/chat-ai-files.js` 收貨，搬進 `ai/msg_<訊息id>/` 並寫 `project_chat_attachments`（掛 AI 那則）。搬走是為了同名檔跨輪不蓋掉舊按鈕。
- 按鈕由程式偵測出現，不靠 AI 寫標記。前端零改碼（附件區塊本來就不分 role）。
- 封存／保留期限：使用者說「之後再來」，本期沒做。

**字型踩雷（實測，不是推論）**
- reportlab 內建 CID 字型 `MSung-Light` 不嵌入：文字抽得出來、畫面上中文空白。必須嵌 TrueType。
- Noto CJK `.ttc` 是 CFF，reportlab 嵌不進去 → PDF 用 `fonts-arphic-uming`（subfontIndex=2＝TW）。
- matplotlib 用 UMing 畫圖整片沒字 → 圖表用 `fonts-noto-cjk`。兩套都加進 Dockerfile。
- 容器現有 `~/.local/share/fonts/` 是手動放的、重建就消失；reportlab／matplotlib 目前是我 `pip --user` 現場裝的，同樣重建才會持久。

**2026-09-18：沙盒開關轉 `all`（當天 01:15）後這功能整組靜默失效**，chat 132 使用者要「在原圖上框起來說明」，
AI 只能回「出貨箱唯讀」。三道門各擋一半，缺任何一道都交不出檔：
1. `agent-mounts.js` 把 `uploads/chat_<id>` 整包唯讀掛進容器 → 連 mkdir 出貨箱都不行（`ai/` 從來沒被建過）。
2. `docker/agent/Dockerfile` 沒有 reportlab／matplotlib／pillow，也沒有中文字型（那些只裝在平台自己的映像）。
   容器是 `--read-only`，AI 也不能自己 pip install 補。
3. `SKILLS_BY_SCOPE.project` 沒有 chatFiles → AI 連「檔要怎麼做」都看不到。

**修法（已 push `6221ecb1`，全跑 5410→5414 綠）**
- 出貨箱改成自成一層 `chat_<id>/ai/outbox`，只有它掛可寫；已交付的 `msg_*`／`_stale_*` 留在上一層 `ai/` 唯讀
  → AI 改不掉舊回覆的下載檔。`chatAiDir`／`chatAiOutbox` 都吃可選的 root 參數，讓 agent-mounts 用注入的 uploadRoot。
- 掛載來源**必須平台先 mkdir**：交給 dockerd 自動建會是 root 擁有，容器以宿主 uid 跑就寫不進去。
- chatFiles skill 只掛給 profile 標了 `outbox: true` 的 agent（只有 `chat`）；`chat-to-task` 有對話附件但不該有。
- 映像補 `python3-reportlab python3-matplotlib python3-pil fonts-arphic-uming fonts-noto-cjk`。
  ⚠ matplotlib 會連帶拉整套 GCC（188 個套件／264MB，這台網路下載一小時，映像 652MB→1.68GB）。使用者裁決保留。

**字型：舊 SKILL 寫的名字是錯的（實測推翻）**
- matplotlib 讀 `.ttc` 只認得第一個 face，Noto CJK 在容器裡註冊成 **`Noto Sans CJK JP`**，不是 `TC`。
  名字對不上會**靜默**退回 DejaVu、中文整片空白。實測 `Noto Sans CJK JP` 與 `AR PL UMing CN` 兩個都畫得出中文
  ——「不要加 AR PL UMing，matplotlib 用它畫會整片沒字」那句舊結論是名字打錯（`TW` vs `CN`）造成的誤判。
- PDF 仍只能用 uming：reportlab 只嵌得進 TrueType 輪廓。驗法是 grep PDF 裡有沒有 `/FontFile2`＋`BaseFont`
  出現 `AAAAAA+UMingTW-2`；**文字抽得出來不算數**（內建 CID 字型抽得出字但畫面空白）。
- 三項都在新映像內實跑並目視確認：中文長條圖、UMingTW 嵌入的 PDF、PIL 紅框＋中文標註。

**還沒做**：平台 server 未重啟 → 修法尚未生效，使用者要在主機重啟。映像已是新的（`aidev-agent:2.1.267` 已覆蓋）。
Codex provider 的沙盒能不能寫出貨箱沒驗證。

**踩雷**：`docker run -v /tmp/claude-*/...` 掛不進去（dockerd 看不到那個 /tmp，會建成空目錄）——
驗證腳本要放在 repo 底下這種 dockerd 看得到的路徑。

相關：[[chat-attachment-formats]]、[[platform-restart-kills-container]]、[[vpn-sibling-mount-homomorphic]]、[[shared-index-race-on-commit]]
