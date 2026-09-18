// 自動部署的 HTTP 介面。
//
// 授權比其他專案端點嚴一級，刻意的：這些端點會 SSH 進客戶的正式機下指令，
// 而此 repo 沒有 project_members 表、專案共享是既有設計（12 個 project 端點有 11 個只驗
// token）。沒有「專案擁有者」可以檢查，所以退而求其次全部限 admin——總開關本來就在
// admin 設定頁裡，兩者一致。代價：非 admin 的專案負責人按不了部署，是已知取捨。
//
// requireAutoDeploy 另外擋總開關——前端隱藏分頁不是授權，使用者照樣打得到 API。
// 所有查詢都帶 project_id 條件，跨專案隔離要端點自己做。
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { requireAutoDeploy } = require('./lib/auto-deploy-switch');

// 比照 admin-routes／feedback-routes 的既有寫法（該檔未匯出，兩處已各自定義一份）
async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}
const { runProbe } = require('./lib/deploy-probe');
const { validatePath } = require('./lib/ssh-exec');
const { withProjectLock } = require('./pipeline/project-lock');

const TARGET_COLS = `id, project_id, repo_id, env, conn_id, runtime, compose_dir, compose_service,
       service_name, container_name, addons_dir, conf_path, db_name, http_port,
       modules, branch, sudo_mode, enabled, last_deployed_sha, last_probe_at, odoo_bin`;

// 外鍵歸屬檢查。此 repo 沒有 project_members 表、專案端點多半只驗 token，
// 所以「這個 id 屬不屬於這個專案」一定要端點自己驗——漏掉就能幫 A 專案建一個指向
// B 專案 SSH 連線的部署目標，把 A 的碼部署到 B 客戶的機器上。
async function belongsToProject(table, id, projectId) {
  const { rows } = await query(`SELECT id FROM ${table} WHERE id = $1 AND project_id = $2`, [id, projectId]);
  return rows.length > 0;
}

// 同一個專案裡，測試區與正式區不可以指向同一個資料庫——那等於拿 ai 分支的碼去升級客戶
// 正在用的資料。這不是假想：評估是「用哪條連線掃，掃到的每個 instance 就套那條連線的
// db_name」，一條連線掃到兩個 instance 時兩個候選拿到同一個名字（慈雲 2026-09-18 兩個目標
// 都被填成正式的 ciyun，而當時下拉只列得出那一個，人想改也改不了）。
// 回傳撞到的那一區，沒撞到回 null。
async function dbTakenByOtherEnv(projectId, env, dbName, excludeId) {
  const { rows } = await query(
    `SELECT env FROM project_deploy_targets
      WHERE project_id = $1 AND env <> $2 AND db_name = $3 AND id <> $4`,
    [projectId, env, dbName, excludeId || 0]
  );
  return rows.length ? rows[0].env : null;
}

const dbClashError = (otherEnv) =>
  `這個資料庫已經是${otherEnv === 'prod' ? '正式' : '測試'}區目標在用的，`
  + '測試區與正式區不能升級同一個資料庫。請先核對這個 instance 實際服務的是哪一個 DB。';

// 來源分支不讓前端指定：填死的 ai-dev／main 對 base_branch 不是 main 的專案是錯的——
// 遠端的 ai 分支可能叫 ai-dev-odoo15、主分支可能叫 develop，兩者都由 repo 自己算得出來。
// 算不出來（尚未 clone、git 指令失敗）就退回舊的預設值，不擋住建立。
async function resolveBranch(repoId, env) {
  const fallback = env === 'prod' ? 'main' : 'ai-dev';
  try {
    const { rows: [repo] } = await query('SELECT local_path FROM project_repos WHERE id = $1', [repoId]);
    if (!repo || !repo.local_path) return fallback;
    const git = require('./pipeline/git');
    const b = env === 'prod' ? await git.getMainBranch(repo.local_path) : await git.remoteAiRef(repo.local_path);
    return b || fallback;
  } catch { return fallback; }
}

function registerRoutes(app) {
  const guard = [verifyToken, requireAdmin, requireAutoDeploy];

  app.get('/api/projects/:id/deploy-targets', guard, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT ${TARGET_COLS} FROM project_deploy_targets WHERE project_id = $1 ORDER BY env, id`,
        [req.params.id]
      );
      // 部署紀錄筆數分開查再併：相關子查詢在 pg-mem 跑不動（rules/testing.md #14），
      // 而這個數字是刪除前的二次確認要用的（deploy_runs 帶 CASCADE，會一起消失）。
      const { rows: cs } = await query(
        `SELECT r.target_id, COUNT(*)::int AS c FROM deploy_runs r
         JOIN project_deploy_targets t ON t.id = r.target_id
         WHERE t.project_id = $1 GROUP BY r.target_id`, [req.params.id]
      );
      const counts = new Map(cs.map(c => [Number(c.target_id), Number(c.c)]));
      res.json({ targets: rows.map(r => ({ ...r, run_count: counts.get(r.id) || 0 })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/deploy-probe', guard, async (req, res) => {
    try {
      const connId = Number(req.body && req.body.conn_id);
      if (!connId) return res.status(400).json({ error: '缺少 conn_id' });
      // 探測會連進客戶機，連線必須屬於這個專案才准跑
      if (!await belongsToProject('db_connections', connId, req.params.id)) {
        return res.status(404).json({ error: '找不到這筆連線設定' });
      }
      res.json(await runProbe(connId, Number(req.params.id)));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/deploy-targets', guard, async (req, res) => {
    try {
      const b = req.body || {};
      if (!['test', 'prod'].includes(b.env)) return res.status(400).json({ error: 'env 只能是 test 或 prod' });
      if (!b.runtime) return res.status(400).json({ error: '缺少 runtime' });
      if (!b.addons_dir || !b.db_name) return res.status(400).json({ error: '缺少必填欄位（addons_dir／db_name）' });
      // 兩個外鍵都必須屬於同一個專案，否則等於借用別的客戶的連線與 repo
      if (b.conn_id && !await belongsToProject('db_connections', b.conn_id, req.params.id)) {
        return res.status(400).json({ error: 'conn_id 不屬於此專案' });
      }
      if (b.repo_id && !await belongsToProject('project_repos', b.repo_id, req.params.id)) {
        return res.status(400).json({ error: 'repo_id 不屬於此專案' });
      }
      // repo_id 是部署的碼從哪來。少了它 deploy-run 的 headSha 第一步就拋
      // 「這個部署目標沒有對應的 repo」——目標存得下去、按部署必定失敗。
      if (!b.repo_id) return res.status(400).json({ error: '缺少 repo_id（要從哪個 repo 拿碼部署）' });
      const clash = await dbTakenByOtherEnv(req.params.id, b.env, String(b.db_name).trim(), 0);
      if (clash) return res.status(400).json({ error: dbClashError(clash) });
      // 這一欄會原封不動進客戶正式機的 shell，存進來之前就要擋掉——等到部署當下才由
      // buildUpgradeCmd 拋，使用者看到的會是一次失敗的部署而不是一則存檔錯誤。
      // 沒帶就從同一份 payload 的探測結果補：使用者的分頁可能是平台更新前開的（載到舊畫面
      // 程式，根本沒有這個欄位），而少了它 systemd 目標的部署必定 command not found。
      const probeBin = b.probe_json && b.probe_json.candidate && b.probe_json.candidate.odooBin;
      const odooBin = String(b.odoo_bin || probeBin || '').trim();
      if (odooBin && !validatePath(odooBin)) {
        return res.status(400).json({ error: 'odoo 執行檔要填絕對路徑（例：/odoo/odoo-server/odoo-bin）' });
      }
      const branch = await resolveBranch(b.repo_id, b.env);
      const { rows } = await query(
        `INSERT INTO project_deploy_targets
           (project_id, repo_id, env, conn_id, runtime, compose_dir, compose_service, service_name,
            container_name, addons_dir, conf_path, db_name, http_port, modules, branch, sudo_mode,
            enabled, last_probe_at, probe_json, odoo_bin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18,$19)
         RETURNING id`,
        [req.params.id, b.repo_id || null, b.env, b.conn_id || null, b.runtime,
         b.compose_dir || null, b.compose_service || null, b.service_name || null,
         b.container_name || null, b.addons_dir, b.conf_path || null, b.db_name,
         b.http_port || null, Array.isArray(b.modules) ? b.modules : [], branch,
         b.sudo_mode || 'none',
         // 新建一律不自動啟用，要人再按一次——這個功能會動客戶的機器
         b.enabled === true, b.probe_json || null, odooBin || null]
      );
      res.json({ ok: true, id: rows[0].id, branch });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/projects/:id/deploy-targets/:tid', guard, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: [cur] } = await query(
        'SELECT * FROM project_deploy_targets WHERE id = $1 AND project_id = $2',
        [req.params.tid, req.params.id]
      );
      if (!cur) return res.status(404).json({ error: '找不到部署目標' });

      // 只切開關（既有前端與測試走這條）
      if (typeof b.enabled === 'boolean' && Object.keys(b).length === 1) {
        // 啟用是「開始真的動客戶機」的那一刻，撞庫的目標要在這裡擋下來。存檔時擋過一次仍
        // 不夠：舊的目標是在這道檢查之前存的，它們只會在這裡露出來。
        if (b.enabled) {
          const c = await dbTakenByOtherEnv(req.params.id, cur.env, cur.db_name, cur.id);
          if (c) return res.status(400).json({ error: dbClashError(c) });
        }
        const { rows } = await query(
          `UPDATE project_deploy_targets SET enabled = $1, updated_at = NOW()
           WHERE id = $2 AND project_id = $3 RETURNING id, enabled`,
          [b.enabled, req.params.tid, req.params.id]
        );
        return res.json({ ok: true, enabled: rows[0].enabled });
      }

      // runtime／容器名／compose 定址是探測出來的事實，不開放手改——改了就與客戶機對不上，
      // 而且部署當下才會炸。要換 instance 就重新評估、存一筆新的。
      const FORBIDDEN = ['runtime', 'container_name', 'compose_service', 'compose_dir', 'service_name'];
      const bad = FORBIDDEN.filter(k => k in b);
      if (bad.length) {
        return res.status(400).json({ error: `${bad.join('／')} 是探測結果，不能手改。要換 instance 請重新評估。` });
      }
      if ('env' in b && !['test', 'prod'].includes(b.env)) {
        return res.status(400).json({ error: 'env 只能是 test 或 prod' });
      }
      if ('conn_id' in b && b.conn_id && !await belongsToProject('db_connections', b.conn_id, req.params.id)) {
        return res.status(400).json({ error: 'conn_id 不屬於此專案' });
      }
      if ('repo_id' in b && b.repo_id && !await belongsToProject('project_repos', b.repo_id, req.params.id)) {
        return res.status(400).json({ error: 'repo_id 不屬於此專案' });
      }

      const next = {
        env: 'env' in b ? b.env : cur.env,
        repo_id: 'repo_id' in b ? (b.repo_id || null) : cur.repo_id,
        conn_id: 'conn_id' in b ? (b.conn_id || null) : cur.conn_id,
        addons_dir: 'addons_dir' in b ? String(b.addons_dir || '').trim() : cur.addons_dir,
        conf_path: 'conf_path' in b ? (String(b.conf_path || '').trim() || null) : cur.conf_path,
        db_name: 'db_name' in b ? String(b.db_name || '').trim() : cur.db_name,
        http_port: 'http_port' in b ? (b.http_port || null) : cur.http_port,
        odoo_bin: 'odoo_bin' in b ? (String(b.odoo_bin || '').trim() || null) : cur.odoo_bin,
        modules: Array.isArray(b.modules) ? b.modules : cur.modules,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
      };
      if (!next.addons_dir || !next.db_name) return res.status(400).json({ error: '缺少必填欄位（addons_dir／db_name）' });
      if (!next.repo_id) return res.status(400).json({ error: '缺少 repo_id（要從哪個 repo 拿碼部署）' });
      if (next.odoo_bin && !validatePath(next.odoo_bin)) {
        return res.status(400).json({ error: 'odoo 執行檔要填絕對路徑（例：/odoo/odoo-server/odoo-bin）' });
      }
      // 改到資料庫或環境，以及啟用，都要重驗一次撞庫
      if (next.db_name !== cur.db_name || next.env !== cur.env || (next.enabled && !cur.enabled)) {
        const c = await dbTakenByOtherEnv(req.params.id, next.env, next.db_name, cur.id);
        if (c) return res.status(400).json({ error: dbClashError(c) });
      }

      // 環境或 repo 換了，來源分支必須跟著重推——否則正式區會繼續吃測試分支的碼
      const branch = (next.env !== cur.env || next.repo_id !== cur.repo_id)
        ? await resolveBranch(next.repo_id, next.env)
        : cur.branch;

      // 改到會影響「部署什麼、部署到哪」的欄位就清掉 last_deployed_sha：那個 sha 是
      // 「上次送到這個目標的版本」，換了資料庫或目錄之後它描述的已經是別的地方，
      // 留著會讓下一次部署只送 diff，於是新目標永遠拿不到完整的碼。
      const moved = next.addons_dir !== cur.addons_dir || next.db_name !== cur.db_name
        || next.conn_id !== cur.conn_id || branch !== cur.branch;

      const { rows } = await query(
        `UPDATE project_deploy_targets
           SET env=$1, repo_id=$2, conn_id=$3, addons_dir=$4, conf_path=$5, db_name=$6,
               http_port=$7, modules=$8, enabled=$9, branch=$10, odoo_bin=$14,
               last_deployed_sha = CASE WHEN $11 THEN NULL ELSE last_deployed_sha END,
               updated_at = NOW()
         WHERE id=$12 AND project_id=$13
         RETURNING ${TARGET_COLS}`,
        [next.env, next.repo_id, next.conn_id, next.addons_dir, next.conf_path, next.db_name,
         next.http_port, next.modules, next.enabled, branch, moved, req.params.tid, req.params.id,
         next.odoo_bin]
      );
      res.json({ ok: true, target: rows[0], branch, resetSha: moved });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/deploy-targets/:tid', guard, async (req, res) => {
    try {
      const { rows: [t] } = await query(
        'SELECT id, enabled FROM project_deploy_targets WHERE id = $1 AND project_id = $2',
        [req.params.tid, req.params.id]
      );
      if (!t) return res.status(404).json({ error: '找不到部署目標' });
      // 啟用中的不給刪：手滑刪掉一個正在自動部署的目標，之後沒有任何徵狀——
      // 客戶那台就是靜靜地停在舊版。要刪先停用，多按一次是刻意的。
      if (t.enabled) return res.status(400).json({ error: '請先停用再刪除' });
      // deploy_runs 帶 ON DELETE CASCADE，部署歷史會跟著消失，所以先數給前端確認用
      const { rows: [n] } = await query('SELECT COUNT(*)::int AS c FROM deploy_runs WHERE target_id = $1', [t.id]);
      await query('DELETE FROM project_deploy_targets WHERE id = $1 AND project_id = $2',
        [req.params.tid, req.params.id]);
      res.json({ ok: true, deletedRuns: n.c });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/deploy-targets/:tid/deploy', guard, async (req, res) => {
    try {
      const { rows: [t] } = await query(
        'SELECT id, env FROM project_deploy_targets WHERE id = $1 AND project_id = $2',
        [req.params.tid, req.params.id]
      );
      if (!t) return res.status(404).json({ error: '找不到部署目標' });
      // 正式區不可逆：失敗只還原檔案，資料庫的改動留在原地。少了這道確認，
      // 誤點一下就直接動到客戶正在用的系統。
      if (t.env === 'prod' && req.body.confirm !== true) {
        return res.status(400).json({ error: '正式區部署需要明確確認（confirm）' });
      }
      const { runDeploy } = require('./lib/deploy-run');
      // 與 pipeline 對同一個主 clone 的 git 操作互斥：部署要 fetch／archive，
      // 同時有人在 merge 會拿到半套狀態
      const r = await withProjectLock(Number(req.params.id), () =>
        runDeploy(t.id, { trigger: t.env === 'prod' ? 'manual_prod' : 'manual_retry', userId: req.userId })
      );
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/projects/:id/deploy-runs', guard, async (req, res) => {
    try {
      const params = [req.params.id];
      let where = 'WHERE t.project_id = $1';
      if (req.query.target_id) { params.push(req.query.target_id); where += ` AND r.target_id = $${params.length}`; }
      const { rows } = await query(
        `SELECT r.id, r.target_id, r.task_id, r.triggered_by, r.trigger, r.from_sha, r.to_sha,
                r.modules, r.status, r.log, r.started_at, r.finished_at, t.env
           FROM deploy_runs r
           JOIN project_deploy_targets t ON t.id = r.target_id
          ${where}
          ORDER BY r.id DESC LIMIT 50`,
        params
      );
      res.json({ runs: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
