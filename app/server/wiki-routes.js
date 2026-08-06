const { query } = require('./db');
const { verifyToken } = require('./auth');
const { initProjectWiki, refreshWikiNode } = require('./pipeline/library-agent');
const { aiEndpointGuard } = require('./lib/ai-token');

function registerRoutes(app) {
  const base = '/api/projects/:projectId/wiki';

  app.get(base, verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, slug, title, parent_id, node_type, updated_at
         FROM wiki_pages WHERE project_id = $1
         ORDER BY (node_type <> 'overview'), node_type, title ASC`,
        [req.params.projectId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post(`${base}/init`, verifyToken, async (req, res) => {
    try {
      const { slug } = await initProjectWiki(req.params.projectId, req.userId);
      res.json({ ok: true, slug });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post(`${base}/:slug/refresh`, verifyToken, async (req, res) => {
    try {
      const { rows: [node] } = await query(
        'SELECT node_type FROM wiki_pages WHERE project_id=$1 AND slug=$2',
        [req.params.projectId, req.params.slug]
      );
      if (node?.node_type === 'notes') return res.status(400).json({ error: '專案備註為人工維護，不支援重新生成' });
      if (node?.node_type === 'troubleshooting') return res.status(400).json({ error: '疑難排解由排障／客服對話累積，無原始碼可重生' });
      const result = await refreshWikiNode(req.params.projectId, req.params.slug, req.userId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post(base, verifyToken, async (req, res) => {
    try {
      const { slug, title, content } = req.body;
      if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });
      const { rows } = await query(
        `INSERT INTO wiki_pages (project_id, slug, title, content) VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.params.projectId, slug, title, content || '']
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'slug already exists in this project' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get(`${base}/:slug/raw`, verifyToken, async (req, res) => {
    try {
      const { rows: [page] } = await query(
        'SELECT content FROM wiki_pages WHERE project_id = $1 AND slug = $2',
        [req.params.projectId, req.params.slug]
      );
      if (!page) return res.status(404).send('Not found');
      res.type('text/plain').send(page.content);
    } catch (err) { res.status(500).send(err.message); }
  });

  app.get(`${base}/:slug`, verifyToken, async (req, res) => {
    try {
      const { rows: [page] } = await query(
        'SELECT * FROM wiki_pages WHERE project_id = $1 AND slug = $2',
        [req.params.projectId, req.params.slug]
      );
      if (!page) return res.status(404).json({ error: 'Not found' });
      res.json(page);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put(`${base}/:slug`, verifyToken, async (req, res) => {
    try {
      const { title, content } = req.body;
      const { rows } = await query(
        `UPDATE wiki_pages SET
           title = COALESCE($3, title),
           content = COALESCE($4, content),
           updated_at = NOW()
         WHERE project_id = $1 AND slug = $2 RETURNING *`,
        [req.params.projectId, req.params.slug, title || null, content ?? null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete(`${base}/:slug`, verifyToken, async (req, res) => {
    try {
      const { rows: [node] } = await query(
        'SELECT node_type FROM wiki_pages WHERE project_id=$1 AND slug=$2',
        [req.params.projectId, req.params.slug]
      );
      if (node?.node_type === 'notes') return res.status(400).json({ error: '專案備註不可刪除' });
      if (req.params.slug === 'troubleshooting') return res.status(400).json({ error: '疑難排解容器不可刪除（會連帶清空所有排障紀錄）；如需清理請刪除個別條目' });
      const { rows } = await query(
        'DELETE FROM wiki_pages WHERE project_id = $1 AND slug = $2 RETURNING id',
        [req.params.projectId, req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // description 一併回傳：只給 title 的話，agent 只能靠標題猜哪一頁相關，wiki 一多就必漏——
  // 而且漏掉沒有任何訊號（端點回 200＋清單，agent 當成「沒有相關記載」就不查了）。
  app.get('/ai/wiki/pages', aiEndpointGuard, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT w.slug, w.title, w.node_type, w.description
           FROM wiki_pages w JOIN projects p ON p.id = w.project_id
          WHERE p.folder_name=$1 OR p.name=$1
          ORDER BY (w.node_type <> 'overview'), w.node_type, w.title ASC`,
        [req.query.project]);
      res.json({ ok: true, pages: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  // 全文搜尋：補掉「只能按標題挑頁」的缺口。回 slug/title/description（不回 content 全文，
  // 否則一次搜尋就把整個 wiki 灌進 agent 的 context——分兩階段才是省 token 的關鍵）。
  // 大小寫不敏感用 LOWER+LIKE（pg-mem 相容，ILIKE 在測試環境不保證可用）。
  app.get('/ai/wiki/search', aiEndpointGuard, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ ok: false, error: '缺 q 參數（要搜尋的關鍵字）' });
      const like = `%${q.toLowerCase()}%`;
      const { rows } = await query(
        `SELECT w.slug, w.title, w.node_type, w.description
           FROM wiki_pages w JOIN projects p ON p.id = w.project_id
          WHERE (p.folder_name=$1 OR p.name=$1)
            AND (LOWER(w.title) LIKE $2 OR LOWER(w.content) LIKE $2 OR LOWER(COALESCE(w.description,'')) LIKE $2)
          ORDER BY (w.node_type <> 'troubleshooting'), w.title ASC
          LIMIT 20`,
        [req.query.project, like]);
      res.json({ ok: true, hits: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  // content 裡的 [[slug]] 一併解出對方的 title/description。搜尋解決的是「我知道關鍵字，找得到嗎」，
  // 這個解決的是「我根本不知道有這個東西存在」——排障結論常是成串的（同一個現象牽三四則），
  // 靠關鍵字撞不出來。只回摘要不回對方全文：要不要真的去讀，由讀的人決定。
  // 用動態 IN 而非 `slug = ANY($2::text[])`：pg-mem 對「有索引的欄位」跑 ANY(陣列) 會靜默回 0 列
  //（wiki_pages 的 (project_id, slug) 正好有 unique index），測試會全綠但功能是死的。
  app.get('/ai/wiki/page', aiEndpointGuard, async (req, res) => {
    try {
      const { rows: [page] } = await query(
        `SELECT w.slug, w.title, w.content
           FROM wiki_pages w JOIN projects p ON p.id = w.project_id
          WHERE (p.folder_name=$1 OR p.name=$1) AND w.slug=$2`,
        [req.query.project, req.query.slug]);
      if (!page) return res.json({ ok: false, error: '找不到該 wiki 頁' });

      const refs = [...new Set(
        (String(page.content || '').match(/\[\[[a-zA-Z0-9_-]+\]\]/g) || []).map(m => m.slice(2, -2))
      )].filter(s => s !== page.slug);
      let links = [];
      if (refs.length) {
        const ph = refs.map((_, i) => `$${i + 2}`).join(',');
        const { rows } = await query(
          `SELECT w.slug, w.title, w.description, w.node_type
             FROM wiki_pages w JOIN projects p ON p.id = w.project_id
            WHERE (p.folder_name=$1 OR p.name=$1) AND w.slug IN (${ph})`,
          [req.query.project, ...refs]);
        links = rows;
      }
      // 連到還不存在的 slug 不是錯誤——那是「這裡該有一則但還沒寫」的記號，照樣回報讓人看得到缺口。
      const missing = refs.filter(s => !links.some(l => l.slug === s));
      res.json({ ok: true, ...page, links, missing_links: missing });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
}

module.exports = { registerRoutes };
