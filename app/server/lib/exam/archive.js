// 歸檔：把一場考試的官方章節結果，轉成永久的題庫知識。
//
// 官方成績只到章節層級，沒有逐題對錯。唯一邏輯上必然為真的推論是：
// **某章「沒有答錯的題」⇒ 那章你答的每一題都是正解。**
//
// 注意是「沒答錯」（incorrect = 0）而不是「全對」——舊題庫實測，POS 那章 3 題
// 答對 2、未答 1，incorrect 仍是 0，而它確實被標成 certain。11 個 incorrect=0
// 的章節共 49 題，扣掉 2 題未作答 = 47 題，與 DB 現況完全吻合。
//
// **推的是 answer_final（最終答案）不是 answer_their（輸入答案）。**
// 官方評分評的是真正提交上去的那個答案，而那是你們在作戰台上看完審查與投票後
// 拍板的最終答案。用輸入答案推會剛好相反：AI 說你答錯、你改成 B、官方說這章沒錯，
// 結果把改之前的 A 永久鎖成正解。
// answer_final 在 worker 建 attempt 時預設就等於 answer_their，所以沒動過的題
// 兩者相同；動過的才有差，而那正是最不能搞錯的那幾題。
//
// 未作答（answer_final 是 NULL）的題必須跳過：沒有答案就沒有東西可推，硬填等於
// 憑空捏造正解。而且要具名回報——靜靜少掉兩題，事後沒有任何線索看得出來。
const { recomputeConfidence } = require('./worker');

const clean = v => (v == null ? null : String(v).trim() || null);
const hasAnswer = a => Array.isArray(a) && a.length > 0;
const sameAnswer = (a, b) =>
  hasAnswer(a) && hasAnswer(b) && [...a].sort().join(',') === [...b].sort().join(',');

/**
 * 列出這場考試的每一頁：章節名、題數、已作答數、以及已經鎖成官方的題數。
 *
 * 以 page 為單位而不是 upload：一頁截圖＝一個章節（舊題庫 19 頁 19 章節零例外），
 * 而同一頁可能因重傳而有多筆 upload。
 */
async function listPages(db, bankId) {
  const rows = (await db.query(`
    SELECT a.page, a.no, a.answer_final, i.section_title, i.certain, i.official_from
      FROM exam_attempts a JOIN exam_items i ON i.id = a.item_id
     WHERE a.bank_id = $1 ORDER BY a.page::int NULLS LAST, a.no`, [bankId])).rows;

  const ups = (await db.query(
    `SELECT page, section_title FROM exam_uploads WHERE bank_id = $1 ORDER BY id`, [bankId])).rows;
  const bySectionOfUpload = new Map();
  for (const u of ups) if (clean(u.section_title)) bySectionOfUpload.set(String(u.page), u.section_title);

  const pages = new Map();
  for (const r of rows) {
    const page = String(r.page);
    if (!pages.has(page)) {
      pages.set(page, {
        page,
        // 題目上的章節優先（那是歸檔寫進去的定論），沒有才退回上傳時帶的
        section: clean(r.section_title) || bySectionOfUpload.get(page) || null,
        total: 0, answered: 0, locked: 0,
      });
    }
    const p = pages.get(page);
    p.total++;
    if (hasAnswer(r.answer_final)) p.answered++;
    if (r.certain || r.official_from) p.locked++;
  }
  return [...pages.values()];
}

/**
 * 歸檔。pages 是 [{ page, section, noWrong }]。
 *
 * noWrong 為 true 才推導正解；false 只是把章節名寫進去（章節名本身對題庫分組
 * 與後續校準有用，不該因為那章有錯就不記）。
 */
async function archiveBank(db, { bankId, pages = [] }) {
  const stat = { sections: 0, locked: 0, skipped: [], conflicts: [] };

  for (const p of pages) {
    const page = String(p.page);
    const section = clean(p.section);
    const noWrong = p.noWrong === true;

    if (noWrong && !section) {
      stat.skipped.push(`P${page} 勾了「沒答錯」但沒有章節名，略過`);
      continue;
    }

    const attempts = (await db.query(`
      SELECT a.id, a.no, a.item_id, a.answer_final, i.answer_official
        FROM exam_attempts a JOIN exam_items i ON i.id = a.item_id
       WHERE a.bank_id = $1 AND a.page = $2 ORDER BY a.no`, [bankId, page])).rows;
    if (!attempts.length) continue;

    if (section) {
      await db.query(
        `UPDATE exam_uploads SET section_title = $3, updated_at = NOW()
          WHERE bank_id = $1 AND page = $2`, [bankId, page, section]);
      // 章節寫在題目上才有用：題庫分組與 recomputeConfidence 讀的都是 exam_items。
      for (const a of attempts) {
        await db.query(
          `UPDATE exam_items SET section_title = $2, updated_at = NOW() WHERE id = $1`,
          [a.item_id, section]);
      }
    }

    if (!noWrong) continue;

    let answered = 0;
    for (const a of attempts) {
      if (!hasAnswer(a.answer_final)) {
        // 未作答：官方說「沒有答錯的」不包含它——沒答不算錯也不算對。
        stat.skipped.push(`P${page}-${a.no} 沒有最終答案，無法推導正解`);
        continue;
      }
      answered++;
      if (hasAnswer(a.answer_official) && !sameAnswer(a.answer_official, a.answer_final)) {
        // 官方答案打架：可能是上一場考試推出來的，也可能是這次勾錯章節。
        // 兩種都不該靜靜覆蓋掉，具名報出來讓人判。
        stat.conflicts.push(
          `P${page}-${a.no} 既有官方答案 ${a.answer_official.join('')} 與本次最終答案 ${a.answer_final.join('')} 不符，保留既有`);
      }
      // certain 取 OR、answer_official 用 COALESCE：任何一次考試確定過就永久確定，
      // 已有的官方答案不被後來的覆蓋（與 import-bank.js 同一套合併規則）。
      await db.query(`
        UPDATE exam_items
           SET answer_official = COALESCE(answer_official, $2),
               official_from = COALESCE(official_from, 'section-all-correct'),
               certain = TRUE,
               updated_at = NOW()
         WHERE id = $1`, [a.item_id, a.answer_final]);
      stat.locked++;
    }

    // 官方章節結果。這是信心度校準的唯一硬事實來源，只在勾了「沒答錯」時才寫得出來
    // ——沒勾的章節我們不知道錯幾題，寫個猜的數字比不寫更糟。
    const existing = (await db.query(
      `SELECT id FROM exam_sections WHERE bank_id = $1 AND title = $2`, [bankId, section])).rows;
    if (existing.length) {
      await db.query(
        `UPDATE exam_sections SET n=$2, correct=$3, incorrect=0, unanswered=$4, partial=0 WHERE id=$1`,
        [existing[0].id, attempts.length, answered, attempts.length - answered]);
    } else {
      await db.query(`
        INSERT INTO exam_sections (bank_id, title, n, correct, incorrect, unanswered, partial)
        VALUES ($1,$2,$3,$4,0,$5,0)`,
        [bankId, section, attempts.length, answered, attempts.length - answered]);
    }
    stat.sections++;
  }

  const bank = (await db.query(
    `SELECT id, label, odoo_version FROM exam_banks WHERE id = $1`, [bankId])).rows[0];
  if (bank) {
    const { notes } = await recomputeConfidence(db, bank);
    stat.notes = notes;
    await db.query(`UPDATE exam_banks SET status = 'ready' WHERE id = $1`, [bankId]);
  }
  return stat;
}

module.exports = { listPages, archiveBank };
