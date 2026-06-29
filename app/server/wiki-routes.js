const { query } = require('./db');
const { verifyToken } = require('./auth');
const { initProjectWiki, refreshWikiNode } = require('./pipeline/library-agent');

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
      const { rows } = await query(
        'DELETE FROM wiki_pages WHERE project_id = $1 AND slug = $2 RETURNING id',
        [req.params.projectId, req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
