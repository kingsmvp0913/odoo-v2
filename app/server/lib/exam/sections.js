// 讀官方成績單，把「每一章錯幾題」算出來。
//
// 原專案有一支 read-sections.js 做這件事，併進平台時沒搬過來——改成人工在歸檔
// 面板逐章打數字。但成績單本來就是一張圖，人再抄一次只是多一次出錯的機會，
// 而抄錯的後果是把錯的題永久鎖成正解（歸檔不可逆）。
//
// ── 關鍵：成績單只有百分比，沒有題數 ────────────────────────────────
// 實際的成績單是一張長條圖（`各部分錶現`），每章四根長條：正確的／部分地／
// 不正確／未回答，**y 軸是百分比**。圖上完全看不到「這章幾題」。
//
// 所以題數不能從圖上讀，要用**我們自己 DB 裡的**——每章考幾題本來就是我們寫進去的。
//   錯題數 = round(這章題數 × 不正確%)
// 實測 2026-08-14 那張：19 章全部算得出來，與匯入時的標準答案逐章相同（錯題合計 15）。
// 四捨五入很寬容：Project 8 題 37.5%，模型讀成 37/38/40 都會得到 3。
//
// **這支只負責讀，不負責寫。** 算出來的數字填回歸檔面板讓人看過再送出——
// 模型讀長條圖會看錯欄，而歸檔是不可逆的。
const { runPrompt, MODEL } = require('./review');

function buildPrompt() {
  return `這是一張 Odoo 認證考試的**官方成績單**截圖，檔名 shot.jpg。先用 Read 打開它。

畫面是一張長條圖（標題通常是「各部分錶現」／"Performance by section"）。
x 軸是章節名稱（Introduction、Sales、CRM…），y 軸是**百分比**（0–100%）。
每個章節底下有幾根不同顏色的長條，圖例通常是四類：

  正確的 (correct) ／ 部分地 (partial) ／ 不正確 (incorrect) ／ 未回答 (unanswered)

**逐個章節讀出這四類各佔百分之幾。**沒有那根長條就是 0。

只輸出 JSON，不要任何其他文字：

{"readable": true, "sections": [
  {"title": "Sales", "correct": 90, "partial": 0, "incorrect": 10, "unanswered": 0}
]}

規則：
- title 照 x 軸上的英文原文抄，不要翻譯、不要改大小寫。
- 四個數字都是**百分比**（0–100 的整數），不是題數。圖上沒有題數，不要編。
- 讀不出精確值就照長條高度估到最接近的整數百分比——四個數字加起來應該接近 100。
- 某一章看不清楚就整章略過，不要猜。
- 完全讀不出這張圖（不是成績單、太糊）回 {"readable": false, "note": "為什麼"}。`;
}

// 模型有時把數字回成字串或帶 %，有時把 title 前後帶空白。
function toPct(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/[%％,]/g, '').trim().match(/-?\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : null;
}

// 四類加起來偏離 100 超過這個數，就當作模型讀錯了整章。
// 給 8 不給 0：長條圖只能目測，1/12 = 8.3% 這種值本來就會有一兩個百分點的誤差。
const SUM_TOLERANCE = 8;

function normalizeSections(raw) {
  if (!raw || typeof raw !== 'object') return { readable: false, note: '模型沒有回 JSON', sections: [] };
  if (raw.readable === false) {
    return { readable: false, note: String(raw.note || '模型說讀不出來'), sections: [] };
  }
  const out = [];
  const skipped = [];
  for (const s of (Array.isArray(raw.sections) ? raw.sections : [])) {
    const title = String((s && s.title) || '').trim();
    if (!title) { skipped.push('有一列沒有章節名'); continue; }
    const correct = toPct(s.correct) ?? 0;
    const partial = toPct(s.partial) ?? 0;
    const incorrect = toPct(s.incorrect) ?? 0;
    const unanswered = toPct(s.unanswered) ?? 0;
    if ([correct, partial, incorrect, unanswered].some(v => v < 0 || v > 100)) {
      skipped.push(`${title}（百分比超出 0–100）`); continue;
    }
    const sum = correct + partial + incorrect + unanswered;
    if (Math.abs(sum - 100) > SUM_TOLERANCE) {
      skipped.push(`${title}（四類加起來 ${sum}%，不是 100%，可能看錯欄）`); continue;
    }
    out.push({ title, correct, partial, incorrect, unanswered });
  }
  return { readable: true, sections: out, skipped };
}

async function readSections({ imagePath, onProgress, model = MODEL }) {
  const out = await runPrompt({ prompt: buildPrompt(), imagePath, onProgress, model });
  return normalizeSections(out.raw);
}

/**
 * 把讀到的百分比乘上「我們自己知道的題數」，算成錯題數。
 *
 * ⚠ 原專案的教訓（設計文件 §13.4）：一個都對不上時要**報錯**，不能靜靜寫空的
 * sections 然後一路「成功」到底——那張圖的 token 白燒，而症狀（題庫裡沒有官方
 * 結果）離真因非常遠。所以這裡把對不上的具名回報，呼叫端在全部落空時擋下來。
 *
 * @param {Array} read  readSections 的 sections
 * @param {Array} pages 歸檔面板的頁（{page, section, total, answered}）
 */
function matchToPages(read, pages) {
  const norm = t => String(t || '').trim().toLowerCase();
  const byTitle = new Map();
  for (const s of read) byTitle.set(norm(s.title), s);

  // 同一章拆成兩頁時，百分比沒辦法拆回去：官方說 Accounting 錯 33%，
  // 那 4 題可能是 P5 三題、P6 一題，也可能反過來。逐頁乘百分比會兩頁都算成 2，
  // 而錯的分配一旦搞錯，歸檔就會把不該鎖的題鎖起來。這種章節交給人自己填。
  const pageCount = new Map();
  for (const p of (pages || [])) {
    if (!p.section) continue;
    pageCount.set(norm(p.section), (pageCount.get(norm(p.section)) || 0) + 1);
  }

  const filled = [];
  const unmatchedPages = [];
  const skipped = [];
  const usedTitles = new Set();
  const warnedSplit = new Set();
  for (const p of (pages || [])) {
    const hit = byTitle.get(norm(p.section));
    if (!hit) { if (p.section) unmatchedPages.push(p.section); continue; }
    usedTitles.add(norm(hit.title));
    if (pageCount.get(norm(p.section)) > 1) {
      if (!warnedSplit.has(norm(p.section))) {
        skipped.push(`${p.section}（拆在 ${pageCount.get(norm(p.section))} 頁，百分比分不回去，請自己填）`);
        warnedSplit.add(norm(p.section));
      }
      continue;
    }
    // 「部分地」是複選題的部分給分，那一題既不算全對也不算全錯——
    // 硬歸到任何一邊都會讓歸檔鎖錯題。有部分分的章節交給人自己看圖填。
    if (hit.partial > 0) {
      skipped.push(`${p.section}（有 ${hit.partial}% 部分給分，無法判定對錯，請自己填）`);
      continue;
    }
    const wrong = Math.round(p.total * hit.incorrect / 100);
    filled.push({
      page: p.page,
      section: p.section,
      wrong,
      pct: hit.incorrect,
      overflow: wrong > p.answered,
    });
  }
  const unusedTitles = read.map(s => s.title).filter(s => !usedTitles.has(norm(s)));
  return { filled, unmatchedPages, unusedTitles, skipped };
}

module.exports = { readSections, normalizeSections, matchToPages, buildPrompt, toPct, SUM_TOLERANCE };
