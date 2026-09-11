/**
 * docs-routes.js — 讓平台管理員在平台裡看不進版控的 docs/ 文件（目前只有產品化規格頁）
 *
 * 規格頁是內部規劃文件，而平台 repo 是公開的，所以檔案放在
 * .gitignore 內的 docs/，由這支讀出來只回給平台管理員。刻意不走 express.static：靜態目錄不驗登入。
 * 目錄在請求當下才讀 DOCS_DIR（rules/infra 122），未設定時是 repo 根目錄的 docs/。
 */
const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function docsDir() {
  return process.env.DOCS_DIR || path.join(__dirname, '..', '..', 'docs');
}

function registerRoutes(app) {
  app.get('/api/docs/saas-specs', verifyToken, requireAdmin, (req, res) => {
    let html;
    try {
      html = fs.readFileSync(path.join(docsDir(), 'odoo-v2-saas-specs.html'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: '規格頁尚未產生' });
      return res.status(500).json({ error: err.message });
    }
    res.type('html').send(html);
  });
}

module.exports = { registerRoutes };
