// 從「這章錯幾題」推出「哪一題錯」。
//
// 官方成績只到章節層級。但同一題會跨考次重複出現，而每一場的每一章都是一條
// 方程式——湊在一起就解得出個別題目。這是**證明**，不是機率。
//
// ── 一個事實是什麼 ──────────────────────────────────────────────────
// 事實的單位是 **(題目, 你填的答案)**，不是「題目」。
// 同一題你上次填 C、這次填 A，那是兩件要分別判定的事——把它當成同一件會讓
// 「改過答案」的題整批推錯。
//
// ── 演算法 ──────────────────────────────────────────────────────────
// 對每一條「某場考試的某一章」：這章有作答的 n 個事實裡，恰好 k 個是錯的。
//   還沒判定的 = 全部 − 已知對 − 已知錯
//   還剩幾個錯 = k − 已知錯的個數
//   剩 0 個錯          → 還沒判定的全部是對的
//   剩的個數 == 未判定  → 還沒判定的全部是錯的
// 反覆跑到沒有新結論為止（constraint propagation）。
//
// 現行系統只用了 k=0 那一種（archive.js 的「這章沒答錯 → 全部鎖成正解」），
// 其餘三種同樣是證明，但一直沒人用。
//
// ── 為什麼要偵測矛盾 ────────────────────────────────────────────────
// 成績單抄錯一個數字、或章節名改過導致題目被算進別章，都會讓方程式無解。
// 無解時**必須停下來具名回報**——硬推下去會把錯的答案鎖成正解，而歸檔不可逆。

// 事實的鍵。答案排序後 join：['A','B'] 與 ['B','A'] 是同一個答案。
function factKey(itemId, answer) {
  const a = Array.isArray(answer) ? [...answer].map(String).sort().join(',') : String(answer || '');
  return `${itemId}|${a}`;
}

/**
 * @param {Array} constraints [{ key, facts: string[], wrong: number }]
 *        facts 是 factKey 陣列（只含**有作答**的題），wrong 是官方說的錯題數
 * @param {object} known 初始已知 { [factKey]: 'correct' | 'wrong' }
 * @returns {{ known: object, learned: {correct: string[], wrong: string[]}, contradictions: string[] }}
 */
function propagate(constraints = [], known = {}) {
  const state = { ...known };
  const learned = { correct: [], wrong: [] };
  const contradictions = [];
  const seen = new Set();          // 同一條約束的矛盾只報一次

  const set = (fk, verdict) => {
    if (state[fk] === verdict) return false;
    if (state[fk] && state[fk] !== verdict) {
      // 同一個事實被推成兩種結果＝上游資料自相矛盾
      if (!seen.has(fk)) { contradictions.push(`同一個作答被推出兩種結果：${fk}`); seen.add(fk); }
      return false;
    }
    state[fk] = verdict;
    learned[verdict].push(fk);
    return true;
  };

  let changed = true;
  let rounds = 0;
  // 每一輪至少判定一個事實，否則就停；上限只是保險，正常跑不到
  const maxRounds = constraints.length * 2 + 10;
  while (changed && rounds++ < maxRounds) {
    changed = false;
    for (const c of constraints) {
      const facts = Array.isArray(c.facts) ? c.facts : [];
      if (!facts.length || !Number.isInteger(c.wrong)) continue;
      const unknown = facts.filter(f => !state[f]);
      const knownWrong = facts.filter(f => state[f] === 'wrong').length;
      const remaining = c.wrong - knownWrong;

      if (remaining < 0 || remaining > unknown.length) {
        // 官方說錯 k 題，但已知錯的已經超過 k、或剩下的題不夠湊出 k
        if (!seen.has(c.key)) {
          contradictions.push(
            `${c.key}：官方說錯 ${c.wrong} 題，但已判定 ${knownWrong} 題錯、只剩 ${unknown.length} 題未定，湊不出來`);
          seen.add(c.key);
        }
        continue;
      }
      if (!unknown.length) continue;
      if (remaining === 0) {
        for (const f of unknown) changed = set(f, 'correct') || changed;
      } else if (remaining === unknown.length) {
        for (const f of unknown) changed = set(f, 'wrong') || changed;
      }
    }
  }
  return { known: state, learned, contradictions };
}

/**
 * 把 DB 撈出來的列組成約束＋初始已知。
 *
 * 初始已知有兩個來源，都是硬事實：
 *   1. 已經有官方答案的題——你填的等於官方答案就是對的，不等於就是**錯的**
 *      （這一條免費送一大批 wrong，propagation 會靠它們往下推）
 *   2. 上一輪推導的結果（存在 exam_items.wrong_answers）
 *
 * @param {Array} rows [{ bank_id, bank_label, title, incorrect, item_id, answer_final, answer_official, certain }]
 */
function buildConstraints(rows = []) {
  const byGroup = new Map();
  const known = {};
  for (const r of rows) {
    if (!Array.isArray(r.answer_final) || !r.answer_final.length) continue;  // 未作答不進方程式
    const fk = factKey(r.item_id, r.answer_final);
    const g = `${r.bank_id}|${r.title}`;
    if (!byGroup.has(g)) {
      byGroup.set(g, { key: `${r.bank_label || ('題庫 ' + r.bank_id)}／${r.title}`, facts: [], wrong: r.incorrect });
    }
    // 同一場同一章裡同一個事實只算一次（同一題重複上傳時會有兩筆 attempt）
    const grp = byGroup.get(g);
    if (!grp.facts.includes(fk)) grp.facts.push(fk);

    if (r.certain && Array.isArray(r.answer_official) && r.answer_official.length) {
      const official = [...r.answer_official].map(String).sort().join(',');
      const gave = [...r.answer_final].map(String).sort().join(',');
      known[fk] = official === gave ? 'correct' : 'wrong';
    }
  }
  return { constraints: [...byGroup.values()], known };
}

const parseFact = fk => {
  const i = fk.indexOf('|');
  return { itemId: parseInt(fk.slice(0, i), 10), answer: fk.slice(i + 1).split(',').filter(Boolean) };
};

/**
 * 從 DB 撈資料、推導、寫回。歸檔之後呼叫（章節結果才剛寫進去）。
 *
 * 推出來的「對」直接變成官方答案（official_from='deduced'）——它跟「這章全對」
 * 一樣是證明，強度相同。推出來的「錯」存進 exam_items.wrong_answers。
 *
 * ⚠ 有矛盾時**不寫任何東西**。矛盾代表上游資料錯了（成績單抄錯、章節名改過），
 * 這時推出來的結論不可信，而寫進去就把錯的答案永久鎖成正解——歸檔不可逆。
 */
async function applyDeduction(db, odooVersion) {
  const { rows } = await db.query(`
    SELECT b.id AS bank_id, b.label AS bank_label, s.title, s.incorrect,
           a.item_id, a.answer_final, i.answer_official, i.certain
      FROM exam_sections s
      JOIN exam_banks b ON b.id = s.bank_id
      JOIN exam_attempts a ON a.bank_id = s.bank_id
      JOIN exam_items i ON i.id = a.item_id AND i.section_title = s.title
     WHERE b.odoo_version = $1`, [odooVersion]);

  const { constraints, known } = buildConstraints(rows);
  const r = propagate(constraints, known);
  if (r.contradictions.length) {
    return { locked: 0, marked: 0, contradictions: r.contradictions, skippedWrite: true };
  }

  const stat = { locked: 0, marked: 0, contradictions: [], skippedWrite: false };

  // 推出「對」的 ⇒ 那就是官方答案。COALESCE：已有的官方答案不被覆蓋
  // （與 archive.js／import-bank.js 同一套合併規則）。
  for (const fk of r.learned.correct) {
    const { itemId, answer } = parseFact(fk);
    if (!answer.length) continue;
    const res = await db.query(`
      UPDATE exam_items
         SET answer_official = COALESCE(answer_official, $2),
             official_from = COALESCE(official_from, 'deduced'),
             certain = TRUE, updated_at = NOW()
       WHERE id = $1 AND certain = FALSE
       RETURNING id`, [itemId, answer]);
    stat.locked += res.rows.length;
  }

  // 推出「錯」的 ⇒ 併進 wrong_answers。同一個答案不重複記。
  const wrongByItem = new Map();
  for (const fk of r.learned.wrong) {
    const { itemId, answer } = parseFact(fk);
    if (!answer.length) continue;
    if (!wrongByItem.has(itemId)) wrongByItem.set(itemId, []);
    wrongByItem.get(itemId).push(answer);
  }
  for (const [itemId, answers] of wrongByItem) {
    const cur = (await db.query(`SELECT wrong_answers FROM exam_items WHERE id = $1`, [itemId])).rows[0];
    const have = Array.isArray(cur && cur.wrong_answers) ? cur.wrong_answers : [];
    const seenKeys = new Set(have.map(a => [...a].sort().join(',')));
    let added = 0;
    for (const a of answers) {
      const k = [...a].sort().join(',');
      if (seenKeys.has(k)) continue;
      seenKeys.add(k); have.push(a); added++;
    }
    if (added) {
      await db.query(
        `UPDATE exam_items SET wrong_answers = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [itemId, JSON.stringify(have)]);
      stat.marked += added;
    }
  }
  return stat;
}

module.exports = { propagate, buildConstraints, factKey, applyDeduction };
