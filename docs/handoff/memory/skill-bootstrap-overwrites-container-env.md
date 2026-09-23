---
name: skill-bootstrap-overwrites-container-env
description: 容器裡的 agent 說「平台服務沒起來」的真因——getSQL/getLog/wikiQuery 的 SKILL.md 教一段無條件 export，把平台注入的閘道位址蓋成 localhost
metadata: 
  node_type: memory
  type: project
  originSessionId: 187f9436-820d-40f7-b1c2-6185713f4c45
  modified: 2026-09-18T09:29:28.353Z
---

2026-09-18 實際事故（chat 136，專案 3 鴻久）。使用者問「資料庫備份怎麼備份的」，AI 答保留 **3 天**（讀 repo 的
`odoo_backup.py`），但 wiki 頁 `ts-backup-architecture-host-cron-and-native-screen` 寫的是 **14 份**。
追問時 AI 說「wiki 我這邊連不上，平台服務在這個環境沒有起來」——平台其實好好的。

**真因**：agent 有呼叫 `Skill wikiQuery`，然後照 SKILL.md 那段「互動式 session 先自己取通行碼與 base URL」
**無條件** `export AIDEV_AI_TOKEN=... ; export AIDEV_AI_BASE=http://localhost:$PORT`，
把平台注入的 `http://<gw>:8080` ＋每次執行通行證整組蓋掉。容器內沒人聽 localhost，
掃 3939/3000/8080/8069/5000/4000 全 `000`，於是改用程式碼答題。同樣的段落 `getSQL`／`getLog` 也有。

**為什麼查不到**：閘道只記 `ai-forward-error`（轉發失敗）。這種情況**連轉發都沒發生**，
gateway log 完全空白；`wiki_search_misses` 也只記 0 筆結果，沒查過就不留痕。
唯一的證據在 agent 自己的逐字稿：`data/agent-home/project-<id>/.claude/projects/<cwd-slug>/<uuid>.jsonl`
（mtime 對得上對話時間），裡面有每一個 tool_use。**下次「AI 說連不上」先看這個檔，不要先看 gateway log。**

**已修**：三支 SKILL.md 的 export 前面加 `[ -n "$AIDEV_AI_BASE" ] ||` 護欄＋一段說明，
並新增 `app/server/tests/mounted-skill-env.test.js`（掃 `SKILLS_BY_SCOPE` 的每支 skill）。
全跑 5497 passed／exit 0（基線 5488）。已 commit＋push `f7e518e7`。skill 是每次開容器現掛的 **不用重啟平台**，下一輪對話即生效。
**已實跑驗證**：09-18T09:33Z chat 137（修好後第一場）跑出 `TOKEN_SET=yes BASE=http://odoo-v2-gw:8080`
並取回 wiki hits，還主動指出 wiki 與程式碼不一致。修法有效。

**全面盤查（掃 642 份逐字稿，389 次執行過這段 export）**：容器開到 `all` 之後（09-18T01:15Z）踩到 8 次——
chat ×6、cs ×1（task 278）、respec ×1（task 281）。**task pipeline 的 worktree 逐字稿一次都沒有**。
8 次裡有 7 次 agent 自己下 `env | grep -i aidev` 看到變數本來就在、當場改用正確值救回來（各浪費 10~90 秒），
**只有 chat 136 沒想到查 env**，一路掃埠到宣告平台掛掉。所以這個坑不是必炸，是「agent 想不想得到查 env」的機率問題——
護欄補上之後不再賭機率。8 月～09-17 的失敗都是主機上跑的（`cd /home/odoo/odoo-v2` 在主機成立），與本條無關。

相關：[[ai-socket-silently-stolen]]（同樣是「AI 說連不上」但那次是 socket 被奪走，gateway log 有整排 ECONNREFUSED——
兩者的分辨點就是 gateway log 有沒有東西）、[[productize-saas-decision]]
