---
name: odooGlossary
description: 查 Odoo 官方繁體中文術語表（從各版本 zh_TW.po 抽出，25,015 條）。要決定欄位標籤、選單名稱、按鈕文字的中文怎麼寫時使用，避免每個模組各翻各的。觸發：/odooGlossary
---

# odooGlossary — Odoo 官方繁中術語

## 這是什麼

Odoo 自己的 `zh_TW.po` 翻譯檔抽出來的 en→繁中對照，存在平台 DB 的 `exam_glossary`。
**它就是使用者在 Odoo 畫面上實際看到的字。**

寫 Odoo 模組時決定中文標籤，查這裡而不是自己想——自己翻的「送貨單」對不上畫面上的
「交貨單」，使用者會覺得系統前後不一致。

## 怎麼查

借 platformDB 的唯讀查詢工具（`psql` 不在 PATH）：

```bash
# 單一術語
node .claude/skills/platformDB/query.js \
  "SELECT term_en, term_zh, hit_count FROM exam_glossary
    WHERE odoo_version='19' AND term_en='Delivery Orders'"

# 模糊找（不確定官方用哪個詞）
node .claude/skills/platformDB/query.js \
  "SELECT term_en, term_zh, hit_count FROM exam_glossary
    WHERE odoo_version='19' AND term_en ILIKE '%order%'
    ORDER BY hit_count DESC LIMIT 20"

# 反查：知道中文想確認英文原文
node .claude/skills/platformDB/query.js \
  "SELECT term_en, term_zh FROM exam_glossary
    WHERE odoo_version='19' AND term_zh LIKE '%交貨%'"
```

## 三個一定要知道的坑

**1. 查不到先試單複數。** po 檔存的往往是複數形。`Delivery Order` 查無，
`Delivery Orders` → 交貨單。至少試 `s`／`es`／`ies` 的變化。

**2. 一個英文可能有多個中文（實測 473 條這種）。** 用 `hit_count` 最高的那個——
它代表最多模組採用的譯法。例：`Sales Order` → 銷售訂單(36) 與 銷售單(2)，取前者。

**3. 官方譯法是港台混用的，不要「修正」它。** `account` 模組裡「賬」出現 404 次、
「帳」220 次；`Journal Entry` 官方譯「日記**賬**記項」而不是台灣慣用的「日記帳」。
看起來不順眼，但**畫面上印的就是那個字**。改成台灣用語反而讓中文對不上系統。

## 沒有的東西

- **整句話沒有。** 表裡只有術語（≤60 字元、首字大寫、譯文含中文），
  `You cannot delete this record.` 這種整句翻譯被篩掉了。
- **虛詞沒有。** `the`／`can`／`in`／單字母都被排除——收進來只會塞爆查詢結果。
- **只有已抽取的版本。** 用 `SELECT DISTINCT odoo_version FROM exam_glossary` 看有哪些。
  要新增版本：先 `ensureOdooCoreSrc('<版本>')` 解出原始碼，再跑
  `node tools/exam-import.js` 或直接呼叫 `lib/exam/glossary.js` 的 `syncGlossary`。

## 資料從哪來

`data/odoo-core/<版本>/{addons,odoo/addons}/*/i18n/zh_TW.po`，由
`app/server/lib/exam/glossary.js` 的 `collectTerms()` 抽取。
Odoo 19 實測：409 個 po 檔 → 25,015 條。
