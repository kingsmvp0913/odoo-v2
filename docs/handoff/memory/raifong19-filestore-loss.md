---
name: raifong19-filestore-loss
description: 萊峰19 測試區 634 個附件實體檔被「刪除環境」砍掉（平台不 drop DB 所以記錄還在）；19 的資料由 17 遷移、store_fname 相同，可從 raifong(17) 的 filestore 撈回，還剩 344 個
metadata: 
  node_type: memory
  type: project
  originSessionId: 96c1bc6f-f44b-49a5-83d1-2716a147d3f8
---

2026-08-24 萊峰19（project 11、DB `test_odoo19_raifong`）一天內壞兩次，第二次是**平台自己造成的**：
「刪除環境」會 `removeDirForce` 整個環境目錄（含 filestore），但全 repo 沒有任何 `DROP DATABASE`
（`grep -rn "dropdb\|DROP DATABASE" app/server` = 0 筆）→ DB 必然留著，於是 662 筆 `ir_attachment`
裡有 634 筆指向不存在的檔案：asset bundle 與所有圖片 500，而 DB 資料看起來完好、完全指不向真因。
修法已 push（見 [[session-2026-08-24-pending]]），**08-25 11:19 重啟後已生效**：`DELETE .../env` 改走
`removeEnvDir`（`ENV_DIR_KEEP=['filestore']`）。⚠ 專案**硬刪除**（`DELETE /api/projects/:id`）仍走
`removeDirForce` 整棵刪，那是刻意的，但平台從不 `DROP DATABASE` ⇒ DB 留成孤兒，同名 folder 重建時會被防呆擋下。

已遺失的檔案救不回——除了下面這條路。缺檔造成的**前端症狀與判讀**另見 [[asset-301-loop-from-missing-filestore]]。

## 可以從 17 撈回：19 的資料是從 17 遷移的

`store_fname` 就是檔案內容的 sha1，兩邊相同 ⇒ 內容必然相同。實測 501 個缺檔中 **359 個在
`odoo-envs/raifong/filestore/test_raifong/` 裡還在**（其餘 142 個是 19 自己產的 asset bundle，會自動重生）。

手法（平台身分寫不進那些目錄，要借 root 容器）：

```bash
docker run --rm -v <17的filestore>:/src:ro -v <19的filestore>:/dst alpine:3 \
  sh -c 'for f in <路徑清單>; do mkdir -p /dst/$(dirname $f); cp /src/$f /dst/$f; done'
```

複製後**逐檔 `sha1sum` 比對檔名**（0 不符才算數），再 `chown` 成該 image 的 odoo uid。
⚠ **uid 依 image 而異，先 `docker exec <容器> id odoo` 查**——19 是 100、17 是 101，
我照 17 抄成 101 結果打壞既有檔案，見 [[kangyue-filestore-uid-mismatch]]。

**2026-08-25 已全數補完**：344 個在 08-25 補回（filestore 82 → 426 檔），抽驗 sha1／檔案大小／PNG 檔頭
皆相符，先前報 FileNotFoundError 的頭像回 200。**仍缺 98 個，17 也沒有 ⇒ 救不回來**。

補檔實作（比記憶原本寫的 `docker run alpine` 更省事）：宿主 `tar -T <清單>` 打包 → `docker cp` 進該環境容器
→ 容器內 `-u 0` 解檔 `--skip-old-files` → `chown -R odoo:odoo`。**宿主身分寫不進去**（目錄 owner postgres、755），
別浪費時間試 `cp`。宿主 `ls` 看到的 owner 名字（messagebus／postgres）只是 uid 在宿主的映射，不代表容器內錯。

## 兩個判讀陷阱（都差點誤判）

1. **`docker logs --since` 不帶時區會被當成本地時間**（主機 UTC+8）。我用 `--since 2026-08-24T07:39:00`
   撈到整份 log、看起來像「修完還在錯」，加上 `Z` 之後才是真的（0 筆）。
2. **HTTP 200 ＋ sha1 相符 ≠ 圖是對的**。15 個選單圖示全部 200、sha1 全對，但把圖抓下來用眼睛看，
   內容本來就是 Odoo 的灰色佔位圖——使用者看到的「全部預設圖」根本不是快取問題。
   同 [[baseline-selfcheck-green-is-not-correct]]：機器驗證通過只證明「和自己一致」。
