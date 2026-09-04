/**
 * exam-routes.js — Odoo 認證題庫的讀取端點
 *
 * 設計文件：docs/superpowers/specs/2026-09-04-odoo-exam-platform-design.md
 *
 * 全部唯讀。建題庫與跑審查走 CLI（tools/exam-*.js），不掛在 HTTP 上——那是要燒
 * token、跑好幾分鐘的重活，綁在請求上兩邊都難用。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');

// 題目在列表上不需要選項全文，只要題幹與信心度。選項與理由留給單題詳情。
const LIST_COLS = `
  i.id, i.question_en, i.question_zh, i.qtype, i.section_title,
  i.confidence, i.confidence_why, i.certain, i.calibrated, i.seen_count,
  i.answer_official, i.official_from`;

function registerRoutes(app) {
  // 題庫清單。最新的排前面。
  //
  // 題數用 LEFT JOIN + GROUP BY 而不是相關子查詢（`(SELECT COUNT(*) … WHERE a.bank_id = b.id)`）：
  // 那種寫法在正式 Postgres 完全合法，但 **pg-mem 不支援子查詢引用外層欄位**，
  // 會回 `column "b.id" does not exist`。測試環境炸、正式環境好，是最難查的那種落差。
  app.get('/api/exam/banks', verifyToken, async (req, res) => {
    const { rows } = await query(`
      SELECT b.id, b.label, b.odoo_version, b.status, b.taken_at, b.created_at,
             COUNT(a.id)::int AS item_count
        FROM exam_banks b
        LEFT JOIN exam_attempts a ON a.bank_id = b.id
       GROUP BY b.id, b.label, b.odoo_version, b.status, b.taken_at, b.created_at
       ORDER BY b.id DESC`);
    res.json(rows);
  });

  // 有哪些 Odoo 版本的題（版本切換用）。
  app.get('/api/exam/versions', verifyToken, async (req, res) => {
    const { rows } = await query(`
      SELECT odoo_version, COUNT(*)::int AS n
        FROM exam_items GROUP BY odoo_version ORDER BY odoo_version DESC`);
    res.json(rows);
  });

  // 按章節分組的題目。介面的主畫面。
  //
  // 不用頁碼當骨架而用章節：官方成績本來就按章節給，直接攤在標題上；而且跨考次
  // 合併後同一章不會固定在同一頁，用頁碼遲早對不上。
  app.get('/api/exam/sections', verifyToken, async (req, res) => {
    const bankId = parseInt(req.query.bank, 10);
    if (!Number.isInteger(bankId)) return res.status(400).json({ error: '缺少 bank' });

    const bank = (await query(
      `SELECT id, label, odoo_version FROM exam_banks WHERE id = $1`, [bankId])).rows[0];
    if (!bank) return res.status(404).json({ error: '找不到題庫' });

    const items = (await query(`
      SELECT ${LIST_COLS}, a.page, a.no, a.answer_their, a.answer_final
        FROM exam_attempts a JOIN exam_items i ON i.id = a.item_id
       WHERE a.bank_id = $1
       ORDER BY a.page::int NULLS LAST, a.no`, [bankId])).rows;

    const secs = (await query(
      `SELECT title, n, correct, incorrect, unanswered, partial
         FROM exam_sections WHERE bank_id = $1`, [bankId])).rows;
    const byTitle = new Map(secs.map(s => [s.title, s]));

    // 章節順序照題目第一次出現的順序，與考試當下的順序一致
    const groups = [];
    const seen = new Map();
    for (const it of items) {
      const title = it.section_title || '(無章節)';
      if (!seen.has(title)) {
        const g = { title, official: byTitle.get(title) || null, items: [] };
        seen.set(title, g);
        groups.push(g);
      }
      seen.get(title).items.push(it);
    }
    res.json({ bank, groups });
  });

  // 單題詳情：選項中英對照、歷來審查、證據、各次考試的作答。
  app.get('/api/exam/items/:id', verifyToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 不合法' });

    const item = (await query(
      `SELECT * FROM exam_items WHERE id = $1`, [id])).rows[0];
    if (!item) return res.status(404).json({ error: '找不到題目' });

    // options 在 pg 是 jsonb，node-postgres 已解析；pg-mem 可能回字串。
    if (typeof item.options === 'string') {
      try { item.options = JSON.parse(item.options); } catch { item.options = []; }
    }

    const verdicts = (await query(`
      SELECT id, kind, refuted, correct_answer, confidence, reason, model, created_at
        FROM exam_verdicts WHERE item_id = $1 ORDER BY id DESC`, [id])).rows;

    const evidence = verdicts.length
      ? (await query(`
          SELECT verdict_id, kind, ref, excerpt FROM exam_evidence
           WHERE verdict_id = ANY($1::int[])`, [verdicts.map(v => v.id)])).rows
      : [];

    const attempts = (await query(`
      SELECT a.page, a.no, a.answer_their, a.answer_final, a.responder,
             b.label AS bank_label, b.taken_at
        FROM exam_attempts a JOIN exam_banks b ON b.id = a.bank_id
       WHERE a.item_id = $1 ORDER BY a.id`, [id])).rows;

    res.json({ item, verdicts, evidence, attempts });
  });

  // 給 /solve 用的查詢。**伺服器端就過濾掉非 100%**。
  //
  // 讓 /solve 看到一個不確定的舊答案，就是拿它去錨定新的推理——那正是這套系統
  // 花大力氣在防的事。這條規則寫在 server 才擋得住；回全部讓 client 自己判斷
  // 等於沒有規則。
  app.get('/api/exam/lookup', verifyToken, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const version = String(req.query.version || '19').trim();
    if (!q) return res.status(400).json({ error: '缺少 q' });

    const { fingerprint } = require('./lib/exam/fingerprint');
    let fp;
    try { fp = fingerprint(q); } catch { return res.json({ confidence: null }); }

    const hit = (await query(`
      SELECT answer_official, official_from, certain, confidence
        FROM exam_items WHERE odoo_version = $1 AND fingerprint = $2`, [version, fp])).rows[0];

    // 三個條件缺一不可：命中、有官方答案、信心真的是 100。
    if (!hit || !hit.answer_official || hit.confidence !== 100) {
      return res.json({ confidence: null });
    }
    res.json({
      confidence: 100,
      answer: hit.answer_official,
      source: hit.certain ? '官方章節全對推得' : '官方正解',
    });
  });
}

module.exports = { registerRoutes };
