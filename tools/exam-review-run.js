// 對既有題庫的某一頁（或全部）跑對立審查、取證與信心度。
//
//   node tools/exam-review-run.js <題庫label> <頁碼|all> [--no-evidence]
//
// 流程：查術語表 → 對立審查（同時抄題＋翻譯）→ 信心 <90 取證 → 算信心度 → 章節校準
const path = require('path');
const fs = require('fs');

const [label, pageArg, ...flags] = process.argv.slice(2);
if (!label || !pageArg) {
  console.error('用法: node tools/exam-review-run.js <題庫label> <頁碼|all> [--no-evidence]');
  process.exit(1);
}
const noEvidence = flags.includes('--no-evidence');

const cfgPath = path.join(__dirname, '..', 'data', 'config.json');
if (!process.env.DATABASE_URL && fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (cfg.DATABASE_URL) process.env.DATABASE_URL = cfg.DATABASE_URL;
}

const db = require('../app/server/db');
const { reviewPage, saveVerdicts, checkGlossary, termsIn } = require('../app/server/lib/exam/review');
const { gatherEvidence, saveEvidence, needsEvidence } = require('../app/server/lib/exam/evidence');
const { lookupTerms } = require('../app/server/lib/exam/glossary');
const { baseConfidence, calibrateSection } = require('../app/server/lib/exam/confidence');

const BANKS = path.join(__dirname, '..', 'data', 'exam', 'banks');

// 截圖存在 <題庫目錄>/shots/<recordId>/shot.jpg，recordId 對應 raw/<recordId>.json 的 page 欄位
function shotIndex(bankLabel) {
  const dir = path.join(BANKS, bankLabel);
  const rawDir = path.join(dir, 'raw');
  const idx = new Map();
  if (!fs.existsSync(rawDir)) return idx;
  for (const f of fs.readdirSync(rawDir).filter(n => n.endsWith('.json'))) {
    const id = f.replace(/\.json$/, '');
    let page;
    try { page = String(JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')).page || ''); }
    catch { continue; }
    const shot = path.join(dir, 'shots', id, 'shot.jpg');
    if (page && fs.existsSync(shot)) idx.set(page, shot);
  }
  return idx;
}

async function runPage({ bank, page, shot }) {
  const rows = (await db.query(
    `SELECT a.no, a.answer_their, a.answer_final, i.id AS item_id, i.question_en, i.options
       FROM exam_attempts a JOIN exam_items i ON i.id = a.item_id
      WHERE a.bank_id = $1 AND a.page = $2 ORDER BY a.no`,
    [bank.id, String(page)]
  )).rows;
  if (!rows.length) { console.log(`P${page} 題庫裡沒有這一頁`); return null; }

  // 術語表只塞這一頁用得到的。題幹已知才查得到——全新題庫第一次讀圖時
  // 沒有這一步，改由 checkGlossary 事後比對。
  const allText = rows.map(r => r.question_en).join(' ');
  const glossary = await lookupTerms(db, bank.odoo_version, allText);

  const theirAnswers = rows.map(r => r.answer_their || []);
  const t0 = Date.now();
  const { verdict, model } = await reviewPage({ imagePath: shot, theirAnswers, glossary });
  const secs = Math.round((Date.now() - t0) / 1000);

  if (verdict.readable === false) {
    console.log(`P${page} ✗ 讀不出題目：${verdict.note}`);
    return null;
  }

  const saved = await saveVerdicts(db, { bankId: bank.id, page: String(page), verdict, model });
  const marks = [];
  const evidenceRuns = [];

  for (const q of verdict.questions) {
    const row = rows.find(r => r.no === q.no);
    let tag = `Q${q.no}:${q.refuted ? '推翻→' + q.correct_answer.join('') : 'OK'}(${q.confidence})`;
    if (q.shape_error) tag += '⚠形狀';
    marks.push(tag);

    if (!noEvidence && row && needsEvidence({ confidence: q.confidence, refuted: q.refuted })) {
      evidenceRuns.push({ q, row });
    }
  }
  console.log(`P${page} ${marks.join('  ')}  ${secs}s  術語${glossary.length}` +
              (saved.unmatched.length ? `  ⚠對不上:${saved.unmatched.join(',')}` : ''));

  // 譯文有沒有用官方譯法——沒對上不是致命錯誤，但要看得到。
  // 必須先用 termsIn 篩出「這一題真的用到的術語」再比：術語表是對整頁的英文查的，
  // 直接拿整頁清單比單題譯文，每題都會吐出十幾條假的沒對上。
  for (const q of verdict.questions) {
    const en = [q.question, ...(q.options || []).map(o => o.text)].join(' ');
    const zh = [q.question_zh, ...(q.options || []).map(o => o.text_zh)].join(' ');
    const { missed } = checkGlossary(zh, termsIn(en, glossary));
    if (missed.length) console.log(`   Q${q.no} 術語沒對上: ${missed.map(m => m.en + '→' + m.zh).join('、')}`);
  }

  for (const { q, row } of evidenceRuns) {
    const opts = typeof row.options === 'string' ? JSON.parse(row.options || '[]') : (row.options || []);
    const candidate = q.refuted ? q.correct_answer : (row.answer_final || row.answer_their || []);
    try {
      const { result } = await gatherEvidence({
        question: row.question_en, options: opts, candidate, odooVersion: bank.odoo_version });
      const v = await db.query(
        `SELECT id FROM exam_verdicts WHERE item_id = $1 AND kind = 'adversary'
          ORDER BY id DESC LIMIT 1`, [row.item_id]);
      const n = v.rows.length ? await saveEvidence(db, { verdictId: v.rows[0].id, evidence: result.evidence }) : 0;
      console.log(`   Q${q.no} 取證: ${result.found ? n + ' 筆' : '查不到'}` +
                  (result.evidence[0] ? ` ${result.evidence[0].ref}` : '') +
                  (result.rejected.length ? ` ⚠丟棄${result.rejected.length}筆越界` : ''));
    } catch (e) {
      console.log(`   Q${q.no} 取證失敗: ${e.message}`);
    }
  }
  return saved;
}

// 重算整份題庫的信心度＋章節校準。每次審查後都重跑，成本是純計算。
async function recomputeConfidence(bank) {
  const items = (await db.query(
    `SELECT i.id, i.certain, i.answer_official, i.section_title,
            (SELECT COUNT(*)::int FROM exam_attempts a
              WHERE a.item_id = i.id AND a.answer_final IS NOT NULL) AS answered
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

    const { confidence, why } = baseConfidence({
      certain: it.certain, hasOfficial: !!it.answer_official,
      verdict: v, evidence: ev, agreeCount: agree });

    const entry = { id: it.id, confidence, why, certain: it.certain, answered: it.answered > 0 };
    const key = it.section_title || '(無章節)';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(entry);
  }

  const secs = (await db.query(
    `SELECT title, incorrect FROM exam_sections WHERE bank_id = $1`, [bank.id])).rows;
  const incByTitle = new Map(secs.map(s => [s.title, s.incorrect]));

  let calibratedCount = 0;
  for (const [title, list] of bySection) {
    const r = calibrateSection(list, { incorrect: incByTitle.has(title) ? incByTitle.get(title) : null });
    if (r.note) console.log(`   [${title}] ${r.note}`);
    calibratedCount += r.scaled;
  }

  for (const list of bySection.values()) {
    for (const e of list) {
      await db.query(
        `UPDATE exam_items SET confidence = $2, confidence_why = $3, calibrated = $4, updated_at = NOW()
          WHERE id = $1`,
        [e.id, e.confidence, e.why, !!e.calibrated]);
    }
  }
  return { calibratedCount };
}

(async () => {
  await db.migrate();
  const bank = (await db.query(
    `SELECT id, label, odoo_version FROM exam_banks WHERE label = $1 ORDER BY id DESC LIMIT 1`,
    [label])).rows[0];
  if (!bank) { console.error(`找不到題庫 ${label}`); process.exit(1); }

  const shots = shotIndex(label);
  const pages = pageArg === 'all'
    ? [...shots.keys()].sort((a, b) => Number(a) - Number(b))
    : [String(pageArg)];

  for (const p of pages) {
    const shot = shots.get(p);
    if (!shot) { console.log(`P${p} 找不到截圖，跳過`); continue; }
    await runPage({ bank, page: p, shot });
  }

  console.log('\n重算信心度…');
  const { calibratedCount } = await recomputeConfidence(bank);
  console.log(`已校準 ${calibratedCount} 題`);
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
