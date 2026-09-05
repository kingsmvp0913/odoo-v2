// 讀官方成績圖，把「每一章錯幾題」抄出來。
//
// 原專案有一支 read-sections.js 做這件事，併進平台時沒搬過來——改成人工在歸檔
// 面板逐章打數字。但成績單本來就是一張圖，人再抄一次只是多一次出錯的機會，
// 而抄錯的後果是把錯的題永久鎖成正解（歸檔不可逆）。
//
// **這支只負責讀，不負責寫。** 讀出來的數字填回歸檔面板讓人看過再送出——
// 模型讀表格會看錯行，而歸檔是不可逆的，不能讓它直接落地。
const { runPrompt, MODEL } = require('./review');

function buildPrompt() {
  return `這是一張 Odoo 認證考試的**官方成績單**截圖，檔名 shot.jpg。先用 Read 打開它。

畫面上通常是一個表格或一組長條，每一列是一個章節（Sales、Inventory、Accounting…），
標示該章的題數與答對／答錯情形。有些版面只給百分比或只給長條圖。

**逐列抄出來，不要推算、不要補齊沒看到的章節。**

只輸出 JSON，不要任何其他文字：

{"readable": true, "sections": [
  {"title": "Sales", "total": 10, "correct": 9, "incorrect": 1}
]}

規則：
- title 照畫面上的英文原文抄，不要翻譯、不要改大小寫。
- total／correct／incorrect 都是**題數**，不是百分比。
  畫面只給百分比時：incorrect = round(total × 錯誤百分比)，但**只有在 total 看得到時**才這樣算；
  total 看不到就把這一列整個略過，不要猜。
- 三個數字對不起來時（correct + incorrect ≠ total）照抄你看到的，不要自己調整——
  那通常代表有未作答的題，由後續步驟處理。
- 完全讀不出表格（圖太糊、根本不是成績單）回 {"readable": false, "note": "為什麼"}。
- 一列都讀不出來就回空陣列，**不要編**。`;
}

// 模型有時把數字回成字串或帶 %，有時把 title 前後帶空白。
// 這些都會讓下游「章節名對不上」而靜靜略過整章，症狀離真因很遠。
function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/[%％,]/g, '').trim().match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function normalizeSections(raw) {
  if (!raw || typeof raw !== 'object') return { readable: false, note: '模型沒有回 JSON', sections: [] };
  if (raw.readable === false) {
    return { readable: false, note: String(raw.note || '模型說讀不出來'), sections: [] };
  }
  const out = [];
  const skipped = [];
  for (const s of (Array.isArray(raw.sections) ? raw.sections : [])) {
    const title = String((s && s.title) || '').trim();
    const total = toInt(s && s.total);
    const incorrect = toInt(s && s.incorrect);
    const correct = toInt(s && s.correct);
    if (!title) { skipped.push('有一列沒有章節名'); continue; }
    // total 看不到就整列略過（prompt 也這樣要求）：沒有題數就換算不出錯題數，
    // 而編一個數字進去會被歸檔當成硬事實鎖題。
    if (total == null) { skipped.push(`${title}（讀不到題數）`); continue; }
    // incorrect 缺但 correct 有 → 補推；兩個都沒有就略過
    const inc = incorrect != null ? incorrect
      : (correct != null ? Math.max(0, total - correct) : null);
    if (inc == null) { skipped.push(`${title}（讀不到答錯題數）`); continue; }
    if (inc < 0 || inc > total) { skipped.push(`${title}（錯 ${inc} 題但總共只有 ${total} 題）`); continue; }
    out.push({ title, total, incorrect: inc, correct: correct != null ? correct : total - inc });
  }
  return { readable: true, sections: out, skipped };
}

/**
 * 讀一張官方成績圖。
 * @returns {Promise<{readable:boolean, sections:Array, skipped:string[], note?:string}>}
 */
async function readSections({ imagePath, onProgress, model = MODEL }) {
  const out = await runPrompt({ prompt: buildPrompt(), imagePath, onProgress, model });
  return normalizeSections(out.raw);
}

/**
 * 把讀到的章節對上這一場考試實際有的章節。
 *
 * ⚠ 原專案的教訓（設計文件 §13.4）：一個都對不上時要**報錯**，不能靜靜寫空的
 * sections 然後一路「成功」到底——那張圖的 token 白燒，而症狀（題庫裡沒有官方
 * 結果）離真因非常遠。所以這裡把對不上的具名回報，而且完全沒對上時明講。
 *
 * @param {Array} read  readSections 的結果
 * @param {Array} pages 歸檔面板的頁（{page, section, answered, total}）
 */
function matchToPages(read, pages) {
  const norm = t => String(t || '').trim().toLowerCase();
  const byTitle = new Map();
  for (const s of read) byTitle.set(norm(s.title), s);

  const filled = [];
  const unmatchedPages = [];
  const usedTitles = new Set();
  for (const p of (pages || [])) {
    const hit = byTitle.get(norm(p.section));
    if (!hit) { if (p.section) unmatchedPages.push(p.section); continue; }
    usedTitles.add(norm(hit.title));
    // 成績圖的題數與這一場實際作答的題數可能不同（有未作答的題）。
    // 錯題數不能超過有作答的題數，超過就填不進去——具名回報讓人自己看圖判斷。
    filled.push({
      page: p.page,
      section: p.section,
      wrong: hit.incorrect,
      overflow: hit.incorrect > p.answered,
    });
  }
  const unusedTitles = read.map(s => s.title).filter(s => !usedTitles.has(norm(s)));
  return { filled, unmatchedPages, unusedTitles };
}

module.exports = { readSections, normalizeSections, matchToPages, buildPrompt, toInt };
