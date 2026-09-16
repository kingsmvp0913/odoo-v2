// app/server/ai-platform-routes.js
// 子專案 0 §4.4：取代兩個直連平台 DB 的 skill 的唯讀端點。
//   /ai/glossary          odooGlossary 用；術語表是公開的 Odoo 字串，任何有 glossary 群組的 scope 都可查
//   /ai/platform/query    platformDB 用；只給 internal-audit（Task 1.11 加入）
const { query } = require('./db');
const { aiEndpointGuard } = require('./lib/ai-token');
const { requireAiEndpoint } = require('./lib/ai-scope');

const GLOSSARY_LIMIT = 50;

// LOWER+LIKE 而非 ILIKE：pg-mem 相容（比照 wiki-routes /ai/wiki/search）；逸脫 % _ \
const likeOf = s => `%${String(s).toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;

function registerRoutes(app) {
  app.get('/ai/glossary', aiEndpointGuard, requireAiEndpoint('glossary'), async (req, res) => {
    try {
      const version = String(req.query.version || '').trim();
      if (!version) return res.json({ ok: false, error: '缺 version 參數（Odoo 大版本，例：19）' });
      let where; let param;
      if (req.query.term) { where = 'term_en = $2'; param = String(req.query.term); }
      else if (req.query.q) { where = 'LOWER(term_en) LIKE $2'; param = likeOf(req.query.q); }
      else if (req.query.zh) { where = 'term_zh LIKE $2'; param = likeOf(req.query.zh); }
      else return res.json({ ok: false, error: '需要 term（英文精確）、q（英文片段）或 zh（中文片段）其中之一' });
      const { rows } = await query(
        `SELECT term_en, term_zh, hit_count FROM exam_glossary
          WHERE odoo_version = $1 AND ${where}
          ORDER BY hit_count DESC, term_en ASC LIMIT ${GLOSSARY_LIMIT}`, [version, param]);
      res.json({ ok: true, terms: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
}

module.exports = { registerRoutes };
