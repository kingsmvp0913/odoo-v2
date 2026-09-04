// 佇列 worker：把 exam_uploads 裡 pending 的截圖跑完審查，建成題目與作答紀錄。
//
// 與 tools/exam-review-run.js 的差別：那支處理**已知題目**的既有題庫（exam_attempts
// 已經存在），這支處理**未知題目**——題幹與選項要從截圖抄出來才知道，所以每一頁
// 都可能建立新的 exam_items。
//
// 三個設計約束，每個都對應實測踩過的坑：
//   1. **進度存 DB 不只靠 socket 廣播**。廣播只送給當下開著頁面的人，重整一次
//      前端記憶體就空了、畫面上工作消失，使用者以為沒反應再按一次撞 409，
//      於是認為「建不了題庫」——但第一次早就在跑了。
//   2. **併行有上限**。Claude 用量是全平台單一帳號共用，跑太兇會排擠正在跑的
//      開發 pipeline（那是天天在用的東西）。原專案實測上限 2→3。
//   3. **單筆失敗不中斷整批**。實測踩過：一頁逾時讓整個腳本 exit，前面跑完的
//      結果留在 DB，從結果看不出少了一半。
const path = require('path');
const { extractPage, reviewQuestions, saveVerdicts } = require('./review');
const { gatherEvidence, saveEvidence, needsEvidence } = require('./evidence');
const { lookupTerms } = require('./glossary');
const { fingerprint } = require('./fingerprint');
const { baseConfidence, calibrateSection } = require('./confidence');
const { parseAnswers, checkCount, alignAnswers } = require('./answers');

// 併行上限。超過 3 會排擠平台自己的 pipeline——Claude 帳號是全平台共用的。
const concurrency = () => Math.max(1, parseInt(process.env.EXAM_CONCURRENCY || '3', 10));

const uploadRootOf = () => require('../attachments').uploadRoot();

async function setJob(db, jobId, patch) {
  const cols = [], vals = [];
  for (const [k, v] of Object.entries(patch)) { vals.push(v); cols.push(`${k} = $${vals.length + 1}`); }
  if (!cols.length) return;
  await db.query(`UPDATE exam_jobs SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $1`,
    [jobId, ...vals]);
}

// 把一筆 upload 跑完：抄題 → 查官方題庫 → 未命中才審查 → 建作答／判斷 → 取證。
async function processUpload(db, { upload, bank, onProgress }) {
  const shot = path.join(uploadRootOf(), upload.image_path);
  const parsed = parseAnswers(upload.answer_raw);

  const { page } = await extractPage({ imagePath: shot, onProgress });

  if (page.readable === false) {
    throw new Error(`讀不出題目：${page.note || '(未說明)'}`);
  }
  const qs = page.questions || [];
  const count = checkCount(parsed, qs.length);
  const aligned = alignAnswers(parsed, qs.length);

  const notes = [];
  if (!count.ok) notes.push(count.note);
  if (parsed.note) notes.push(parsed.note);
  if (page.note) notes.push(page.note);

  // 先建 item／attempt，並把只有官方確認答案的命中題短路掉。
  // 最後答案刻意留 NULL：輸入、官方／審查、投票、最後答案是四種不同事實。
  const toReview = [];
  for (const [i, q] of qs.entries()) {
    let fp;
    try { fp = fingerprint(q.question); } catch { notes.push(`第 ${q.no} 題抄不出題幹，跳過`); continue; }

    // 先 SELECT 再分岔，不用 ON CONFLICT RETURNING——pg-mem 在真衝突時仍回一列，
    // 靠 rows.length 判斷會讓測試環境永遠走新增分支（見 import-bank.js 的同一段）。
    const hit = await db.query(
      `SELECT id, answer_official, official_from
         FROM exam_items WHERE odoo_version = $1 AND fingerprint = $2`,
      [bank.odoo_version, fp]);

    let itemId, officialAnswer = null;
    if (hit.rows.length) {
      const known = hit.rows[0];
      itemId = known.id;
      if (known.official_from && Array.isArray(known.answer_official) && known.answer_official.length) {
        officialAnswer = known.answer_official;
      }
      await db.query(
        `UPDATE exam_items SET seen_count = seen_count + 1, updated_at = NOW() WHERE id = $1`,
        [itemId]);
    } else {
      const ins = await db.query(
        `INSERT INTO exam_items
           (odoo_version, fingerprint, question_en, question_zh, options, qtype, section_title)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [bank.odoo_version, fp, q.question, q.question_zh || null,
         JSON.stringify(q.options || []), q.type === 'multi' ? 'multi' : 'single',
         upload.section_title || null]);
      itemId = ins.rows[0].id;
    }

    await db.query(
      `INSERT INTO exam_attempts
         (item_id, bank_id, upload_id, page, no, answer_their, answer_final, responder)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
      [itemId, bank.id, upload.id, String(upload.page), q.no,
       aligned[i] && aligned[i].length ? aligned[i] : null, upload.responder || null]);

    if (!officialAnswer) {
      toReview.push({ itemId, q, theirAnswer: aligned[i] || [] });
    }
  }

  let reviewed = [];
  if (toReview.length) {
    const allText = toReview.map(x => [x.q.question, ...(x.q.options || []).map(o => o.text)].join(' ')).join('\n');
    const glossary = await lookupTerms(db, bank.odoo_version, allText);
    const { verdict, model } = await reviewQuestions({
      questions: toReview.map(x => x.q),
      theirAnswers: toReview.map(x => x.theirAnswer),
      glossary,
      imagePath: shot,
      onProgress,
    });
    if (verdict.readable === false) throw new Error(`審查失敗：${verdict.note || '(未說明)'}`);
    reviewed = verdict.questions || [];

    // verdict 用 (bank_id, page, no) 對應，所以 attempts 必須先建好。
    // 官方命中題不在 verdict 裡，因此不會產生假的 adversary 紀錄。
    const saved = await saveVerdicts(db, { bankId: bank.id, page: String(upload.page), verdict, model });
    if (saved.unmatched.length) notes.push(`對不上的題號：${saved.unmatched.join('、')}`);
  }

  // 取證：信心 < 90 或被推翻的題
  const itemByNo = new Map(toReview.map(x => [x.q.no, x.itemId]));
  for (const q of reviewed) {
    const itemId = itemByNo.get(q.no);
    if (!itemId) continue;
    if (!needsEvidence({ confidence: q.confidence, refuted: q.refuted })) continue;
    try {
      const candidate = q.refuted ? q.correct_answer : q.their_answer;
      const { result } = await gatherEvidence({
        question: q.question, options: q.options, candidate, odooVersion: bank.odoo_version, onProgress });
      const v = await db.query(
        `SELECT id FROM exam_verdicts WHERE item_id = $1 AND kind = 'adversary'
          ORDER BY id DESC LIMIT 1`, [itemId]);
      if (v.rows.length) await saveEvidence(db, { verdictId: v.rows[0].id, evidence: result.evidence });
    } catch (e) {
      // 取證失敗不影響這一題的審查結果，只是少了證據（信心度停在「沒找證據」那層）
      notes.push(`第 ${q.no} 題取證失敗：${e.message}`);
    }
  }

  return { questions: qs.length, official: qs.length - toReview.length, reviewed: reviewed.length,
    note: notes.join('；') };
}

// 重算整份題庫的信心度＋章節校準。純計算，每次跑完都重來。
async function recomputeConfidence(db, bank) {
  const items = (await db.query(`
    SELECT i.id, i.certain, i.answer_official, i.section_title
      FROM exam_items i WHERE i.odoo_version = $1`, [bank.odoo_version])).rows;

  const bySection = new Map();
  for (const it of items) {
    const v = (await db.query(
      `SELECT id, refuted, confidence, correct_answer FROM exam_verdicts
        WHERE item_id = $1 AND kind = 'adversary' ORDER BY id DESC LIMIT 1`, [it.id])).rows[0] || null;
    const ev = v ? (await db.query(
      `SELECT kind, ref FROM exam_evidence WHERE verdict_id = $1`, [v.id])).rows : [];
    const agree = (await db.query(
      `SELECT COUNT(*)::int c FROM exam_verdicts
        WHERE item_id = $1 AND kind = 'adversary' AND refuted = false`, [it.id])).rows[0].c;
    const answered = (await db.query(
      `SELECT COUNT(*)::int c FROM exam_attempts
        WHERE item_id = $1 AND answer_final IS NOT NULL`, [it.id])).rows[0].c > 0;

    const { confidence, why } = baseConfidence({
      certain: it.certain, hasOfficial: !!it.answer_official,
      verdict: v, evidence: ev, agreeCount: agree });

    const key = it.section_title || '(無章節)';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push({ id: it.id, confidence, why, certain: it.certain, answered });
  }

  const secs = (await db.query(
    `SELECT title, incorrect FROM exam_sections WHERE bank_id = $1`, [bank.id])).rows;
  const incByTitle = new Map(secs.map(s => [s.title, s.incorrect]));

  const notes = [];
  for (const [title, list] of bySection) {
    const r = calibrateSection(list, { incorrect: incByTitle.has(title) ? incByTitle.get(title) : null });
    if (r.note) notes.push(`[${title}] ${r.note}`);
  }
  for (const list of bySection.values()) {
    for (const e of list) {
      await db.query(
        `UPDATE exam_items SET confidence = $2, confidence_why = $3, calibrated = $4, updated_at = NOW()
          WHERE id = $1`, [e.id, e.confidence, e.why, !!e.calibrated]);
    }
  }
  return { notes };
}

/**
 * 跑一個題庫的待處理佇列。回傳統計。
 *
 * onEvent 是給 socket 廣播用的**額外**通道——進度的真相在 exam_jobs，
 * 廣播只是讓開著頁面的人即時看到。
 */
async function runQueue(db, { bankId, onEvent = () => {} }) {
  const bank = (await db.query(
    `SELECT id, label, odoo_version FROM exam_banks WHERE id = $1`, [bankId])).rows[0];
  if (!bank) throw new Error(`找不到題庫 ${bankId}`);

  const pending = (await db.query(
    `SELECT id, bank_id, page, answer_raw, responder, image_path, is_test
       FROM exam_uploads WHERE bank_id = $1 AND status = 'pending' ORDER BY id`, [bankId])).rows;
  if (!pending.length) return { jobId: null, total: 0, done: 0, failed: 0 };

  const job = (await db.query(
    `INSERT INTO exam_jobs (bank_id, status, phase, pages_total, pid)
     VALUES ($1,'running','審查中',$2,$3) RETURNING id`,
    [bankId, pending.length, process.pid])).rows[0];

  const stat = { jobId: job.id, total: pending.length, done: 0, failed: 0 };
  const queue = [...pending];

  const nextOne = async () => {
    for (;;) {
      const up = queue.shift();
      if (!up) return;
      await db.query(`UPDATE exam_uploads SET status='running', updated_at=NOW() WHERE id=$1`, [up.id]);
      onEvent({ jobId: job.id, page: up.page, status: 'running' });
      try {
        const r = await processUpload(db, {
          upload: up, bank,
          onProgress: (msg) => onEvent({ jobId: job.id, page: up.page, progress: msg }),
        });
        await db.query(
          `UPDATE exam_uploads SET status='done', error=$2, updated_at=NOW() WHERE id=$1`,
          [up.id, r.note || null]);
        stat.done++;
        onEvent({ jobId: job.id, page: up.page, status: 'done', questions: r.questions, note: r.note });
      } catch (e) {
        // 單筆失敗不中斷整批：標 failed 留著，讓人看得出是哪一步壞的、也知道能重跑
        await db.query(
          `UPDATE exam_uploads SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
          [up.id, e.message]);
        stat.failed++;
        onEvent({ jobId: job.id, page: up.page, status: 'failed', error: e.message });
      }
      await setJob(db, job.id, { pages_done: stat.done + stat.failed });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency(), pending.length) }, nextOne));

  await setJob(db, job.id, { phase: '重算信心度' });
  const { notes } = await recomputeConfidence(db, bank);
  await setJob(db, job.id, { status: 'done', phase: notes.join('；') || null });
  onEvent({ jobId: job.id, status: 'done', ...stat });
  return stat;
}

/**
 * 平台啟動時呼叫：把上次被殺掉的工作標成 interrupted。
 *
 * 沒有這一步的話，重啟後那些 job 會永遠停在 'running'，而畫面上看起來像
 * 「還在跑」——實際上跑它的行程早就不在了，等多久都不會有進展。
 * running 的 upload 一併退回 pending，下次跑會接續（已 done 的不受影響）。
 */
async function reclaimInterrupted(db) {
  const jobs = await db.query(
    `UPDATE exam_jobs SET status='interrupted', updated_at=NOW()
      WHERE status='running' RETURNING id`);
  const ups = await db.query(
    `UPDATE exam_uploads SET status='pending', updated_at=NOW()
      WHERE status='running' RETURNING id`);
  return { jobs: jobs.rows.length, uploads: ups.rows.length };
}

module.exports = { runQueue, processUpload, recomputeConfidence, reclaimInterrupted, concurrency };
