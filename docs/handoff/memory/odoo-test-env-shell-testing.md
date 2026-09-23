---
name: odoo-test-env-shell-testing
description: 專案測試環境可以直接進 docker 跑 odoo shell 做 ORM 實測（含連線參數、繞過權限檢查的招、rollback 保證不留痕）
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2a06828a-78df-4057-9560-9750db78a3b5
---

**平台的專案測試環境是活的 docker 容器，可以進去跑 `odoo shell` 做真正的 ORM 實測**——不要再說「這裡跑不動 Odoo」。我在 2026-08-25 因為只看了 `odoo-envs/<folder>/` 目錄（那只是 filestore 掛載點，看起來空空的）就斷言環境不存在，差點讓四張任務全部靠讀碼放行。

## 連線方式

容器名 `odoo-test-<folder_name>`，狀態查 `odoo_envs` 表（`status='running'`）。**連線參數不能省，而且 db_port 不是 5432**——用 `docker exec ... ps -eo args | grep odoo` 看主進程實際帶的參數抄過來。鴻久的例子：

```bash
docker exec -i odoo-test-odoo17_hungjou bash -lc \
  'odoo shell -d test_odoo17_hungjou --db_host=$HOST --db_port=$PORT --db_user=$USER \
   --db_password=$PASSWORD --addons-path=/mnt/extra-addons/_platform,/mnt/extra-addons/main,/usr/lib/python3/dist-packages/odoo/addons \
   --no-http --log-level=warn 2>&1' < script.py
```

- `HOST/PORT/USER/PASSWORD` 是容器內既有的環境變數（Odoo docker image 慣例＝**db** 連線參數，`PORT=8772` 是 postgres 不是 http）。直接 `odoo shell` 不帶參數會去找 `/var/run/postgresql/.s.PGSQL.5432` 然後失敗。
- `--addons-path` 必須帶，否則 registry 載不了 idx_* 模組。
- 腳本從 stdin 餵，最後一行寫 `env.cr.rollback()`＝**測完不留任何資料**（實測驗證過 `product.template` 仍為 0）。

## 造測試資料會撞到的門

測試環境通常是空的（連 product.template 都 0 筆），要自己造。會依序撞到：

1. **群組檢查**：`idx.partner.product`／`idx.maintenance`／`idx.repair` 的 `create()` 各自 `has_group` 擋人，OdooBot(uid=1) 不在那些群組裡。逐個 `env.user.write({'groups_id': [(4, env.ref('idx_hj.group_xxx').id)]})`。**不要一次加光**——有互斥約束（「金額可視可改」vs「金額可視不可改」）會擋。鴻久需要的是 `group_sync_smerp`、`group_maintenance_create`、`group_repair_create`、`group_*_price_can_edit`。
2. **SM 同步檢查**：帶 `with_context(no_sync_sm=True)`（但擋群組那層 context 沒用，要真的加群組）。
3. **必填的隱藏 m2o**：`maintenance_name`／`repair_name` 是指向 `idx.slip` 的 m2o 不是字串；`idx.product.warehouse` 需要 `idx_warehouse_id`，而 `idx.warehouse` 需要 `code`。用 `[n for n,f in env[m]._fields.items() if f.required and not f.compute]` 加 `f.type`/`f.comodel_name` 一次查清楚。
4. **硬編碼 id**：`bom_type.id in (2,4)` 是寫死的，空表要 `INSERT INTO idx_bom_class (id,...) VALUES (2,...) ON CONFLICT DO NOTHING`。

## 兩個可複用的驗證手法（2026-08-27 實戰）

**1. 驗 `@api.depends` 有沒有生效，不要比對「值有沒有變」**——值可能剛好相同而讓你誤判通過。
直接問 ORM「這個欄位有沒有被標記待重算」：

```python
f = env['sale.order.line']._fields['invoice_status']
env.invalidate_all()
line.write({'price_unit': line.price_unit + 100})
print(line in env.records_to_compute(f))          # True＝依賴鏈通了
print(sorted(env.registry.field_depends[f]))      # 實際生效的合併後 depends
```
⚠ **一定要配一個對照組**，否則 `True` 可能只是「任何 write 都會標記」的假象。挑一個**已知未宣告**該依賴的
欄位跑同一個 write，看它是不是 `False`（實測：write `price_unit` 時 `idx_packaging_id` 為 False、
`invoice_status` 為 True，測法才算有鑑別力）。
`field_depends` 會印出**合併後**的清單，父子同名 compute 的依賴會重複出現（`'state','state'`）——
這順便證實了「Odoo 對同名 compute 的 depends 是合併不是取代」。

**2. 用 `unittest.mock.patch.object` 在同一組資料上直接對照兩種修法**——不必改碼、不必部署，
可以實測「另一個方案會不會炸」：

```python
from unittest.mock import patch
Model = type(env['project.project'])
orig = Model._get_profitability_sale_order_items_domain
def patched(self, domain=None):
    return orig(self, domain) & Domain([...])
with patch.object(Model, '_get_profitability_sale_order_items_domain', patched):
    print(p._get_profitability_items(False)['revenues']['total'])
```
實戰結果：正確修法算出 0、被我攔下的修法算出 800000，**當場證明那個方案會讓 80 萬漏算回來**。
比任何讀碼論證都有力，而且成本只有一次 shell。

**3. 測 onchange 要用 client 的入口**，不要只看 `new()` 後的欄位值。`new()` 上的 One2many（帶 domain 的
那種）對 NewId 反查不成立，會全是 0 筆，看起來像壞掉其實不是。要判斷「畫面會不會即時更新」，
呼叫 `Model.onchange(values, field_names, fields_spec)` 看**回傳的 value 含哪些欄位**——
沒回傳的欄位，瀏覽器就不會更新。存檔後的真實結果則用 `_convert_to_write(so._cache)` 餵給 `create()` 驗。

## 為什麼一定要做

同一組資料上跑「舊順序」當對照組，是唯一能證明「根因判斷正確且修法有效」的方法。讀碼只能推導。另外**既有資料庫的狀態讀碼永遠看不到**——`noupdate=1` 的 data 檔被刪掉的記錄仍留在既有環境，diff 全對但線上多一列孤兒，只有連進去 `search([])` 才會發現。

相關：[[hungjou-183-187-review-2026-08-25]]、[[stale-memory-blocks-work]]
