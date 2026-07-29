---
paths:
  - "app/server/db.js"
---

# 平台開發：DB schema

> 抽自 2026-07-29 的記憶整併。完整清單與來源見 `docs/rules-extraction-2026-07-29.md`。

40. **`db.js` 的 migration 是 add-if-missing 框架——改欄位的 DEFAULT 字面值對現有 DB 完全無效** — 現有 DB 早跑過 ALTER，欄位 DEFAULT 已凍結。要改預設行為必須從真正生效點下手（如建立時的 INSERT 寫死值）。
41. **沒有 drop column 機制，欄位停用只能「程式不再讀寫、欄位保留」** — 同時要移除其他地方對該欄位的回填邏輯，否則死欄位看起來還活著。
42. **所有時間戳欄位一律用 `TIMESTAMPTZ`** — 台灣時區下 `TIMESTAMP` 產生 8 小時落差，「閒置多久」這類比較直接誤判。
43. **新增布林旗標用「DEFAULT 安全值 + 只有一條路徑寫危險值」，避免回填** — 例：`users.approved BOOLEAN DEFAULT true`，唯一寫 `false` 的是 register endpoint。
44. **一次性資料正規化 migration 必須 idempotent，且不能用 `btrim`** — migrate 每次啟動都跑；pg-mem 不支援 btrim。舊樣板是 verbatim 寫入的，精確字面比對安全。
45. **`teams_settings` 是全域／團隊設定的家（`teams-routes.js`），`settings.js` 是 per-user** — 放錯層會做出 per-user 的全域閘門。注意 `teams-routes.js` 的 upsert 用 `$1..$20` 位置參數，插入或移除欄位需重編號，高風險。
46. **設定類數值用 `??` 取預設值，不要用 `||`** — `(interval || 60)` 會讓「設 0 停用」被預設值蓋掉，功能表面存在卻永遠關不掉。

