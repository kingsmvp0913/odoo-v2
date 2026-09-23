---
name: hungjou-deploy-topology
description: 鴻久那台的部署拓樸實查（odoo_dev 掛在 odoo-prd 容器不是 odoo-dev），與「log_container 才是唯一分辨得出來的線索」這條通則
metadata: 
  node_type: memory
  type: project
  originSessionId: b008939c-2575-42f2-8cbc-7cccd86be59a
  modified: 2026-09-10T03:28:46.207Z
---

2026-09-10 實跑探測（唯讀）查到的鴻久客戶機拓樸。**照容器名字推會推錯**。

## 那台的實際形狀（`arich@192.168.1.233`，7 個 odoo 容器）

| 容器 | 對外 port | conf 的 db 白名單 | addons 目錄 | 我們的模組 |
|---|---|---|---|---|
| `odoo-prd-web` | 8001 | `odoo_prd`, **`odoo_dev`** | `/Data/odoo-prd/addons` | 9 個 |
| `odoo-tst-web` | 8101 | `odoo_tst`, `hutest` | `/Data/odoo-tst/addons` | 9 個 |
| `odoo-dev-web` | 8201 | `odoo_dev` | `/Data/odoo-dev/addons` | 7 個（落後） |
| 另有 4 個 `*-runner` | — | 各一個 db | 沒掛我們的 addons | 0 |

**`odoo_dev`（鴻伍）是由 `odoo-prd` 容器服務的**，不是同名的 `odoo-dev`。
所以正式區的兩個資料庫共用一個容器、一個 addons 目錄。

## 唯一分辨得出來的線索

`db_connections.log_container`（systemd 專案是 `log_unit`）——那是人親手填的
「這個環境的 log 去哪個容器抓」。鴻久的「鴻伍 - 正式」(odoo_dev) 填的是 `odoo-prd-web`。

**這條線索在 2026-08-04 就存在，但探測從來沒拿來用**，於是第一次設定就把 target 3
存到了 `odoo-dev` 容器＋`/Data/odoo-dev/addons`。後果不是「部署失敗」而是更糟的：
碼傳進沒人讀的目錄、重啟沒人用的容器，而 `odoo_dev` 的模組版本**仍會被升上去**
⇒ 檔案舊、DB 新，Odoo 直接壞。已修（`e5cba21b`：有指名的排第一並標示）。

**通則：判斷「哪個 instance 服務哪個資料庫」不要看名字，看人已經填過的欄位。**

## 現況（`e5cba21b` 已 push）

- 3 個 target 都 `enabled=false`，使用者還沒啟用
- target 3 已由我改正（改指 odoo-prd／`/Data/odoo-prd/addons`／8001，並清掉 `last_deployed_sha`）
- 正式區分組實測 `[[2,3]]` ⇒ 上正式時兩個 DB 合成一次停機
- **部署本身一次都沒實跑**；探測已對鴻久實跑驗證

## 兩個實跑才發現的坑

1. **七個候選的 conf 全都沒寫 `http_port`**。docker 還能退回 `docker ps` 的 ports 去猜，
   **systemd（慈雲那台）沒有映射可猜** ⇒ `http_port` 是 null ⇒ `buildHealthCmd` 直接拋
   「http_port 不合法」。已補 8069 退路（那是 Odoo 的預設值，不是猜的）。
2. **`*-runner` 會混進候選**：`isDeployCandidate` 只排除 postgres/redis 那類 image，
   runner 的 image 是 odoo 所以留著。已加次要排序鍵（有沒有我們的模組）把它們壓下去。

## 慈雲（project 2）尚未驗

使用者指定接下來用慈雲測 systemd 路線。實查它的兩條連線（`production_test`／`ciyun`）
**`log_mode`／`log_container`／`log_unit` 全是 null** ⇒ 那條線索對它無效（不會壞，只是幫不上）。
它是不是也「一個 service 服務兩個 DB」還不知道，要 probe 才有答案。
