const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');

function _collectManifests(dir, results, limit) {
  if (results.length >= limit || !fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const manifestPath = path.join(dir, entry.name, '__manifest__.py');
      if (fs.existsSync(manifestPath)) {
        try {
          const content = fs.readFileSync(manifestPath, 'utf8').slice(0, 2000);
          results.push({ module: entry.name, content });
        } catch { /* skip unreadable */ }
      } else {
        _collectManifests(path.join(dir, entry.name), results, limit);
      }
    }
  }
}

function registerRoutes(app) {
  const base = '/api/projects/:projectId/wiki';

  app.get(base, verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, slug, title, updated_at FROM wiki_pages WHERE project_id = $1 ORDER BY title ASC',
        [req.params.projectId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post(`${base}/init`, verifyToken, async (req, res) => {
    try {
      const { rows: [project] } = await query('SELECT * FROM projects WHERE id=$1', [req.params.projectId]);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const { rows: readyRepos } = await query(
        "SELECT id, label, local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL",
        [req.params.projectId]
      );
      if (!readyRepos.length) {
        return res.status(400).json({ error: '尚未有已 clone 完成的 Repo，請先新增並等待 clone 完成' });
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: '未設定 ANTHROPIC_API_KEY' });
      }

      // 掃所有 done repo 的 __manifest__.py，最多取 15 個模組
      const manifests = [];
      for (const repo of readyRepos) {
        _collectManifests(repo.local_path, manifests, 15);
      }

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const prompt = `你是 Library Agent，負責為 Odoo 專案建立 wiki。
根據以下模組的 __manifest__.py 內容，產生一個「專案總覽」wiki 頁面。
回傳 JSON（不要其他文字）：{"slug":"overview","title":"專案總覽","content":"<Markdown 內容>"}

要求：
- content 用繁體中文說明各模組功能與用途
- 以 Markdown 格式，每個模組一個小節
- 只描述功能，不要複製原始程式碼

專案：${project.name}（Odoo ${project.odoo_version}）

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;

      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = msg.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse Library Agent response' });
      const page = JSON.parse(jsonMatch[0]);
      await query(
        `INSERT INTO wiki_pages (project_id, slug, title, content, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (project_id, slug) DO UPDATE SET title=$3, content=$4, updated_at=NOW()`,
        [req.params.projectId, page.slug, page.title, page.content || '']
      );
      res.json({ ok: true, slug: page.slug });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
