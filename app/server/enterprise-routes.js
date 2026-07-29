const { query } = require('./db');
const { verifyToken } = require('./auth');
const { majorDigits } = require('./lib/docker-env');
const { buildGitEnv } = require('./lib/git-identity');
const enterpriseSources = require('./lib/enterprise-sources');

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function registerRoutes(app) {
  const auth = [verifyToken, requireAdmin];

  app.get('/api/admin/enterprise-sources', auth, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT odoo_version, repo_url, branch, local_path, clone_status, error_msg, last_synced_at
           FROM enterprise_sources ORDER BY odoo_version`
      );
      res.json({ sources: rows, base_dir: enterpriseSources.ENTERPRISE_BASE_DIR });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 登記／更新某大版本的來源。版本一律正規化成大版本數字（'17.0' → '17'），與掛載時的查法對齊，
  // 否則會出現「登記 17.0、掛載查 17」查無來源、卻看不出哪裡錯的狀況。
  app.put('/api/admin/enterprise-sources/:version', auth, async (req, res) => {
    try {
      const major = majorDigits(req.params.version);
      if (!major) return res.status(400).json({ error: '版本格式不正確（例：17 或 17.0）' });
      const repoUrl = (req.body?.repo_url || '').trim();
      if (!repoUrl) return res.status(400).json({ error: '請填 Git repo URL' });
      // 與 project-routes triggerClone 相同的 URL scheme 白名單：擋掉會讓 git 讀本機檔案的輸入
      if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(repoUrl)) {
        return res.status(400).json({ error: '不支援的 Git URL 格式' });
      }
      const branch = (req.body?.branch || '').trim() || null;
      await query(
        `INSERT INTO enterprise_sources (odoo_version, repo_url, branch, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (odoo_version) DO UPDATE SET repo_url=$2, branch=$3, updated_at=NOW()`,
        [major, repoUrl, branch]
      );
      res.json({ ok: true, odoo_version: major });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 同步走背景：enterprise repo 動輒數百 MB，clone 要好幾分鐘，同步等於讓 HTTP 請求掛著到逾時。
  // 進度與結果都落在 enterprise_sources.clone_status／error_msg，前端輪詢 GET 取得。
  app.post('/api/admin/enterprise-sources/:version/sync', auth, async (req, res) => {
    try {
      const major = majorDigits(req.params.version);
      if (!major) return res.status(400).json({ error: '版本格式不正確（例：17 或 17.0）' });
      const { rows } = await query('SELECT clone_status, updated_at FROM enterprise_sources WHERE odoo_version=$1', [major]);
      if (!rows.length) return res.status(404).json({ error: `Odoo ${major} 的企業版來源尚未設定` });
      // 併發保護：前端按鈕在 202 回應後立刻恢復可按，畫面要等 3 秒後那次輪詢才顯示「同步中」，
      // 空窗期很容易被按第二次；同一目錄兩個 git 同時操作可能撞 index.lock，最終由後完成者
      // 決定 clone_status，可能出現「狀態 done、目錄其實半套」。逾時條件必要：server 若在
      // 同步中途重啟，狀態會永遠停在 syncing，無條件擋會變成永久鎖死、再也無法重試。
      const src = rows[0];
      const syncingRecently = src.clone_status === 'syncing'
        && new Date(src.updated_at).getTime() > Date.now() - 30 * 60 * 1000;
      if (syncingRecently) return res.status(409).json({ error: '同步進行中，請稍候再試' });
      let gitEnv;
      try {
        gitEnv = await buildGitEnv(req.userId);
      } catch (e) {
        if (e.code === 'NO_GIT_CRED') return res.status(400).json({ error: '請先到設定填個人 GitHub PAT（私有 enterprise repo 需要）' });
        throw e;
      }
      enterpriseSources.syncSource(major, gitEnv).catch(() => { /* 失敗已寫進 clone_status/error_msg */ });
      res.status(202).json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 只移除登記，不刪本地目錄：正在跑的容器已掛著該目錄，砍掉會讓運行中的測試區當場壞掉。
  // 移除後下次建置會由 resolveEnterprisePath fail loud 擋下。
  app.delete('/api/admin/enterprise-sources/:version', auth, async (req, res) => {
    try {
      const major = majorDigits(req.params.version);
      if (!major) return res.status(400).json({ error: '版本格式不正確（例：17 或 17.0）' });
      await query('DELETE FROM enterprise_sources WHERE odoo_version=$1', [major]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
