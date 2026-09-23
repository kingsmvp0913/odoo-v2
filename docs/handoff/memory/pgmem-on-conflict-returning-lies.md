---
name: pgmem-on-conflict-returning-lies
description: pg-mem 的 ON CONFLICT DO NOTHING RETURNING 在真衝突時仍回一列，用 rows.length 判斷「新增 vs 已存在」的碼會在測試環境永遠走新增分支
metadata: 
  node_type: memory
  type: project
  originSessionId: e6eef38b-6ce5-4471-b4ea-8776dd19ee60
---

實測 2026-09-04（撰寫 exam 題庫匯入計畫時）：

```js
INSERT INTO t (a,b) VALUES ($1,$2) ON CONFLICT (a,b) DO NOTHING RETURNING id
```

pg-mem 在**真衝突**時 `rows.length === 1`（正式 Postgres 是 0）。它**沒有**插入重複列——總列數是對的、UNIQUE 也生效——只有 `RETURNING` 騙人。

**為什麼危險**：upsert 的標準寫法是 `if (res.rows.length) { 新增分支 } else { 合併分支 }`。pg-mem 下永遠走新增分支，於是 `seen_count++`、`COALESCE` 補欄位這類合併邏輯完全不執行。症狀是**測試紅、正式對**——開發者會為了讓測試變綠而改壞本來正確的程式碼。

**修法**：不要靠 `ON CONFLICT … RETURNING` 的列數分岔，改成先 `SELECT` 查存不存在再決定 INSERT 或 UPDATE。兩邊行為一致，代價是多一次查詢。批次匯入不是併發路徑，UNIQUE 約束仍在兜底。

**同一次實測確認 pg-mem 沒問題的**（不用繞路）：`TEXT[]` 參數與回傳、`JSONB` 預設值、`ON CONFLICT DO UPDATE`、`UPDATE … COALESCE … RETURNING`、`FK ON DELETE CASCADE`、`COUNT(*)::int`、純 INSERT 撞 UNIQUE 會拋錯。

另注意 `ON CONFLICT DO UPDATE … RETURNING` 在**正式 Postgres** 下不管新增或更新都回一列，所以拿它當「新增筆數」計數器是錯的——那是 upsert 筆數。命名成 `inserted` 會讓人去追一個不存在的 bug。

## 同一天撞到的另外兩個（同家族）

**`NULLIF` 不存在。** `COALESCE(NULLIF(col,''), $2)` 直接報 `function nullif(text,text) does not exist`。
修法不是改寫成 `CASE WHEN`，而是**把判斷搬回 JS**——SQL 保持最笨的 UPDATE，邏輯在 Node，
兩邊行為必然一致也比較好讀。

**相關子查詢（correlated subquery）不支援。** 子查詢引用外層欄位時報
`column "b.id" does not exist`：

```sql
SELECT b.id, (SELECT COUNT(*) FROM child a WHERE a.bank_id = b.id) AS n FROM parent b
```

正式 Postgres 完全合法。改成 `LEFT JOIN` + `GROUP BY` 兩邊都吃。
**症狀會偽裝成「測試卡住」**——我第一次跑時 240s timeout 沒有任何輸出，
誤判成 CPU 被背景的 claude 行程佔滿；換 `--detectOpenHandles` 才看到 6.9 秒就 FAIL 了。
**懷疑測試卡住時先確認它是不是根本在報錯**，跑一支已知會過的同類測試當對照組最快。

同家族：[[pgmem-like-bracket-charclass]]（LIKE 把 `[...]` 當字元類別）。判準一樣——**pg-mem 綠不代表正式對，正式對也不代表 pg-mem 綠**，遇到行為分歧優先改成兩邊一致的寫法，而不是在測試裡加特例。
