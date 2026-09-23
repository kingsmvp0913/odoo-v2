---
name: pgmem-is-null-update-poisoned
description: pg-mem 裡只要先跑過一次帶 `<欄位> IS NULL` 的 SELECT，之後同一條件的 UPDATE 就永遠影響 0 列——兩個 agent 各自重現一半、結論相反，是我自己實測才釐清的
metadata:
  node_type: memory
  type: reference
---

2026-09-18 實測（租戶隔離 Task 3，`tools/migrate-tenants.js`）。

**現象**：
```sql
UPDATE users SET company_id = $1 WHERE id = $2 AND company_id IS NULL
```
在 pg-mem 回 `rowCount = 0`、什麼都沒寫，**但不報錯**。真 PostgreSQL 正常。

**觸發條件（關鍵，也是兩份重現互相矛盾的原因）**：只有在**先跑過一次帶同一個 `IS NULL` 條件的 SELECT 之後**才會發作。單獨跑那句 UPDATE 完全正常。所以：
- 只測 UPDATE 的人會說「沒問題」
- 走完整流程（先 plan 再 apply）的人會說「壞掉」

兩邊都只重現了一半。實測四種寫法（同一個 schema、同一個真實順序）：

| 寫法 | 結果 |
|---|---|
| `AND company_id IS NULL` | ❌ rowCount 0 |
| `WHERE id IN (SELECT id FROM users WHERE id=$2 AND company_id IS NULL)` | ❌ rowCount 0（子查詢救不了） |
| `AND coalesce(company_id::text,'') = ''` | ✅ 正常，且防護仍有效 |
| `AND NOT (company_id IS NOT NULL)` | ✅ 正常，且防護仍有效 |

**How to apply**：撞到「UPDATE 靜默影響 0 列」先看前面有沒有跑過同條件的 `IS NULL` 查詢。**不要為了讓測試綠就把防護條件整條拿掉**——換等價寫法就好（上表後兩種都驗過，重跑時 rowCount 0、值不變＝防護真的在）。真 PG 裡 `coalesce(x::text,'')=''` 對 INTEGER 欄位等價於 `x IS NULL`。

**判讀教訓**：兩個 subagent 對同一個經驗事實給出相反結論時，不要挑一邊信、也不要再派第三個——自己寫一支涵蓋**完整呼叫順序**的探針，20 行就分得出來。各自的重現通常都對，只是覆蓋範圍不同。

相關：[[pgmem-like-bracket-charclass]]、[[pgmem-on-conflict-returning-lies]]、[[full-run-test-count-model]]
