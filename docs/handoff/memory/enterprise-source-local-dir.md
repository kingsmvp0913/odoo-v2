---
name: enterprise-source-local-dir
description: 企業版「本地目錄」來源（cd977ff）✅ 已實裝在用：17／19 兩筆 clone_status=done，raifong 升級靠它查企業版碼；含「manifest version 不是 Odoo 版本」的坑
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c5b2f86-47ce-46e2-838e-5f88fd46e642
---

企業版來源（後台 `/admin/enterprise`）2026-07-29 寫完，2026-08-17 加了第二種來源型態
（commit `cd977ff`）：原本只能填 git URL，現在可選「本地目錄」——管理員自行把 addons 放進
`<repo根>/enterprise/<大版本>/`，平台不碰 git。動機是企業版整包數百 MB，推遠端既慢、又等於把
有授權的專有碼放進別人的機器。

## ✅ 2026-08-19 複驗：已實裝在用，不再是紙上綠燈
`enterprise_sources` **2 筆**（17／19），皆 `source_type=local`、`clone_status=done`、
`local_path=/home/odoo/odoo-v2/enterprise/{17,19}`，目錄實際有 588／758 個模組。
raifong 17→19 升級全程靠這兩條路徑判定「19 真的移除了 product.packaging 等四樣功能」，
等於已經實跑驗證過。
⚠ 本檔原本寫「表一直 0 筆、從沒人用過、所有判斷都只是紙上綠燈」——那是 08-17 當下的實況，
沒人回頭更新，於是 08-19 盤點待辦時被我當成未完成項目報給使用者。**否定式斷言引用前先查 DB**
（見 [[stale-memory-blocks-work]]）。

**踩得到的地雷**：
- `resolveEnterprisePath` 讀的是 DB 存的 `local_path`，`syncSource` 寫入時用當下的
  `ENTERPRISE_BASE_DIR`。**同步過之後才改那個 env，掛載會指向舊目錄**。用預設值就沒事，
  且預設值落在同構掛載（`/home/odoo/odoo-v2` 容器內外同路徑）內，對 sibling 容器是安全的。
- git 型態的認證只有 PAT（`buildGitEnv`，取「按下同步的那個 admin」的 `users.github_pat_enc`）。
  URL 白名單雖放行 `git@`／`ssh://`，但容器內沒配 deploy key，SSH 那條路徑零測試覆蓋。

**「檢查」只驗兩件事：web_enterprise 存在、檔案 other-readable。刻意不驗版本**——第一版曾拿
manifest 的 `version` 比對大版本，結果一整包正確的 Odoo 17 企業版被判成「版本是 1.0，與登記的
17 不符」。實測：Odoo 17 企業版 585 個模組的 version 全是 `1.0`／`1.1`，社群版核心 17 也一樣
（316 個 `1.0`）。**官方 addons 的 manifest version 是「模組自身版本」，series 前綴是 Odoo 載入時
才補上的**；寫成 `17.0.1.0` 的是第三方／自訂模組慣例，別把它當通則。企業版包裡也沒有
`odoo/release.py`（那屬 server 本體）。使用者裁決：版本以「放進哪個目錄」為準，平台不猜。
（順帶量到的：拿模組 `depends` 交叉比對 `data/odoo-core/<版本>/addons` 確實有鑑別力——17 缺 0、
18 缺 3、19 缺 7——但已裁決不做。）

**設計上刻意的取捨**（別當成 bug 修掉）：
- `repo_url` 是 `NOT NULL`，本地型態存**空字串**而非 NULL——`db.js` 的 migration 框架只有
  add-if-missing，沒有改約束的機制，不為此開第一個例外。
- 本地型態的「檢查」走同步回應（毫秒級檔案檢查），**不套用** git 型態那個 30 分鐘併發鎖與
  PAT 檢查。併發鎖是為「兩個 git clone 撞同一個目錄」存在的。

相關：[[vpn-sibling-mount-homomorphic]]（同構掛載為何是硬需求）、
[[kangyue-filestore-uid-mismatch]]（容器內 odoo 是別的 uid，權限檢查的由來）
