---
name: wikiQuery
description: Use when reading a project's wiki knowledge base from an interactive session — listing pages, fetching page content, or checking troubleshooting conclusions (node_type='troubleshooting') and wiki-drift reports. Uses the local /ai/wiki endpoints on the platform server.
---

# wikiQuery — 查專案知識庫（wiki）

## Overview
每個專案有一套 wiki（概論／模組頁／功能頁／專案備註／疑難排解），存平台 DB 的 `wiki_pages`。互動 session 要查「這個專案某功能怎麼運作、之前排障結論是什麼」走這裡。**需要平台 server 運行於 `$AIDEV_AI_BASE`**；server 沒跑時改用 `platformDB` skill 直查 `wiki_pages` 表。

## 端點（loopback-only，免認證）

> **互動式 session 要先自己取通行碼與 base URL**（pipeline 派出去的 agent 由平台自動注入，你自己敲的沒有）。
> 在 repo 根目錄執行一次即可：
>
> ```bash
> export AIDEV_AI_TOKEN=$(node -e "process.env.APP_SECRET=require('./data/config.json').APP_SECRET;console.log(require('./app/server/lib/ai-token').aiToken())")
> export AIDEV_AI_BASE=$(node -e "console.log('http://localhost:'+(require('./data/config.json').PORT||3939))")
> ```
>
> 沒帶通行碼或帶錯會回 403 並在訊息裡說明是通行碼問題——不是資料庫或連線壞掉。
> **埠號一律照上面推導，不要寫死**：3939 只是原始碼預設值，本機實際跑的是 `data/config.json` 的 `PORT`。
> 兩者不符時 curl 是 connection refused（`HTTP_CODE:000`），server 側任何說明訊息都送不出來。

> **`project` 參數優先用 `folder_name`（純英數），不要用中文顯示名。** 未編碼的中文放進網址會被
> Node 的 HTTP parser 直接判 **400 Bad Request**——連 Express 都到不了，你只會看到請求失敗而
> 完全不指向網址問題。非用中文不可時務必先 URL 編碼（`鴻久` → `%E9%B4%BB%E4%B9%85`）。

```bash
# 1. 有關鍵字就先搜（比逐頁看標題可靠；回 slug/title/node_type/description，不回全文）
curl -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" "$AIDEV_AI_BASE/ai/wiki/search?project=<folder_name>&q=<關鍵字>"

# 2. 列頁面清單（slug/title/node_type/description）；project 參數＝projects.folder_name 或 name
curl -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" "$AIDEV_AI_BASE/ai/wiki/pages?project=<folder_name>"

# 3. 取單頁內容
curl -H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN" "$AIDEV_AI_BASE/ai/wiki/page?project=<folder_name>&slug=<slug>"
```

`description` 是一行摘要，用來判斷「該不該打開這一頁」——清單與搜尋結果都會回它，但 `content` 只有第 3 個端點才給。先看 description 再決定取哪頁，是這組端點省 token 的關鍵。

## node_type 判讀
| node_type | 內容 |
|---|---|
| `overview` | 專案概論（排最前） |
| `module-*`／功能頁 | library agent 從程式碼生成的正典文件 |
| `notes` | 專案備註（人工維護，pipeline 會注入 prompt） |
| `troubleshooting` | **排障結論**：chat／cs 釐清問題後經 `<memory>` 側通道留存;容器 slug=`troubleshooting`,條目 slug 一律 `ts-` 前綴。查「這問題以前遇過嗎」先看這區 |

## 漂移與修正的正確流向
- wiki 頁寫錯（頁錯、碼對）→ 回報進 `wiki_drift` 佇列,背景分類後由每小時 runner「從程式碼重生該頁」;**不要手改正典頁面內容去修錯**——手改會被下次重生蓋掉。
- 觀測漂移佇列與分類統計 → 用 `platformDB` skill(`wiki_drift` 表)。
- 頁面重生也可在專案 wiki 頁 UI 手動觸發(⟳)。

## Common Mistakes
- server 沒跑就 curl → connection refused;先確認或改走 `platformDB` 直查 `wiki_pages`。
- `project` 參數用了**未編碼的中文**顯示名 → **HTTP 400**（不是 0 頁，是請求本身不成立）。用 `folder_name`。
- `project` 參數用了顯示名但專案設了 `folder_name` → 兩者皆可,但拼錯回 0 頁不報錯;先用 `/ai/wiki/pages` 確認拿得到清單。
- 只看 `pages` 的標題挑頁 → wiki 一多就漏;有關鍵字一律先用 `/ai/wiki/search`。
- 直接編輯 library 生成的正典頁修正錯誤 → 會被重生蓋掉;錯誤要嘛走漂移回報,要嘛改程式碼註解讓重生正確。
