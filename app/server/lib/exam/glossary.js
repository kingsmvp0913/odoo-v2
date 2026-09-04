// Odoo 官方繁中術語表：從 data/odoo-core/<ver>/ 的 zh_TW.po 抽出來。
//
// 為什麼要有：翻譯時把「這題涉及的術語」的官方譯法塞進 prompt，模型翻出來就對得上
// 使用者實際看到的 Odoo 畫面。全表塞不進 prompt（Odoo 19 實測 32,814 條），只塞用得到的。
//
// 官方譯法是港台混用的（account 模組裡「賬」404 次、「帳」220 次，Journal Entry 譯
// 「日記賬記項」），**不得「修正」成台灣慣用語**——考試畫面上印的就是這些字。
const fs = require('fs');
const path = require('path');
const { parsePo, isTerm } = require('./po-parser');

// 掃一個 Odoo 版本目錄下所有模組的 zh_TW.po。
// addons/ 與 odoo/addons/ 兩處都要掃——框架自己的模組在後者。
function collectTerms(coreDir) {
  const terms = new Map();   // en -> Map(zh -> {count, modules:Set})
  const roots = [path.join(coreDir, 'addons'), path.join(coreDir, 'odoo', 'addons')];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const mod of fs.readdirSync(root)) {
      const po = path.join(root, mod, 'i18n', 'zh_TW.po');
      if (!fs.existsSync(po)) continue;
      let entries;
      try { entries = parsePo(fs.readFileSync(po, 'utf8')); } catch { continue; }
      for (const { msgid, msgstr } of entries) {
        if (!isTerm(msgid, msgstr)) continue;
        const en = msgid.trim(), zh = msgstr.trim();
        if (!terms.has(en)) terms.set(en, new Map());
        const byZh = terms.get(en);
        if (!byZh.has(zh)) byZh.set(zh, { count: 0, modules: new Set() });
        const slot = byZh.get(zh);
        slot.count++;
        slot.modules.add(mod);
      }
    }
  }

  // 一個英文對到多個中文時取出現次數最高的（實測有 473 條這種）。
  // 次數相同時取字典序最小，確保結果穩定——不穩定的話重跑會得到不同的表。
  const best = new Map();
  for (const [en, byZh] of terms) {
    let pick = null;
    for (const [zh, slot] of byZh) {
      if (!pick || slot.count > pick.hits || (slot.count === pick.hits && zh < pick.zh)) {
        pick = { zh, hits: slot.count, modules: slot.modules };
      }
    }
    best.set(en, pick);
  }
  return best;
}

// 回傳 upserted 而非 inserted：ON CONFLICT DO UPDATE … RETURNING 不管新增或更新
// 都回一列，取名 inserted 會讓人以為第二次跑該是 0，然後去追一個不存在的 bug。
async function syncGlossary(db, version, coreDir) {
  const terms = collectTerms(coreDir);
  let upserted = 0;
  for (const [en, { zh, hits, modules }] of terms) {
    await db.query(
      `INSERT INTO exam_glossary (odoo_version, term_en, term_zh, modules, hit_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (odoo_version, term_en, term_zh)
       DO UPDATE SET hit_count = EXCLUDED.hit_count, modules = EXCLUDED.modules`,
      [version, en, zh, [...modules], hits]
    );
    upserted++;
  }
  return { upserted };
}

// 單複數候選。實測踩過：查 "Delivery Order" 是 MISS，因為 po 裡是 "Delivery Orders"。
// 原字一律排第一，命中就不必再試其他形。
function variants(term) {
  const t = String(term == null ? '' : term).trim();
  if (!t) return [];
  const out = [t];
  if (/ies$/i.test(t)) out.push(t.replace(/ies$/i, 'y'));
  else if (/es$/i.test(t)) out.push(t.replace(/es$/i, ''), t.replace(/s$/i, ''));
  else if (/s$/i.test(t)) out.push(t.replace(/s$/i, ''));
  if (/y$/i.test(t)) out.push(t.replace(/y$/i, 'ies'));
  out.push(`${t}s`, `${t}es`);
  return [...new Set(out)];
}

// 從一段英文裡找出命中的術語。
//
// 作法是反過來的：不掃文字去猜哪些是術語（猜不準），而是把該版本的術語表拉出來，
// 看哪些出現在這段文字裡。Odoo 19 有 32,814 條，一次拉出來在記憶體比對即可，
// 逐條丟 SQL 會是 32,814 次查詢。
// 一頁最多塞這麼多術語進 prompt。實跑一頁時命中 75 個（多半是虛詞垃圾，
// 已由 isTerm 修掉），但即使全是真術語，塞幾十個也會稀釋掉真正關鍵的那幾個。
// 長的排前面，所以砍掉的是最短、最泛用、最不需要指定譯法的那些。
const MAX_GLOSSARY_HITS = 25;

async function lookupTerms(db, version, text, limit = MAX_GLOSSARY_HITS) {
  const hay = String(text == null ? '' : text);
  if (!hay.trim()) return [];
  const res = await db.query(
    `SELECT term_en, term_zh FROM exam_glossary WHERE odoo_version = $1`, [version]);

  const found = new Map();
  for (const row of res.rows) {
    for (const v of variants(row.term_en)) {
      // \b 邊界避免 "Order" 命中 "Orders" 裡的子字串而算成兩條
      const re = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(hay)) { found.set(row.term_en, { en: row.term_en, zh: row.term_zh }); break; }
    }
  }
  // 長的優先：把 "Sales Order" 排在 "Order" 前面，prompt 裡才不會被短的蓋掉
  return [...found.values()]
    .sort((a, b) => b.en.length - a.en.length)
    .slice(0, limit);
}

module.exports = { collectTerms, syncGlossary, lookupTerms, variants, MAX_GLOSSARY_HITS };
