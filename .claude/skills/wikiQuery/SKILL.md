---
name: wikiQuery
description: Use when reading a project's wiki knowledge base from an interactive session — listing pages, fetching page content, or checking troubleshooting conclusions (node_type='troubleshooting') and wiki-drift reports. Uses the local /ai/wiki endpoints at localhost:3939.
---

# wikiQuery — 查專案知識庫（wiki）

## Overview
每個專案有一套 wiki（概論／模組頁／功能頁／專案備註／疑難排解），存平台 DB 的 `wiki_pages`。互動 session 要查「這個專案某功能怎麼運作、之前排障結論是什麼」走這裡。**需要平台 server 運行於 `http://localhost:3939`**；server 沒跑時改用 `platformDB` skill 直查 `wiki_pages` 表。

## 端點（loopback-only，免認證）

```bash
# 1. 列頁面清單（slug/title/node_type）；project 參數＝projects.folder_name 或 name
curl "http://localhost:3939/ai/wiki/pages?project=<專案名>"

# 2. 取單頁內容
curl "http://localhost:3939/ai/wiki/page?project=<專案名>&slug=<slug>"
```

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
- `project` 參數用了顯示名但專案設了 `folder_name` → 兩者皆可,但拼錯回 0 頁不報錯;先用 `/ai/wiki/pages` 確認拿得到清單。
- 直接編輯 library 生成的正典頁修正錯誤 → 會被重生蓋掉;錯誤要嘛走漂移回報,要嘛改程式碼註解讓重生正確。
