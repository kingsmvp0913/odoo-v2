const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query, withTransaction } = require('./db');
const { verifyToken } = require('./auth');
const { runGraphify } = require('./pipeline/graphify-runner');
const { ensureTestingBranch, ensureMainBranch, pullBranch, ensureAiBranch, syncMainIntoAi, abortMerge, releaseAiToMain, getMainBranch, listRemoteBranches, setRemoteHead } = require('./pipeline/git');
const { withProjectLock } = require('./pipeline/project-lock');
const { buildGitEnv } = require('./lib/git-identity');
const { deleteTaskDir } = require('./lib/attachments');

const REPOS_BASE = process.env.REPOS_BASE_DIR || path.resolve(__dirname, '..', '..', 'repos');

// 明列欄位，不用 SELECT */RETURNING *：projects 已存了 vpn_config_enc／vpn_username／vpn_password_enc
// （VPN 憑證密文），這些路由給一般已登入使用者，密文外流一樣是機密外洩。VPN 狀態改走專屬的
// GET /api/projects/:id/vpn（只回 has_config/vpn_username），這裡完全不帶三個 vpn_* 欄位。
const PROJECT_PUBLIC_COLS = 'id, name, odoo_version, description, created_at, updated_at, folder_name, port, odoo_project_name, service_respondent_name, e2e_disabled, edition';

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function slugify(s) {
  return (s || 'repo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

// 企業版與社群版差在「測試區掛不掛 enterprise addons」。值域在 API 邊界擋，否則怪值要到建置測試區
// 那一刻才炸，而且錯誤訊息指不回這裡。
const EDITIONS = ['community', 'enterprise'];

// 來源對應欄位以「一行一個名稱」儲存
function parseSourceNames(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// 找出 text 中的名稱已被「其他專案」用於同一個對應欄位的衝突（防止同一來源名綁到多個專案）
async function findMappingConflicts(column, text, excludeId) {
  const names = parseSourceNames(text);
  if (!names.length) return [];
  const { rows } = await query(
    `SELECT name, ${column} AS names FROM projects WHERE ${column} IS NOT NULL AND id <> $1`,
    [excludeId]
  );
  const conflicts = [];
  for (const r of rows) {
    const used = new Set(parseSourceNames(r.names));
    for (const n of names) {
      if (used.has(n)) conflicts.push({ name: n, project: r.name });
    }
  }
  return conflicts;
}

function computeDestPath(projectFolder, label) {
  return path.join(REPOS_BASE, slugify(projectFolder), slugify(label));
}

// 全新 clone 取發起人 gitEnv：有設 PAT 就帶（私有 repo 靠它認證），沒設就回 undefined 退機器憑證。
// 有別於「更新既有 clone」的硬性擋 PAT——初次 clone 不想因某人沒設 PAT 就完全無法加 repo（public repo 仍可）。
async function optionalGitEnv(userId) {
  try { return await buildGitEnv(userId); }
  catch (e) { if (e.code === 'NO_GIT_CRED') return undefined; throw e; }
}

function triggerClone(projectId, repoId, repoUrl, destPath, gitEnv, userId) {
  // projectId 來自 req.params.id（字串）；pipeline 的 withProjectLock 用 DB 數字 project_id 當 key。
  // Map key 字串≠數字會讓「更新 repo」與 pipeline 的 git 操作不互斥——coerce 成數字才真正序列化，
  // 否則 updateMainClone 內的 testing reset --hard 可能與 deploy/merge 併發壞掉共用主 clone。
  projectId = Number(projectId);
  // Security: validate URL scheme to prevent injection
  if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(repoUrl)) {
    query(
      'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
      [repoId, 'error', '不支援的 Git URL 格式']
    ).catch(() => {});
    return;
  }

  const isAlreadyCloned = fs.existsSync(path.join(destPath, '.git'));
  if (isAlreadyCloned) {
    // 更新既有主 clone：包 withProjectLock 與 pipeline 對同一主 clone 的 git 操作序列化。
    // 不能用 bare `git pull`——主 clone 常駐無 upstream 的 testing 分支，會報「no tracking information」。
    withProjectLock(projectId, () => updateMainClone(repoId, destPath, gitEnv, projectId, userId)).catch(() => {});
    return;
  }

  try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); } catch {}
  // 初次 clone 帶發起人 PAT（私有 repo 靠它認證，機器上無憑證時才 clone 得動）；
  // 未設 PAT 時 gitEnv 為 undefined → 不注入 env、沿用機器憑證（public repo／機器帳號情境不變）。
  const cloneOpts = { timeout: 300000 };
  if (gitEnv) cloneOpts.env = { ...process.env, ...gitEnv };
  execFile('git', ['clone', '--', repoUrl, destPath], cloneOpts, async (err, _stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message || 'clone failed').slice(0, 500);
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
        [repoId, 'error', msg]
      ).catch(() => {});
    } else {
      // 重新套用使用者指定的主分支：clone 一律照遠端 HEAD 設 origin/HEAD，不補這步，換 URL／重 clone
      // 之後設定就被靜默洗掉（畫面仍顯示 develop，實際已回到 main）。排在 ensureTestingBranch 之前，
      // 讓後續所有以主分支為基準的操作都吃到正確答案。
      const { rows: [cfg] } = await query('SELECT base_branch FROM project_repos WHERE id=$1', [repoId]).catch(() => ({ rows: [] }));
      if (cfg?.base_branch) await setRemoteHead(destPath, cfg.base_branch).catch(() => {});
      // 主 clone 常駐 testing 分支（GitLab Flow 環境分支，測試環境 addons 來源）
      try { await ensureTestingBranch(destPath); } catch { /* 不擋 clone 完成 */ }
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=NULL WHERE id=$1',
        [repoId, 'done']
      ).catch(() => {});
      runGraphify(repoId, destPath);
    }
  });
}

// 更新既有主 clone：checkout 主分支 + git pull origin <main>，再把 main 的新 commit 帶進 ai-dev，
// 最後把 testing 重長到最新 ai-dev（測試環境 addons 來源分支）。
// 少了中間那步，使用者 push 進 main 的依賴修正（如缺的 module）會傳不到測試環境——
// testing 是以 ai-dev 為基準重建的，main 不在那條線上。
async function updateMainClone(repoId, destPath, gitEnv, projectId, userId) {
  try {
    const base = await ensureMainBranch(destPath, gitEnv); // checkout main/master（僅遠端則建本地追蹤分支）
    await pullBranch(destPath, base, gitEnv);              // git pull origin <base>
    await ensureAiBranch(destPath, gitEnv);
    const sync = await syncMainIntoAi(destPath, gitEnv);
    if (sync.hasConflicts) {
      // 此處不綁任何任務，沒有裁決 UI 可用。abort 還原讓 ai-dev 維持原狀並 fail loud。
      // 訊息只留「去 GitHub 合併」這條：外層 catch 會把 repo 標成 clone_status='error'，而全平台
      // 撈 repo 一律 WHERE clone_status='done'——repo 一旦是 error 就從 pipeline 消失，「開一張任務
      // 處理」保證撈到 0 個 repo、approve 直接 400，那是條死路，不能寫進指示裡。
      await abortMerge(destPath);
      throw new Error(`main → ai-dev 同步衝突（${sync.conflictFiles.join(', ')}），請先在 GitHub 上把 ai-dev 合併回 main 再更新`);
    }
    // 先回寫 done 再重建 testing，順序不可倒：doRebuild 撈 repo 帶 `WHERE clone_status='done'`，
    // 而 reclone 端點進來就把本 repo 標成 'cloning'——先重建的話它撈到 0 個 repo、直接 return null
    // （＝乾淨完成），testing 永遠不會被重長，連下面那道 fail-loud 都不會觸發。
    // 提早回寫不會讓 pipeline 插隊：整段仍在 triggerClone 的 withProjectLock 內，pipeline 的
    // git 操作拿不到鎖。此刻 pull 與 main→ai-dev 同步都已成功，這個 clone 本來就已經是 done。
    await query(
      'UPDATE project_repos SET clone_status=$2, clone_error=NULL WHERE id=$1',
      [repoId, 'done']
    );
    // 已在 triggerClone 的 withProjectLock 內 → 用無鎖版避免重入死鎖。
    if (projectId) {
      const { rebuildTestingWithinLock } = require('./pipeline/rebuild-testing');
      // 別靜默吞掉重建結果：resetTestingToAiBranch 失敗會回警告字串（doRebuild 內部已還原備份），
      // 吞掉會讓「testing 沒跟上 main」查無可查——落 server log 供診斷（fail loud）
      const warn = await rebuildTestingWithinLock(projectId, userId).catch(e => `testing 重建異常：${e.message}`);
      if (warn) console.warn(`[updateMainClone] repo ${repoId} testing 重建未乾淨：${warn}`);
    } else {
      try { await ensureTestingBranch(destPath); } catch { /* 回常駐分支失敗不擋更新完成 */ }
    }
    runGraphify(repoId, destPath);
  } catch (err) {
    const msg = (err.stderr || err.message || 'update failed').slice(0, 500);
    await query(
      'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
      [repoId, 'error', msg]
    ).catch(() => {});
  }
}

function registerRoutes(app) {
  // --- Projects ---

  app.get('/api/projects', verifyToken, async (req, res) => {
    try {
      const { rows: projects } = await query(`SELECT ${PROJECT_PUBLIC_COLS} FROM projects ORDER BY name ASC`);
      const { rows: counts } = await query('SELECT project_id, COUNT(*) AS cnt FROM project_repos GROUP BY project_id');
      const countMap = {};
      for (const c of counts) countMap[String(c.project_id)] = Number(c.cnt);
      const { rows: wikiCounts } = await query('SELECT project_id, COUNT(*) AS cnt FROM wiki_pages GROUP BY project_id');
      const wikiMap = {};
      for (const w of wikiCounts) wikiMap[String(w.project_id)] = Number(w.cnt);
      const { rows: unreadRows } = await query(
        `SELECT c.project_id, COUNT(m.id) AS unread
         FROM project_chats c
         LEFT JOIN project_chat_messages m
           ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
         WHERE c.user_id = $1
         GROUP BY c.project_id`,
        [req.userId]
      );
      const unreadMap = {};
      for (const u of unreadRows) unreadMap[String(u.project_id)] = Number(u.unread);
      const { rows: favRows } = await query(
        'SELECT project_id FROM project_favorites WHERE user_id = $1', [req.userId]
      );
      const favSet = new Set(favRows.map(f => f.project_id));
      res.json(projects.map(p => ({
        ...p,
        repo_count: countMap[String(p.id)] || 0,
        unread_count: unreadMap[String(p.id)] || 0,
        has_wiki: (wikiMap[String(p.id)] || 0) > 0,
        is_favorite: favSet.has(p.id)
      })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 我的最愛（per-user）：收藏／取消收藏。只動自己的 (user_id=req.userId)，故不需 admin 檢查（見 always.md rule 92）。
  app.post('/api/projects/:id/favorite', verifyToken, async (req, res) => {
    try {
      await query(
        'INSERT INTO project_favorites (user_id, project_id) VALUES ($1, $2) ON CONFLICT (user_id, project_id) DO NOTHING',
        [req.userId, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/favorite', verifyToken, async (req, res) => {
    try {
      await query('DELETE FROM project_favorites WHERE user_id = $1 AND project_id = $2', [req.userId, req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects', verifyToken, async (req, res) => {
    try {
      const { name, odoo_version, description, folder_name, edition } = req.body;
      if (!name || !odoo_version) return res.status(400).json({ error: 'name and odoo_version required' });
      if (edition !== undefined && !EDITIONS.includes(edition)) {
        return res.status(400).json({ error: 'edition 只能是 community 或 enterprise' });
      }
      // 測試埠不在此配發：已改為租約制，由 env-agent 於「啟動測試區」時向池借、停止時歸還
      // （見 port-alloc.js leasePort）。建立時就佔埠會讓沒開過測試區的專案白白吃掉併發槽。
      const { rows } = await query(
        // 新建專案預設關閉 E2E（e2e_disabled=true）；明確寫死於 INSERT 而非靠欄位 DEFAULT，
        // 因現有 DB 的欄位 DEFAULT 早已凍結成 false，改 schema 對現有機器無效。
        `INSERT INTO projects (name, odoo_version, description, folder_name, e2e_disabled, edition)
         VALUES ($1, $2, $3, $4, true, $5) RETURNING ${PROJECT_PUBLIC_COLS}`,
        [name, odoo_version, description || null, folder_name || null, edition || 'community']
      );
      return res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { rows: [project] } = await query(`SELECT ${PROJECT_PUBLIC_COLS} FROM projects WHERE id = $1`, [req.params.id]);
      if (!project) return res.status(404).json({ error: 'Not found' });
      const { rows: repos } = await query(
        'SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_primary DESC, label ASC',
        [req.params.id]
      );
      const { rows: [unreadRow] } = await query(
        `SELECT COUNT(m.id) AS unread
         FROM project_chats c
         LEFT JOIN project_chat_messages m
           ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
         WHERE c.project_id = $1 AND c.user_id = $2`,
        [req.params.id, req.userId]
      );
      const { rows: [wikiRow] } = await query(
        'SELECT COUNT(*) AS cnt FROM wiki_pages WHERE project_id = $1', [req.params.id]
      );
      res.json({ ...project, repos, unread_count: Number(unreadRow ? unreadRow.unread : 0), has_wiki: Number(wikiRow ? wikiRow.cnt : 0) > 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { name, odoo_version, description } = req.body;
      const { rows } = await query(
        `UPDATE projects SET
           name = COALESCE($2, name),
           odoo_version = COALESCE($3, odoo_version),
           description = COALESCE($4, description),
           updated_at = NOW()
         WHERE id = $1 RETURNING ${PROJECT_PUBLIC_COLS}`,
        [req.params.id, name || null, odoo_version || null, description || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 對應設定不掛 requireAdmin：一般使用者本來就能建專案／加 repo／建環境，
  // 唯獨這一步被擋會讓專案永遠收不到任務。刻意獨立成端點而非放寬既有 PATCH，
  // 避免 folder_name／e2e_disabled 這些高風險欄位跟著開放。
  app.patch('/api/projects/:id/mapping', verifyToken, async (req, res) => {
    try {
      const { odoo_project_name, service_respondent_name } = req.body;
      const conflicts = [];
      if ('odoo_project_name' in req.body) {
        conflicts.push(...await findMappingConflicts('odoo_project_name', odoo_project_name, req.params.id));
      }
      if ('service_respondent_name' in req.body) {
        conflicts.push(...await findMappingConflicts('service_respondent_name', service_respondent_name, req.params.id));
      }
      if (conflicts.length) {
        const msg = conflicts.map(c => `「${c.name}」已被專案「${c.project}」使用`).join('；');
        return res.status(409).json({ error: `來源對應名稱衝突：${msg}` });
      }
      const sets = [];
      const params = [req.params.id];
      const setDirect = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if ('odoo_project_name' in req.body) setDirect('odoo_project_name', odoo_project_name || null);
      if ('service_respondent_name' in req.body) setDirect('service_respondent_name', service_respondent_name || null);
      if (!sets.length) return res.status(400).json({ error: '未提供任何對應欄位' });
      sets.push('updated_at = NOW()');
      const { rows } = await query(
        `UPDATE projects SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PROJECT_PUBLIC_COLS}`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/projects/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { name, odoo_version, description, folder_name, odoo_project_name, service_respondent_name, e2e_disabled } = req.body;
      // 防重：來源對應名稱不可同時綁到多個專案
      const conflicts = [];
      if ('odoo_project_name' in req.body) {
        conflicts.push(...await findMappingConflicts('odoo_project_name', odoo_project_name, req.params.id));
      }
      if ('service_respondent_name' in req.body) {
        conflicts.push(...await findMappingConflicts('service_respondent_name', service_respondent_name, req.params.id));
      }
      if (conflicts.length) {
        const msg = conflicts.map(c => `「${c.name}」已被專案「${c.project}」使用`).join('；');
        return res.status(409).json({ error: `來源對應名稱衝突：${msg}` });
      }
      // 動態組 SET／params，佔位號永遠對齊實際引用（勿塞未被引用的參數——真・PostgreSQL 會報 bind 參數數不符）。
      const sets = [];
      const params = [req.params.id];
      // name/odoo_version/description/folder_name：COALESCE，未帶則保留現值（無法清空，符合現行語意）
      const setCoalesce = (col, val) => { params.push(val); sets.push(`${col} = COALESCE($${params.length}, ${col})`); };
      setCoalesce('name', name || null);
      setCoalesce('odoo_version', odoo_version || null);
      setCoalesce('description', description || null);
      setCoalesce('folder_name', folder_name || null);
      // 對應名稱：body 帶此鍵才更新，且用直接賦值（可用 null/空字串明確清空）；未帶則整欄不動
      const setDirect = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if ('odoo_project_name' in req.body) setDirect('odoo_project_name', odoo_project_name || null);
      if ('service_respondent_name' in req.body) setDirect('service_respondent_name', service_respondent_name || null);
      if ('e2e_disabled' in req.body) setDirect('e2e_disabled', !!e2e_disabled);
      if ('edition' in req.body) {
        if (!EDITIONS.includes(req.body.edition)) {
          return res.status(400).json({ error: 'edition 只能是 community 或 enterprise' });
        }
        setDirect('edition', req.body.edition);
      }
      sets.push('updated_at = NOW()');
      const { rows } = await query(
        `UPDATE projects SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PROJECT_PUBLIC_COLS}`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      // 順序是關鍵：可回滾的 DB 刪除先做完並 COMMIT，不可逆的實體刪除（測試環境、repo clone、
      // uploads 目錄）才動。反過來的話 DB 一失敗就留下「專案還在，但環境與 clone 已經消失」的
      // 破碎狀態，而且每按一次刪除就再破壞一次。
      //
      // 但清理需要的路徑必須「在交易之前」先抓：project_repos／odoo_envs 對 projects 都是
      // ON DELETE CASCADE，COMMIT 之後那些列就沒了，清理函式再去查只會查到空的，整個清理
      // 退化成 no-op（磁碟與容器全留著）。容器則在交易前就停——停容器是可逆的（可以再啟動），
      // 與「刪目錄不可逆」不是同一個層級，而 stopEnv 同樣得在 odoo_envs 還在時才做得到。
      const { snapshotProjectPaths, cleanupProjectEnv, stopEnv } = require('./pipeline/env-agent');
      const envSnapshot = await snapshotProjectPaths(req.params.id);
      await stopEnv(req.params.id).catch(() => {});

      const taskDbIds = await withTransaction(async (client) => {
        const { rows: taskRows } = await client.query(
          'SELECT id FROM tasks WHERE project_id = $1', [req.params.id]
        );
        const ids = taskRows.map(r => r.id);
        if (ids.length) {
          // 參照 tasks(id) 的 4 張子表全是裸的 REFERENCES、**沒有任何 ON DELETE CASCADE**
          // （原本的註解宣稱有，那是錯的），所以每一張都必須顯式刪：漏掉任一張都會讓下面
          // DELETE FROM tasks 撞 FK。task_attachments 還參照 task_messages(id)，必須排在
          // task_messages 之前。
          // token_usage 刻意不刪——計費／成本歷史跨任務保留，與單張任務刪除的既有決策一致
          // （見 tasks-routes.js 刪除端點那段「刻意不隨任務刪」的清單）。刪整個專案沒有理由
          // 比刪單張任務更慢殺。
          //
          // 用 `IN (SELECT ...)` 而不是 `= ANY($1::int[])`：後者在 pg-mem 上，只要目標欄位
          // 有索引就會靜默匹配 0 列（實測；無索引才正常），於是這些 DELETE 全變 no-op、
          // 測試永遠證明不了子列真的被清掉。順帶少一趟 round trip。
          await client.query('DELETE FROM task_attachments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [req.params.id]);
          await client.query('DELETE FROM task_events      WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [req.params.id]);
          await client.query('DELETE FROM task_logs        WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [req.params.id]);
          await client.query('DELETE FROM task_messages    WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [req.params.id]);
          await client.query('DELETE FROM tasks WHERE project_id = $1', [req.params.id]);
        }
        const { rows } = await client.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
        if (!rows.length) {
          const e = new Error('Not found');
          e.status = 404;   // 交易由 withTransaction 回滾；用狀態碼帶出「不存在」與真錯誤區分
          throw e;
        }
        return ids;
      });

      // ── 以下皆不可逆，只在 COMMIT 成功後執行 ──
      // 帶交易前取好的 snapshot：此刻 projects／project_repos／odoo_envs 的列都已被 cascade 刪掉，
      // 不傳的話 cleanupProjectEnv 會查到空的、什麼都不刪。
      await cleanupProjectEnv(req.params.id, envSnapshot); // 移除 env 目錄、各 repo clone 與整棵 .worktrees
      taskDbIds.forEach(id => deleteTaskDir(id));   // 各任務磁碟上的 uploads/task_<id>
      // 專案硬刪除後 port 釋放：同步 nginx map 移除該子網域（fire-and-forget；gate 未設＝no-op）。
      require('./lib/nginx-map').syncNginxMap().catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'Not found' });
      res.status(500).json({ error: err.message });
    }
  });

  // --- Repos ---

  app.get('/api/projects/:id/repos', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_primary DESC, label ASC',
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 主分支下拉的資料源：可選的遠端分支 + 目前生效的分支。clone 未完成時沒有 refs 可讀，回空清單
  // 讓前端顯示「clone 完成後才能選」，而不是報錯。
  app.get('/api/projects/:id/repos/:repoId/branches', verifyToken, async (req, res) => {
    try {
      const { rows: [repo] } = await query(
        'SELECT local_path, clone_status, base_branch FROM project_repos WHERE id=$1 AND project_id=$2',
        [req.params.repoId, req.params.id]
      );
      if (!repo) return res.status(404).json({ error: 'Not found' });
      if (repo.clone_status !== 'done') {
        return res.json({ branches: [], base_branch: repo.base_branch, effective: null, ready: false });
      }
      const branches = await listRemoteBranches(repo.local_path).catch(() => []);
      const effective = await getMainBranch(repo.local_path).catch(() => null);
      res.json({ branches, base_branch: repo.base_branch, effective, ready: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/repos', verifyToken, async (req, res) => {
    try {
      const { label, repo_url, is_primary } = req.body;
      if (!label || !repo_url) return res.status(400).json({ error: 'label and repo_url required' });

      const { rows: [project] } = await query('SELECT folder_name, name FROM projects WHERE id=$1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }

      const destPath = computeDestPath(project.folder_name || project.name, label);
      const { rows } = await query(
        `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
         VALUES ($1, $2, $3, $4, $5, 'cloning') RETURNING *`,
        [req.params.id, label, repo_url, destPath, is_primary || false]
      );
      triggerClone(req.params.id, rows[0].id, repo_url, destPath, await optionalGitEnv(req.userId), req.userId);
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'label already exists in this project' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id/repos/:repoId', verifyToken, async (req, res) => {
    try {
      const { label, repo_url, is_primary, base_branch } = req.body;

      const { rows: [existing] } = await query(
        'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2',
        [req.params.repoId, req.params.id]
      );
      if (!existing) return res.status(404).json({ error: 'Not found' });

      // 主分支覆寫：空字串／null＝改回自動偵測。指定值必須真的存在於遠端，否則 set-head 會失敗、
      // DB 與 origin/HEAD 從此不一致（畫面顯示已設定、實際仍用舊分支）——擋在寫入前才不會脫鉤。
      const baseBranchGiven = base_branch !== undefined;
      const nextBaseBranch = baseBranchGiven ? (base_branch || null) : existing.base_branch;
      if (baseBranchGiven && nextBaseBranch && existing.clone_status === 'done') {
        const avail = await listRemoteBranches(existing.local_path).catch(() => []);
        if (!avail.includes(nextBaseBranch)) {
          return res.status(400).json({ error: `遠端沒有分支 ${nextBaseBranch}` });
        }
      }

      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }

      const urlChanged = repo_url && repo_url !== existing.repo_url;
      let newLocalPath = existing.local_path;
      let newCloneStatus = existing.clone_status;

      if (urlChanged) {
        const { rows: [project] } = await query('SELECT folder_name, name FROM projects WHERE id=$1', [req.params.id]);
        newLocalPath = computeDestPath(project.folder_name || project.name, label || existing.label);
        newCloneStatus = 'cloning';
      }

      const { rows } = await query(
        `UPDATE project_repos SET
           label = COALESCE($3, label),
           repo_url = COALESCE($4, repo_url),
           local_path = $5,
           clone_status = $6,
           is_primary = COALESCE($7, is_primary),
           base_branch = $8
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [req.params.repoId, req.params.id, label || null, repo_url || null, newLocalPath, newCloneStatus, is_primary ?? null, nextBaseBranch]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });

      // 落到 origin/HEAD＝真正生效（getMainBranch 的第一順位）。改回自動偵測則用 -a 讓 git 重問遠端。
      // urlChanged 時跳過：clone 還沒跑完，等 triggerClone 完成後那段統一套用。
      if (baseBranchGiven && !urlChanged && existing.clone_status === 'done') {
        await setRemoteHead(existing.local_path, nextBaseBranch).catch(() => {});
      }

      if (urlChanged) {
        triggerClone(req.params.id, rows[0].id, rows[0].repo_url, newLocalPath, await optionalGitEnv(req.userId), req.userId);
      }
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/repos/:repoId', verifyToken, async (req, res) => {
    try {
      const { rows: [repo] } = await query(
        'SELECT clone_status, local_path FROM project_repos WHERE id=$1 AND project_id=$2',
        [req.params.repoId, req.params.id]
      );
      if (!repo) return res.status(404).json({ error: 'Not found' });
      // #2 clone/更新進行中不得移除
      if (repo.clone_status === 'cloning') {
        return res.status(409).json({ error: '正在 clone/更新中，請稍候再移除' });
      }
      // #1 測試環境使用中不得移除其掛載的 repo
      const { envIsActive } = require('./pipeline/env-agent');
      if (await envIsActive(req.params.id)) {
        return res.status(409).json({ error: '測試環境使用中，請先刪除測試環境再移除 repo' });
      }
      await query('DELETE FROM project_repos WHERE id = $1 AND project_id = $2', [req.params.repoId, req.params.id]);
      if (repo.local_path) {
        fs.rm(repo.local_path, { recursive: true, force: true }, () => {});
      }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/repos/:repoId/reclone', verifyToken, async (req, res) => {
    try {
      const { rows: [repo] } = await query(
        'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2',
        [req.params.repoId, req.params.id]
      );
      if (!repo) return res.status(404).json({ error: 'Not found' });
      if (!repo.local_path) return res.status(400).json({ error: 'No local_path set' });

      // 更新既有 clone 需用發起 user（reclone 按鈕操作者）的 PAT；無 PAT 直接擋下不進背景更新。
      // 全新 clone（.git 不在）則 best-effort：有 PAT 就帶（私有 repo 靠它），沒設退機器憑證。
      const isAlreadyCloned = fs.existsSync(path.join(repo.local_path, '.git'));
      let gitEnv;
      if (isAlreadyCloned) {
        try {
          gitEnv = await buildGitEnv(req.userId);
        } catch (e) {
          if (e.code === 'NO_GIT_CRED') return res.status(400).json({ error: '請先到設定填個人 GitHub PAT' });
          throw e;
        }
      } else {
        gitEnv = await optionalGitEnv(req.userId);
      }

      await query(
        "UPDATE project_repos SET clone_status='cloning', clone_error=NULL WHERE id=$1",
        [repo.id]
      );
      triggerClone(req.params.id, repo.id, repo.repo_url, repo.local_path, gitEnv, req.userId);
      res.json({ ok: true, cloning: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- 上正式（ai-dev → main）---

  // 待上正式＝已核准併進 ai-dev、但尚未被「上正式」按鈕推上 main 的任務。
  // 前端 TaskList 的「待上正式」篩選用同一份定義，兩處數字必然一致。
  const PENDING_RELEASE_SQL =
    `SELECT task_id, title, status, approved_at
     FROM tasks
     WHERE project_id = $1 AND approved_at IS NOT NULL AND merged_to_main_at IS NULL
     ORDER BY approved_at`;

  app.get('/api/projects/:id/pending-release', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(PENDING_RELEASE_SQL, [req.params.id]);
      res.json({ tasks: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/release', verifyToken, async (req, res) => {
    try {
      const { rows: [project] } = await query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'Not found' });

      // 推 main 用操作者本人的 PAT，歸屬才正確；沒設 PAT 就直接擋，不退機器憑證。
      let gitEnv;
      try {
        gitEnv = await buildGitEnv(req.userId);
      } catch (e) {
        if (e.code === 'NO_GIT_CRED') return res.status(400).json({ error: '請先到設定填個人 GitHub PAT' });
        throw e;
      }

      const { rows: repos } = await query(
        `SELECT id, label, local_path FROM project_repos
         WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL
         ORDER BY is_primary DESC, id`,
        [project.id]
      );
      if (!repos.length) return res.status(400).json({ error: '此專案沒有可用的 repo（clone 尚未完成）' });

      // 逐 repo 序列化，且與 pipeline 對同一主 clone 的 git 操作互斥。
      const results = await withProjectLock(Number(project.id), async () => {
        const out = [];
        for (const repo of repos) {
          try {
            out.push({ label: repo.label, ...(await releaseAiToMain(repo.local_path, gitEnv)) });
          } catch (err) {
            // git merge/push 的真正原因常寫在 stdout 而非 stderr，三者都收
            const detail = `${err.stderr || ''}${err.stdout || ''}` || err.message || 'git 操作失敗';
            out.push({ label: repo.label, merged: false, hasConflicts: false, conflictFiles: [], restoreFailed: false, error: detail.slice(0, 2000) });
          }
        }
        return out;
      });

      // 刻意在 git 操作之後才查清單並直接 UPDATE：使用者開著彈窗期間若有人 approve 了新任務，
      // 那張也會被這次 merge 推上 main，用開窗當下的舊清單標記會漏掉它。
      // 全部 repo 都成功、且至少有一個真的合了才標記——寧可下次多列幾張，也不要標了卻沒上去。
      const allOk = results.every(r => !r.error && !r.hasConflicts);
      const anyMerged = results.some(r => r.merged);
      let tasks = [];
      if (allOk && anyMerged) {
        const { rows } = await query(
          `UPDATE tasks SET merged_to_main_at = NOW()
           WHERE project_id = $1 AND approved_at IS NOT NULL AND merged_to_main_at IS NULL
           RETURNING task_id, title`,
          [project.id]
        );
        tasks = rows;
      }
      res.json({ ok: allOk, repos: results, tasks });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Task ↔ Project assignment ---

  app.put('/api/tasks/:taskDbId/project', verifyToken, async (req, res) => {
    try {
      const { project_id } = req.body;
      const { rows } = await query(
        'UPDATE tasks SET project_id = $2 WHERE id = $1 AND user_id = $3 RETURNING id, project_id',
        [req.params.taskDbId, project_id || null, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
