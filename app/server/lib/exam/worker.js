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
//      開發 pipeline（那是天天在用的東西）。原專案實測 2→3，本平台放寬到 5
//      （使用者 2026-09-05 裁決：考試當下等不起，寧可排擠開發）。
//   3. **單筆失敗不中斷整批**。實測踩過：一頁逾時讓整個腳本 exit，前面跑完的
//      結果留在 DB，從結果看不出少了一半。
const path = require('path');
const { extractPage, saveVerdicts } = require('./review');
const { challengePage } = require('./challenge');
const { saveEvidence } = require('./evidence');
const { lookupTerms } = require('./glossary');
const { fingerprint } = require('./fingerprint');
const { baseConfidence, calibrateSection } = require('./confidence');
const { parseAnswers, checkCount, alignAnswers } = require('./answers');

// 併行上限。Claude 帳號是全平台共用的，開越多越會排擠自家 pipeline；
// 5 是使用者權衡「考試當下等不起」之後訂的線，要再調用 EXAM_CONCURRENCY。
const concurrency = () => Math.max(1, parseInt(process.env.EXAM_CONCURRENCY || '5', 10));

// 空手的 worker 在結束前要再等幾輪。一次丟一整份考卷時那些 POST 是陸續落地的，
// 立刻結束會讓併行退化成序列（實測 19 頁只有 1 個 worker 在跑）。
// 6 輪 × 2 秒 = 12 秒，涵蓋得了一份考卷全部落地，也不會讓空佇列時的收工拖太久。
// 執行期讀，不在模組載入時 snapshot（專案規則 122）——snapshot 的話改了設定要
// 重啟才生效，測試也沒辦法把等待時間調短。
const idleWaitMs = () => parseInt(process.env.EXAM_IDLE_WAIT_MS || '2000', 10);
const idleRounds = () => parseInt(process.env.EXAM_IDLE_ROUNDS || '6', 10);

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

  // 挑戰：一次呼叫同時做「找反證」與「拿原始碼佐證」。
  //
  // 原本拆成審查→取證兩步，實測 Project 一頁 8 題＝審查 6.5 分＋取證 5.1 分。
  // 而審查那 6.5 分幾乎都在等網路——它手上沒有原始碼，就跑去 WebSearch/WebFetch
  // 抓 odoo.com 文件，17 次網路請求、單筆空檔就有 96 秒。一開始就把原始碼給它，
  // 它沒有理由上網；而且結論與證據出自同一次推理，不會兩步各說各話。
  let reviewed = [];
  if (toReview.length) {
    const allText = toReview.map(x => [x.q.question, ...(x.q.options || []).map(o => o.text)].join(' ')).join('\n');
    const glossary = await lookupTerms(db, bank.odoo_version, allText);
    const { verdict, model } = await challengePage({
      questions: toReview.map(x => x.q),
      theirAnswers: toReview.map(x => x.theirAnswer),
      glossary,
      odooVersion: bank.odoo_version,
      imagePath: shot,
      onProgress,
    });
    if (verdict.readable === false) throw new Error(`挑戰失敗：${verdict.note || '(未說明)'}`);
    reviewed = verdict.questions || [];

    // verdict 用 (bank_id, page, no) 對應，所以 attempts 必須先建好。
    // 官方命中題不在 verdict 裡，因此不會產生假的 adversary 紀錄。
    const saved = await saveVerdicts(db, { bankId: bank.id, page: String(upload.page), verdict, model });
    if (saved.unmatched.length) notes.push(`對不上的題號：${saved.unmatched.join('、')}`);

    // 證據跟著同一次判斷寫進去。ref 的路徑驗證在 challenge 那邊就做完了，
    // 這裡收到的已經是只剩沙箱內合法路徑的清單。
    const itemByNo = new Map(toReview.map(x => [x.q.no, x.itemId]));
    for (const q of reviewed) {
      // 被丟棄的路徑先記——它跟「有沒有合法證據」是兩回事，寫在 continue 之後
      // 就永遠不會執行（全部證據都不合法時剛好一筆都沒有，那正是最該講的情況）。
      // 只報數量的話，「格式對不上」與「agent 真的亂跑」長得一模一樣——
      // 實測整批被丟掉時得去翻 CLI transcript 才看得出是前者。附上第一筆原文。
      if (q.rejected_refs && q.rejected_refs.length) {
        notes.push(`第 ${q.no} 題有 ${q.rejected_refs.length} 筆證據路徑不合法，已丟棄（例：${q.rejected_refs[0]}）`);
      }
      if (!q.evidence || !q.evidence.length) continue;
      const v = await db.query(
        `SELECT id FROM exam_verdicts WHERE item_id = $1 AND kind = 'adversary'
          ORDER BY id DESC LIMIT 1`, [itemByNo.get(q.no)]);
      if (v.rows.length) await saveEvidence(db, { verdictId: v.rows[0].id, evidence: q.evidence });
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

  // 章節結果要跨 bank 撈**同版本的全部**，不能只看這一場。
  //
  // 上面撈題目用的是 odoo_version（題庫是跨考次共用的），章節結果卻綁在 bank 上。
  // 只撈這一場的話，新考一場就會讓舊考次那些章節「查無官方結果」而整批失去校準——
  // 實測踩過：POST 進一份新題庫後 120 題全部 calibrated=false，風險總和從 15.03
  // 跳回 17.46，畫面上沒有任何錯誤，只是信心度悄悄變了。
  //
  // 同名章節有多場結果時取最新那場（id 大的覆蓋），最近一次官方回饋最能反映現況。
  const secs = (await db.query(`
    SELECT s.title, s.incorrect
      FROM exam_sections s JOIN exam_banks b ON b.id = s.bank_id
     WHERE b.odoo_version = $1 ORDER BY s.bank_id`, [bank.odoo_version])).rows;
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

  const fetchPending = async () => (await db.query(
    `SELECT id, bank_id, page, answer_raw, responder, image_path, is_test, section_title
       FROM exam_uploads WHERE bank_id = $1 AND status = 'pending' ORDER BY id`, [bankId])).rows;

  const pending = await fetchPending();
  if (!pending.length) return { jobId: null, total: 0, done: 0, failed: 0 };

  const job = (await db.query(
    `INSERT INTO exam_jobs (bank_id, status, phase, pages_total, pid)
     VALUES ($1,'running','審查中',$2,$3) RETURNING id`,
    [bankId, pending.length, process.pid])).rows[0];

  const stat = { jobId: job.id, total: 0, done: 0, failed: 0 };
  let queue = [...pending];

  /**
   * 認領一筆。**認領＝把 pending 改成 running，而且要靠 DB 判斷有沒有搶到。**
   *
   * 「先從佇列取出、再去標記 running」中間隔著一個 await，那個空隙足夠讓另一個
   * worker 查到同一筆還是 pending 而重複拿走——實測炸過：8 題的頁跑出 16 筆作答，
   * 同一頁被判了兩次，token 也白燒一份。
   *
   * `WHERE status='pending'` 讓搶輸的那個拿到 0 列，直接跳過。
   */
  const claim = async (up) => {
    const r = await db.query(
      `UPDATE exam_uploads SET status='running', updated_at=NOW()
        WHERE id=$1 AND status='pending' RETURNING id`, [up.id]);
    if (!r.rows.length) return false;
    stat.total++;
    await setJob(db, job.id, { pages_total: stat.total });
    return true;
  };

  const nextOne = async () => {
    let emptyRounds = 0;
    for (;;) {
      // 佇列空了先回頭查一次 DB，不要拿開頭那份快照當全部。
      //
      // 同事是**一頁一頁**傳的（那是主流程，不是例外）。用快照的話，第二頁在
      // 幾十毫秒後才進 DB，這一批早就決定好只有第一頁，第二頁得等整批跑完才
      // 開新的一批——實測兩次 POST 相差 31ms，結果是兩個各只有 1 頁的 job，
      // 併行上限完全沒有機會生效。
      //
      // **查不到不能立刻結束，要等幾秒再查。** 一次丟 19 頁時那些 POST 是在幾百
      // 毫秒內陸續落地的；worker 全部同時啟動，第 2~5 個當下查到空的就走人，
      // 結果只剩一個在序列跑——實測 job 的 pages_total 是 2，併行上限 5 完全沒有
      // 機會生效。等幾輪再走，晚到的頁才有人接。
      if (!queue.length) queue = await fetchPending();
      if (!queue.length) {
        if (++emptyRounds > idleRounds()) return;
        await new Promise(r => setTimeout(r, idleWaitMs()));
        continue;
      }
      emptyRounds = 0;
      const up = queue.shift();
      if (!up) continue;
      if (!await claim(up)) continue;   // 被別的 worker 搶走了
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
        // attempts 是在審查**之前**就建好的（saveVerdicts 要靠它們對應題號），
        // 所以審查那一步炸掉時會留下一批沒有 verdict 的孤兒：畫面上永遠顯示
        // 「等待中」，重跑同一頁還會再建一份重複的。實測踩過——模型把信心度回成
        // 0.95 撞爛 INTEGER 欄位，整頁 4 題就這樣卡在那裡。
        // 失敗即回滾成「這頁沒跑過」，重跑才是乾淨的。
        await db.query(`DELETE FROM exam_attempts WHERE upload_id = $1`, [up.id]);
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

  // 固定開滿併行數，不看開頭有幾頁：多出來的 worker 查不到待處理就立刻結束，
  // 但只要有一個還在跑，後到的頁就有 worker 可以馬上接手。
  await Promise.all(Array.from({ length: concurrency() }, nextOne));

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
