---
name: asset-301-loop-from-missing-filestore
description: filestore 缺檔會讓 Odoo asset bundle 變成「301 重導到自己」的無限迴圈；websocket worker bundle 中招＝使用者體感的「測試區一直斷線」，修法是刪掉壞掉的 bundle attachment 讓它重生
metadata: 
  node_type: memory
  type: project
  originSessionId: 7ab22be1-9545-4dc5-a5ee-04471c4163da
---

2026-08-25 萊峰19（`test_odoo19_raifong`）：使用者回報前端 `AssetsLoadingError`（`web_tour.interactive.min.js`
載入失敗）＋「測試區一直斷線」。**兩個症狀同一根因**＝filestore 實體檔遺失，見 [[raifong19-filestore-loss]]。

## 故障鏈（Odoo 19 實測，碼在 `addons/base/models/assetsbundle.py` `get_attachments`）

1. `ir_attachment` 的 asset bundle 記錄還在，但 `store_fname` 指的檔案沒了。
2. 請求帶 website 前綴的 URL（`/web/assets/1/<hash>/x.min.js`，`1` 是 website_id，路由在
   `website/controllers/binary.py`）→ 找不到對應 attachment → 走「從相似 attachment 複製」：
   log 會出現 `Found a similar attachment for ... copying from ...`。
3. 來源檔已遺失，`_file_read` 對缺檔只印 traceback 並回空 bytes（**不拋錯**）→ 複製出一筆
   `store_fname`／`file_size` 皆 null 的**空殼**。
4. 空殼讓 `web/controllers/binary.py` 的版本比對成立 → `request.redirect(bundle.get_link())`
   → **Location 與請求 URL 完全相同**＝無限重導 → 瀏覽器放棄 → `AssetsLoadingError`。

## 判讀陷阱：Odoo log 裡查無那支 asset 的請求

因為它從沒被真正送達過（瀏覽器在重導迴圈裡就放棄了）。「log 沒有＝沒被請求」會把人推去查 nginx／CDN。
**直接 `curl -D -` 打內部埠看 Location** 才會現形：Location == 請求 URL 就是這個病。

## 「一直斷線」＝ websocket worker bundle 也中招

`bus.websocket_worker_assets` 壞掉時 `GET /bus/websocket_worker_bundle` 先回 **500**、複製出空殼後轉為 301 迴圈。
worker 起不來 ⇒ bus 永遠連不上 ⇒ 前端持續顯示斷線，**重整無效**（平台 chat 當時就是叫使用者重整）。
查斷線先 `docker logs <env容器> | grep websocket_worker_bundle`，看到 500／301 就是這條，不是網路問題。

## 修法：刪掉壞掉的 bundle attachment，Odoo 會自己重編

asset bundle 是純衍生快取（可由原始碼重編），刪除無資料損失。判定「壞掉」的兩個條件：
`store_fname` 指向的檔案不存在，或 `store_fname` 與 `db_datas` 皆 null 而版本 hash 不是空內容 hash。

⚠ `cf83e13...` 開頭的版本 hash 是**空 bundle 的正常值**（該 bundle 本來就沒內容），不要當壞檔刪。

刪完打一次 `/web/bundle/<name>` 取回真實 src 再打該 src，log 出現
`Generating a new asset bundle attachment` ＋回 200 才算數。

## 那道防呆擋不住這種情況

`7cf7f48` 加的「DB 已存在但 filestore 是空的 → 中止建置」只認**完全空**。本次 filestore 有 82 個檔
（asset 自己重生出來的），不算空 ⇒ 部分遺失是這道防呆的盲區，環境照樣起得來、平台顯示一切正常。
