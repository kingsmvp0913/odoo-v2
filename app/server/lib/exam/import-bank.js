// 把舊的檔案式題庫（questions.json + section-results.json）匯入 DB。
//
// 核心是「同一題不建第二列」：以 (odoo_version, fingerprint) 去重，命中就 seen_count++。
// 沒有這件事，第二次考同一題會建成新的一列，累積的證據散在兩列上，永遠湊不出 100%。
const { fingerprint } = require('./fingerprint');

// 答案在舊資料裡有兩種形狀：字串 'B' 與陣列 ['B','D']。一律壓成陣列。
// 空值必須回 null 而不是空陣列——空陣列在 DB 裡是「有答案但沒內容」，
// 和「沒有答案」是不同的意思，而下游的信心度會據此分岔。
function toArr(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr.map(x => String(x).trim().toUpperCase()).filter(Boolean);
  return out.length ? out : null;
}

async function importBank(db, { label, odooVersion, questions, sections, takenAt = null }) {
  const bank = await db.query(
    `INSERT INTO exam_banks (label, odoo_version, status, taken_at)
     VALUES ($1, $2, 'ready', $3) RETURNING id`,
    [label, odooVersion, takenAt]
  );
  const bankId = bank.rows[0].id;

  const stat = { bankId, items: 0, merged: 0, attempts: 0, verdicts: 0, sections: 0, skipped: [] };

  for (const q of (questions?.questions || [])) {
    let fp;
    try {
      fp = fingerprint(q.question);
    } catch {
      // 讀不出題幹的題跳過但要具名回報。靜靜丟掉的話題數對不上，
      // 而使用者只會看到「題庫少了幾題」，離真因很遠。
      stat.skipped.push(`P${q.page}-${q.no}（題幹空白）`);
      continue;
    }

    const official = toArr(q.official);

    // 為什麼是「先 SELECT 再分岔」而不是 ON CONFLICT DO NOTHING RETURNING：
    //
    // 實測（2026-09-04）pg-mem 對 `ON CONFLICT (…) DO NOTHING RETURNING id` 在
    // **真衝突時仍回 1 列**（它沒有插入重複列，總列數是對的，但 RETURNING 騙人）。
    // 用 rows.length 判斷「新增 vs 合併」的話，測試環境永遠走新增分支，
    // seen_count 永遠不累加——而正式 Postgres 下同一份程式碼是對的。
    //
    // 這種「測試紅、正式對」的落差最危險：開發者會為了讓測試變綠而改壞正確的碼。
    // 先 SELECT 兩邊行為一致，代價只是多一次查詢。
    //
    // 併發安全性：匯入是單執行緒批次，不是併發路徑；UNIQUE 約束仍在，
    // 真的撞到會拋錯而不是靜靜寫壞。
    const hit = await db.query(
      `SELECT id FROM exam_items WHERE odoo_version = $1 AND fingerprint = $2`,
      [odooVersion, fp]
    );

    let itemId;
    if (!hit.rows.length) {
      const ins = await db.query(
        `INSERT INTO exam_items
           (odoo_version, fingerprint, question_en, question_zh, options, qtype,
            section_title, answer_official, official_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [odooVersion, fp, q.question, q.question_zh || null,
         JSON.stringify(q.options || []), q.type === 'multi' ? 'multi' : 'single',
         q.pageTitle || null, official, official ? (q.officialFrom || 'manual') : null]
      );
      itemId = ins.rows[0].id;
      stat.items++;
    } else {
      // 已存在：合併。seen_count++，並在本次有官方答案而舊列沒有時補上。
      // COALESCE 的方向是刻意的——舊列已有的官方答案不被本次覆蓋，
      // 因為官方確認是硬事實，不該被後來一次沒有官方回饋的考試洗掉。
      itemId = hit.rows[0].id;
      await db.query(
        `UPDATE exam_items
            SET seen_count = seen_count + 1,
                answer_official = COALESCE(answer_official, $2),
                official_from = COALESCE(official_from, $3),
                updated_at = NOW()
          WHERE id = $1`,
        [itemId, official, official ? (q.officialFrom || 'manual') : null]
      );
      stat.merged++;
    }

    const att = await db.query(
      `INSERT INTO exam_attempts (item_id, bank_id, page, no, answer_their, answer_final, responder)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [itemId, bankId, String(q.page ?? ''), q.no ?? null,
       toArr(q.their), toArr(q.final), q.responder || null]
    );
    stat.attempts++;

    // 舊的兩輪盲判保留：新流程不再產生它們，但它是唯一能對照
    // 「舊盲判 vs 新對立審查」誰更準的基準資料。
    for (const [key, kind] of [['round1', 'blind_r1'], ['round2', 'blind_r2']]) {
      const r = q[key];
      if (!r || !toArr(r.answer)) continue;
      await db.query(
        `INSERT INTO exam_verdicts
           (item_id, attempt_id, kind, refuted, correct_answer, confidence, reason, model)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,'legacy')`,
        [itemId, att.rows[0].id, kind, toArr(r.answer),
         Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null, r.reason || null]
      );
      stat.verdicts++;
    }
  }

  for (const s of Object.values(sections?.sections || {})) {
    if (!s?.title) continue;
    await db.query(
      `INSERT INTO exam_sections (bank_id, title, n, correct, incorrect, unanswered, partial)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (bank_id, title) DO NOTHING`,
      [bankId, s.title, s.n || 0, s.correct || 0, s.incorrect || 0,
       s.unanswered || 0, s.partial || 0]
    );
    stat.sections++;
  }

  return stat;
}

module.exports = { importBank };
