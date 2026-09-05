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
const { applyDeduction } = require('./deduce');

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

// 官方成績圖上那一欄「這章錯幾題」。留白／非數字＝這章不處理。
// 回 null 而不是 0：「不知道」與「0 題錯」是完全不同的兩件事，前者不該鎖任何題。
function wrongCount(v) {
  if (v == null || v === '' || v === false) return null;
  if (v === true) return 0;               // 舊介面的「沒答錯」勾選＝錯 0 題
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * 歸檔。pages 是 [{ page, section, wrong }]，wrong ＝官方說這章錯幾題。
 *
 * - `wrong` 留白 → 這章不處理（只寫章節名）
 * - `wrong === 0` → 那章你答的每一題都是正解，永久鎖定
 * - `wrong > 0`  → **不鎖任何題**（不知道錯的是哪一題），但把錯題數寫進 exam_sections
 *
 * 最後一條是「答錯的經驗」唯一的落地點。沒有它，`exam_sections.incorrect` 在網頁
 * 流程下恆為 0，信心度校準（把整章風險總和拉回官方講的錯題數）就永遠拿不到輸入，
 * 那個設計等於不存在。
 */
async function archiveBank(db, { bankId, pages = [] }) {
  const stat = { sections: 0, locked: 0, skipped: [], conflicts: [] };

  for (const p of pages) {
    const page = String(p.page);
    const section = clean(p.section);
    // noWrong 是舊欄位名，留著讓既有呼叫端不會靜默失效
    const wrong = wrongCount(p.wrong != null ? p.wrong : p.noWrong);

    if (wrong != null && !section) {
      stat.skipped.push(`P${page} 填了錯題數但沒有章節名，略過`);
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

    if (wrong == null) continue;

    let answered = 0;
    for (const a of attempts) {
      if (!hasAnswer(a.answer_final)) {
        // 未作答：官方說「沒有答錯的」不包含它——沒答不算錯也不算對。
        if (wrong === 0) stat.skipped.push(`P${page}-${a.no} 沒有最終答案，無法推導正解`);
        continue;
      }
      answered++;
      // 這章有答錯的題：不知道是哪一題，所以一題都不能鎖。錯題數寫進 exam_sections
      // 讓校準去分配風險——那是「答錯」這件事唯一能用的形式。
      if (wrong > 0) continue;
      if (hasAnswer(a.answer_official) && !sameAnswer(a.answer_official, a.answer_final)) {
        // 官方答案打架：可能是上一場考試推出來的，也可能是這次勾錯章節。
        // 兩種都不該靜靜覆蓋掉，具名報出來讓人判。
        stat.conflicts.push(
          `P${page}-${a.no} 既有官方答案 ${a.answer_official.join('')} 與本次最終答案 ${a.answer_final.join('')} 不符，保留既有`);
      }
      // certain 取 OR、answer_official 用 COALESCE：任何一次考試確定過就永久確定，
      // 已有的官方答案不被後來的覆蓋（與 import-bank.js 同一套合併規則）。
      //
      // history_wrong 一併清掉，而且**只清這一題**：官方正解已知之後，「上次那個
      // 答案大概率錯」這個人工提醒就沒有意義了，留著會讓考試當下同時看到一個
      // 官方鎖定與一個紅叉警告，互相矛盾。
      // 不可以寫成 `WHERE history_wrong` 之類的全表更新——那會連別題人工標的
      // 一起掃掉，而且沒有任何稽核紀錄救得回來（實測踩過，一次清掉 11 筆）。
      await db.query(`
        UPDATE exam_items
           SET answer_official = COALESCE(answer_official, $2),
               official_from = COALESCE(official_from, 'section-all-correct'),
               certain = TRUE,
               history_wrong = FALSE,
               updated_at = NOW()
         WHERE id = $1`, [a.item_id, a.answer_final]);
      stat.locked++;
    }

    // 官方章節結果。這是信心度校準唯一的硬事實來源。
    // 錯題數不能超過有作答的題數——超過就是勾錯章節或看錯成績圖，寧可不寫也不要
    // 寫一個會讓整章校準亂掉的數字（scale = incorrect/rawRisk 會把信心度壓成負的再夾回 0）。
    if (wrong > answered) {
      stat.skipped.push(`P${page} 官方說錯 ${wrong} 題，但這章只有 ${answered} 題有作答，未寫入`);
      continue;
    }
    const existing = (await db.query(
      `SELECT id FROM exam_sections WHERE bank_id = $1 AND title = $2`, [bankId, section])).rows;
    if (existing.length) {
      await db.query(
        `UPDATE exam_sections SET n=$2, correct=$3, incorrect=$4, unanswered=$5, partial=0 WHERE id=$1`,
        [existing[0].id, attempts.length, answered - wrong, wrong, attempts.length - answered]);
    } else {
      await db.query(`
        INSERT INTO exam_sections (bank_id, title, n, correct, incorrect, unanswered, partial)
        VALUES ($1,$2,$3,$4,$5,$6,0)`,
        [bankId, section, attempts.length, answered - wrong, wrong, attempts.length - answered]);
    }
    stat.sections++;
  }

  const bank = (await db.query(
    `SELECT id, label, odoo_version FROM exam_banks WHERE id = $1`, [bankId])).rows[0];
  if (bank) {
    // 推導要排在重算信心度**之前**：它可能推出新的官方答案，而那會讓那些題的
    // 信心度變成 100。順序反了的話畫面上要等到下一次歸檔才會更新。
    //
    // 這一步做的是上面那段做不到的事：上面只處理「這章 0 題錯」，推導則把各場
    // 考試的錯題數湊成聯立方程式，解得出「第一場錯的那一題到底是哪一題」。
    const d = await applyDeduction(db, bank.odoo_version);
    stat.deduced = { locked: d.locked, marked: d.marked };
    // 矛盾一定要浮到畫面上。推導在矛盾時什麼都不寫（見 deduce.js），
    // 靜靜跳過的話使用者只會覺得「推導沒作用」，而真因是他成績單抄錯了一格。
    if (d.contradictions.length) stat.conflicts.push(...d.contradictions);

    const { notes } = await recomputeConfidence(db, bank);
    stat.notes = notes;
    // 標 archived 而不是 ready：這是「這一場結束了」的唯一訊號。
    // 上傳端靠它決定截圖要進哪一場——沒有進行中的考試就自動開一場新的，
    // 所以使用者完全不必管「開考試」這件事（2026-09-05 使用者拍板）。
    await db.query(`UPDATE exam_banks SET status = 'archived' WHERE id = $1`, [bankId]);
  }
  return stat;
}

module.exports = { listPages, archiveBank };
