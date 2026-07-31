const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { safeReturnStatus } = require('./pipeline/stations');
const { runPipeline, getInflightTaskIds } = require('./pipeline/runner');

// approve 進行中的任務佔位：雙擊／前端重送會讓兩個請求都通過狀態檢查、都跑 mergeToAiBranch
// （第二個在分支已刪後失敗回假 500）。單行程 in-memory 佔位＋結尾條件更新雙防護。
const _approving = new Set();

// repo 在壓縮檔內的資料夾名＝git URL 最後一層去掉 .git（如 .../odoo17_hungjou.git → odoo17_hungjou）。
// 取不到 URL 時退回 clone 目錄名（local_path 最後一層）。
function repoDirName(repo) {
  const seg = String(repo.repo_url || '').replace(/\.git$/i, '').replace(/[\/\\]+$/, '').split(/[\/\\]/).pop();
  return seg || path.basename(repo.local_path);
}

function registerRoutes(app) {
  app.post('/api/pipeline/run', verifyToken, async (req, res) => {
    try {
      const result = await runPipeline(req.userId);
      res.json({ dispatched: result?.dispatched ?? 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pipeline/inflight', verifyToken, (req, res) => {
    res.json({ inflight: getInflightTaskIds() });
  });

  // 最終人工審核通過：把 task 分支併回 ai-dev、清理 worktree 與分支，轉入 wiki 更新
  app.post('/api/tasks/:id/approve', verifyToken, async (req, res) => {
    const approveKey = String(req.params.id);
    if (_approving.has(approveKey)) return res.status(409).json({ error: '審核通過處理中，請勿重複送出' });
    _approving.add(approveKey);
    try {
      const { rows } = await query(
        'SELECT id, task_id, status, git_branch, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const task = rows[0];
      if (task.status !== 'review_pending') {
        return res.status(400).json({ error: `Task status '${task.status}' cannot be approved; expected review_pending` });
      }
      if (!task.git_branch || !task.project_id) {
        return res.status(400).json({ error: '任務缺少分支或專案，無法合併' });
      }

      const { rows: repos } = await query(
        "SELECT local_path FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
        [task.project_id]
      );
      if (!repos.length) return res.status(400).json({ error: '專案未設定任何已完成 clone 的 Repo' });

      const path = require('path');
      const { mergeToAiBranch, deleteBranchLocal, removeWorktree } = require('./pipeline/git');
      const { withProjectLock } = require('./pipeline/project-lock');
      const { buildGitEnv } = require('./lib/git-identity');
      const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);

      // push 回 ai-dev 要歸屬到審核者（任務發起人）本人，非平台服務帳號
      let gitEnv;
      try {
        gitEnv = await buildGitEnv(req.userId);
      } catch (e) {
        if (e.code === 'NO_GIT_CRED') return res.status(400).json({ error: '請先到設定填個人 GitHub PAT' });
        throw e;
      }

      // 併主線＋清理 worktree 動到共用主 clone → 持專案鎖，與 merge/deploy/analysis 序列化（健檢 U7）
      await withProjectLock(task.project_id, async () => {
        // 逐 repo 併入 ai-dev（任一失敗即中止，狀態不變）
        for (const repo of repos) {
          await mergeToAiBranch(repo.local_path, task.git_branch, gitEnv);
        }
        // 清理各 repo 的 worktree 與任務分支（best-effort，不阻斷）
        for (const repo of repos) {
          const wtPath = path.join(wtParent, path.basename(repo.local_path));
          await removeWorktree(repo.local_path, wtPath).catch(() => {});
          await deleteBranchLocal(repo.local_path, task.git_branch).catch(() => {});
        }
      });

      // 條件更新（WHERE status）：佔位之外的第二道防線，狀態已被他處改動就不再覆寫
      const { rowCount } = await query(
        "UPDATE tasks SET status = 'wiki_updating', approved_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'review_pending'",
        [req.params.id]
      );
      if (rowCount) {
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '審核通過，已納入待上正式清單，正在更新文件')",
          [req.params.id]
        );
      }
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: '合併 ai-dev 失敗：' + err.message });
    } finally {
      _approving.delete(approveKey);
    }
  });

  // 最終人工審核退回：填原因 → 任務進 reject_triage 分診（不再直進 coding），原因落 task_rejections（健檢子專案 1）
  app.post('/api/tasks/:id/reject', verifyToken, async (req, res) => {
    try {
      const reason = ((req.body && req.body.reason) || '').trim();
      if (!reason) return res.status(400).json({ error: '請填寫退回原因' });
      const { rows } = await query(
        'SELECT id, task_id, status, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const task = rows[0];
      if (task.status !== 'review_pending') {
        return res.status(400).json({ error: `Task status '${task.status}' cannot be rejected; expected review_pending` });
      }
      // 回退回分診（reject_triage）：由 analysis-reject 判 bug/clarify/respec，不再瞎猜式直進 coding。
      // 不動 reentry_count：人工退回本身不是一次「退回 coding 的循環」，真正的循環由 reject_triage 判 fix→coding
      // 時經 bumpReentryOrStop 累加即可。若在此先 +1，會與下游 fix 的 +1 疊加，讓乾淨任務被退一次就撞總循環上限
      // 卡死（coding 一次都沒為修正重跑）。人工退回次數改由 task_rejections 統計，不與自動 runaway 斷路器共用計數。
      // 條件更新防雙擊：輸掉競態的請求不再重複落 log／task_rejections
      const { rowCount } = await query(
        "UPDATE tasks SET status='reject_triage', retry_feedback=$2, updated_at=NOW() WHERE id=$1 AND status='review_pending'",
        [req.params.id, `[人工退回]\n${reason}`]
      );
      if (!rowCount) return res.json({ ok: true });
      // 時間軸只落「[人工退回]」標記，不塞原因本文（審核者常整包貼錯誤 log，全灌進畫面沒意義）。
      // 完整原因仍在 retry_feedback（分診 agent 讀）與 task_rejections.reason（分類 agent 讀），
      // 使用者面的原因總結＋結論改由 reject-triage 的 AI 泡泡呈現。
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'system', '[人工退回]')",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ($1,$2,$3,$4,'new')",
        [task.task_id, task.project_id, req.userId, reason]
      );
      require('./notify').emitToUser(req.userId, 'task:updated', { taskId: task.id, status: 'reject_triage' });
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // MODE_B 規格審核閘門——確認沒問題：spec_review → branch_pending，續跑 pipeline 進 coding。
  app.post('/api/tasks/:id/spec-approve', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'spec_review') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' cannot be approved; expected spec_review` });
      }
      // 條件更新防雙擊：輸掉競態的請求不再重複推進
      const { rowCount } = await query(
        // 離開閘門＝這場規格問答結束，清掉續接用的 session（下次進來一定是全新的一場）
        "UPDATE tasks SET status = 'branch_pending', spec_session_id = NULL, spec_prompt_ver = NULL, updated_at = NOW() WHERE id = $1 AND status = 'spec_review'",
        [req.params.id]
      );
      if (rowCount) {
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '規格審核通過，開始實作')",
          [req.params.id]
        );
        require('./notify').emitToUser(req.userId, 'task:updated', { taskId: rows[0].id, status: 'branch_pending' });
      }
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // MODE_B 規格審核閘門——送出提問／修改意見：提問落 task_logs（role='user'）＝時間軸真相來源，
  // 轉 respec_running 由對話式 spec-review agent 讀對話判 answer/revise（回答或重產規格）後回 spec_review。
  app.post('/api/tasks/:id/spec-revise', verifyToken, async (req, res) => {
    try {
      const feedback = ((req.body && req.body.feedback) || '').trim();
      if (!feedback) return res.status(400).json({ error: '請填寫修改意見' });
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'spec_review') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' cannot be revised; expected spec_review` });
      }
      // 條件更新防雙擊：先搶到轉移權的請求才落地提問，避免 spec-review agent 讀到重複輸入
      const { rowCount } = await query(
        "UPDATE tasks SET status = 'respec_running', updated_at = NOW() WHERE id = $1 AND status = 'spec_review'",
        [req.params.id]
      );
      if (!rowCount) return res.json({ ok: true });
      // spec_review 一律 pre-coding：提問／修改意見落 task_logs（role='user'）＝時間軸與 spec-review agent 的對話真相來源。
      // 不再寫 task_messages（那是 mid-coding 途中追加需求的吸收管道，pre-coding 不共用，避免舊意見洩漏到 coding 階段被誤吸收）。
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, feedback]
      );
      require('./notify').emitToUser(req.userId, 'task:updated', { taskId: rows[0].id, status: 'respec_running' });
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 過渡期手動佈署：管理員下載本任務改動檔的 zip，自行解壓到正式區 addons。
  // 純打包——不動任務狀態、不合併分支、不推進 pipeline（審核仍走 approve）。
  // 壓縮檔內維持 <repo>/<repo 內原路徑> 結構，解壓後可直接覆蓋既有 addons 目錄。
  // 只放本任務真的改過的檔：worktree 自 analysis 起就凍結，整包模組會把切點當下的舊版一併送出。
  app.get('/api/tasks/:id/code-zip', verifyToken, async (req, res) => {
    try {
      const { rows: urows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (!urows.length || urows[0].role !== 'admin') {
        return res.status(403).json({ error: '僅管理員可下載程式碼' });
      }

      const { rows } = await query(
        'SELECT id, task_id, status, git_branch, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const task = rows[0];
      // 不限任務狀態：只要分支還在（未併回主線清除）就能打包——過渡期讓管理員隨時自行佈署。
      if (!task.git_branch || !task.project_id) {
        return res.status(400).json({ error: '任務尚無分支或專案，無可打包的程式' });
      }

      const { rows: repos } = await query(
        "SELECT local_path, repo_url FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
        [task.project_id]
      );
      if (!repos.length) return res.status(400).json({ error: '專案未設定任何已完成 clone 的 Repo' });

      const { AI_BRANCH, diffNameOnly, refExists } = require('./pipeline/git');
      const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);

      // 先把全部來源檔算完再開始輸出：header 一旦送出就改不回 JSON 錯誤，
      // 中途才失敗只會得到一個半截、解不開的 zip，且瀏覽器照樣顯示下載成功。
      const entries = []; // { zipPath, srcFile }
      const deleted = []; // 本任務刪除的檔（zip 表達不了刪除，只能請使用者手動移除）
      const stale = [];   // 切點之後 ai-dev 上也被改過的檔＝覆蓋上去會蓋掉別人的改動
      for (const repo of repos) {
        // 分支已清（多為已審核通過）→ 無 diff／worktree 可打包，略過該 repo
        if (!(await refExists(repo.local_path, `refs/heads/${task.git_branch}`))) continue;
        // diff 基底＝任務切點 ai-dev：用 main 會把其他已核准、尚未回流 main 的任務改動也打包進來
        const baseBranch = AI_BRANCH;
        const wtRepo = path.join(wtParent, path.basename(repo.local_path));
        const repoDir = repoDirName(repo); // 依 repo（git URL 末段）分層：<repoDir>/<repo 內原路徑>
        const changed = await diffNameOnly(repo.local_path, baseBranch, task.git_branch);
        // 反向三點 diff＝切點之後 ai-dev 自己的改動。與本任務改動的交集，就是兩邊都動過的檔。
        const aiSide = await diffNameOnly(repo.local_path, task.git_branch, baseBranch);
        for (const rel of changed) {
          const srcFile = path.join(wtRepo, rel);
          // 只打包本任務真的改過的檔：整包模組目錄會把 worktree 裡「切點當下的舊版」一起送出，
          // 而 worktree 自 analysis 起就凍結，解壓覆蓋等於把期間的人工修正整批退版。
          if (!fs.existsSync(srcFile)) { deleted.push(rel); continue; }
          const zipPath = `${repoDir}/${rel}`;
          if (entries.some(e => e.zipPath === zipPath)) continue;
          entries.push({ zipPath, srcFile });
          if (aiSide.includes(rel)) stale.push(zipPath);
        }
      }
      if (!entries.length) return res.status(400).json({ error: '本任務沒有可打包的程式改動' });

      // 打包清單走 header：body 是 binary，沒有第二個地方能回報刪除檔與覆蓋風險。
      // 逐字放會讓非 ASCII 檔名生出無效 header（Node 直接丟 ERR_INVALID_CHAR），故編碼後再帶。
      res.setHeader('X-Zip-Entries', encodeURIComponent(JSON.stringify(entries.map(e => e.zipPath))));
      res.setHeader('X-Zip-Deleted', encodeURIComponent(JSON.stringify(deleted)));
      res.setHeader('X-Zip-Stale', encodeURIComponent(JSON.stringify(stale)));
      res.setHeader('Access-Control-Expose-Headers', 'X-Zip-Entries, X-Zip-Deleted, X-Zip-Stale');
      res.setHeader('Content-Type', 'application/zip');
      // 檔名只留安全字元：task_id 目前恆為英數與底線，但它源自外部系統，不該由它決定 header 內容。
      res.setHeader('Content-Disposition', `attachment; filename="${String(task.task_id).replace(/[^\w.-]/g, '_')}.zip"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      // 串流中途出錯（來源目錄被刪、磁碟 IO）已無法改回 JSON——中止連線讓瀏覽器判定下載失敗，
      // 好過送出一個看似完整、解壓才發現壞掉的檔案。
      archive.on('error', (err) => {
        console.error('[CODE-ZIP] archive error:', err.message);
        res.destroy();
      });
      archive.pipe(res);
      for (const { zipPath, srcFile } of entries) archive.file(srcFile, { name: zipPath });
      await archive.finalize();
    } catch (err) {
      if (res.headersSent) return res.destroy();
      res.status(500).json({ error: '打包程式碼失敗：' + err.message });
    }
  });

  app.post('/api/tasks/:id/cs-confirm', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'cs_reply_pending') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not cs_reply_pending` });
      }
      // 條件更新防雙擊：檢查到更新之間狀態被改（另一請求已完成）就不動作
      await query(
        "UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1 AND status = 'cs_reply_pending'",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/cs-data-submit', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'cs_data_needed') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not cs_data_needed` });
      }
      // 條件更新防雙擊：輸掉競態的請求不再重複寫入回答（否則 cs-agent 會讀到重複答案）
      const { rowCount } = await query(
        "UPDATE tasks SET status = 'cs_running', updated_at = NOW() WHERE id = $1 AND status = 'cs_data_needed'",
        [req.params.id]
      );
      if (!rowCount) return res.json({ ok: true });
      const { answers, note } = req.body;
      let logContent = '';
      if (answers && typeof answers === 'object') {
        // Structured QA answers: { "問題文字": "回答文字" }
        logContent = Object.entries(answers)
          .map(([q, a]) => `Q：${q}\nA：${a}`)
          .join('\n\n');
      } else if (note?.trim()) {
        logContent = note.trim();
      }
      if (logContent) {
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
          [req.params.id, logContent]
        );
      }
      // 補資料後推 task:updated：讓開著該任務頁的瀏覽器即時重抓、看到剛補的答案（否則要手動 F5 才更新）
      require('./notify').emitToUser(req.userId, 'task:updated', { taskId: Number(req.params.id), status: 'cs_running' });
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 客服回覆這關追問／補充：把追問寫進 task_logs（role='user'）＝釐清對話真相來源，轉 cs_running 重跑 cs agent，
  // 由 cs 依「原問題＋前一版草稿＋這次追問」重新三分類——修出新草稿留在原地、或釐清後判定需補資料/改程式自然分流。
  app.post('/api/tasks/:id/cs-followup', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'cs_reply_pending') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not cs_reply_pending` });
      }
      const note = ((req.body && req.body.note) || '').trim();
      if (!note) return res.status(400).json({ error: '請填寫追問內容' });
      // 條件更新防雙擊：先搶到轉移權的請求才落地追問，避免 cs-agent 讀到重複輸入
      const { rowCount } = await query(
        "UPDATE tasks SET status = 'cs_running', updated_at = NOW() WHERE id = $1 AND status = 'cs_reply_pending'",
        [req.params.id]
      );
      if (!rowCount) return res.json({ ok: true });
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, note]
      );
      require('./notify').emitToUser(req.userId, 'task:updated', { taskId: Number(req.params.id), status: 'cs_running' });
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/mark-conflict-resolved', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status, project_id, merge_conflict_data, merge_resolutions FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'merge_conflict') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not merge_conflict` });
      }
      let cd = null;
      try { cd = rows[0].merge_conflict_data ? JSON.parse(rows[0].merge_conflict_data) : null; } catch { cd = null; }
      const isRebuild = !!(cd && cd.rebuild); // 來自刪任務觸發的 testing 重建，而非正常 merge_running
      const isSync = !!(cd && cd.sync); // 來自 main → ai-dev 同步，而非 task 分支併 testing

      // 轉 deploy 前驗證主 clone 已無未解衝突並了結 merge（commit）——
      // 否則半套 merge（MERGE_HEAD＋衝突標記）直接進部署，錯誤會被誤歸因為程式問題（健檢 U6）
      if (rows[0].project_id) {
        const { concludeMerge } = require('./pipeline/git');
        const { withProjectLock } = require('./pipeline/project-lock');
        const { rows: repos } = await query(
          "SELECT local_path, label FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL",
          [rows[0].project_id]
        );
        // 重建來源：了結前先把人解好的檔案內容記進 merge_resolutions，供之後重演預帶（best-effort，讀不到略過）
        if (isRebuild) {
          let map = {};
          try { map = rows[0].merge_resolutions ? JSON.parse(rows[0].merge_resolutions) : {}; } catch { map = {}; }
          for (const r of (cd.repos || [])) {
            const repo = repos.find(x => x.label === r.repo);
            if (!repo) continue;
            map[r.repo] = map[r.repo] || {};
            for (const f of (r.files || [])) {
              try { map[r.repo][f] = fs.readFileSync(path.join(repo.local_path, f), 'utf8'); } catch { /* 讀不到就略過 */ }
            }
          }
          await query('UPDATE tasks SET merge_resolutions = $2 WHERE id = $1', [rows[0].id, JSON.stringify(map)]);
        }
        // concludeMerge 對主 clone commit → 持專案鎖，避免與同專案 merge/deploy/approve 交錯
        const concludeErr = await withProjectLock(rows[0].project_id, async () => {
          for (const repo of repos) {
            try {
              await concludeMerge(repo.local_path);
            } catch (err) {
              return `${repo.label}：${err.message}`;
            }
          }
          return null;
        });
        if (concludeErr) return res.status(400).json({ error: concludeErr });
      }

      if (isRebuild) {
        // 還原原關卡、清 conflict data，再冪等重跑重建（可能再度停在下一個衝突）
        await query(
          "UPDATE tasks SET status = $2, merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
          [rows[0].id, safeReturnStatus(cd.prior_status, 'deploy_testing')]
        );
        const { rebuildTesting } = require('./pipeline/rebuild-testing');
        const warn = await rebuildTesting(rows[0].project_id, req.userId).catch(e => `testing 重建異常（已略過）：${e.message}`);
        return res.json({ ok: true, warnings: warn ? [warn] : [] });
      }

      if (isSync) {
        // sync 衝突解完＝ai-dev 已含 main 的新碼，回分析重跑（此時 sync 已 commit，重跑冪等）
        await query(
          "UPDATE tasks SET status = $2, merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
          [rows[0].id, safeReturnStatus(cd.prior_status, 'analysis_running')]
        );
        runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
        return res.json({ ok: true });
      }

      await query(
        "UPDATE tasks SET status = 'deploy_testing', merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 逐檔裁決衝突（塊 C）：body.resolutions = [{ repo, file, action:'take_theirs'|'take_ours'|'manual' }]。
  // 對每個 repo 套用裁決（取一側或保留人工）＋接受已自動解好的檔，全部收斂則 commit → deploy_testing；
  // 仍有 manual／未決檔則留 merge_conflict（提示使用者手解剩餘檔後按「已手動解決」收尾）。
  const RESOLVE_ACTIONS = ['take_theirs', 'take_ours', 'manual'];
  app.post('/api/tasks/:id/resolve-conflicts', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status, project_id, merge_conflict_data FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'merge_conflict') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not merge_conflict` });
      }
      const resolutions = Array.isArray(req.body?.resolutions) ? req.body.resolutions : [];
      if (!resolutions.length) return res.status(400).json({ error: 'resolutions required' });
      for (const r of resolutions) {
        if (!RESOLVE_ACTIONS.includes(r.action)) return res.status(400).json({ error: `invalid action: ${r.action}` });
      }
      if (!rows[0].project_id) return res.status(400).json({ error: '此任務沒有專案，無法套用衝突裁決' });

      const { concludeMerge, applyConflictChoices } = require('./pipeline/git');
      const { withProjectLock } = require('./pipeline/project-lock');
      const { rows: repos } = await query(
        "SELECT local_path, label FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL",
        [rows[0].project_id]
      );

      // 逐 repo 套用（持專案鎖，避免與同專案 merge/deploy 交錯）。回傳每 repo 仍未解的檔。
      const outcome = await withProjectLock(rows[0].project_id, async () => {
        const stillOpen = [];
        for (const repo of repos) {
          const choices = new Map(
            resolutions.filter(r => r.repo === repo.label).map(r => [r.file, r.action])
          );
          let remaining;
          try {
            remaining = await applyConflictChoices(repo.local_path, choices);
          } catch (err) {
            return { error: `${repo.label}：套用裁決失敗 — ${err.message}` };
          }
          if (remaining.length) { stillOpen.push({ repo: repo.label, files: remaining }); continue; }
          try {
            await concludeMerge(repo.local_path); // 無未解＋有 MERGE_HEAD → commit 了結
          } catch (err) {
            return { error: `${repo.label}：${err.message}` };
          }
        }
        return { stillOpen };
      });
      if (outcome.error) return res.status(400).json({ error: outcome.error });

      let cd = null;
      try { cd = rows[0].merge_conflict_data ? JSON.parse(rows[0].merge_conflict_data) : null; } catch { cd = null; }

      if (outcome.stillOpen.length) {
        // 尚有 manual／未決檔：保留 merge_conflict，更新資料只留未解檔（清掉已解檔的卡片）。
        // sync／prior_status 等旗標必須沿用——整包覆寫會讓 sync 衝突退化成一般 merge 衝突：
        // 卡片文案退回「任務分支／testing」（兩側恰好相反，使用者會選反邊），收尾時還會把仍停在
        // 分析階段（無 analysis_yaml／無分支／無 worktree）的任務直接推去 deploy_testing。
        // 同理 repos 也不可整包換成 stillOpen——那只有 { repo, files }，未解檔的 details
        // （AI 原因／★建議／merge-clarify 逐檔追問問答）會一併蒸發，且只能重花 token 問回來。
        const prevRepos = Array.isArray(cd?.repos) ? cd.repos : [];
        const stillOpen = outcome.stillOpen.map(o => {
          const prevDetails = prevRepos.find(r => r.repo === o.repo)?.details;
          if (!prevDetails) return o;
          const details = {};
          for (const f of o.files) if (prevDetails[f]) details[f] = prevDetails[f]; // 已解檔的 detail 隨卡片一起消失
          return Object.keys(details).length ? { ...o, details } : o;
        });
        await query(
          "UPDATE tasks SET merge_conflict_data = $2, updated_at = NOW() WHERE id = $1",
          [rows[0].id, JSON.stringify({ ...(cd || {}), repos: stillOpen })]
        );
        return res.json({ ok: true, done: false, remaining: outcome.stillOpen });
      }

      if (cd && cd.sync) {
        // 比照 mark-conflict-resolved：sync 衝突解完回分析重跑，不進部署（程式碼還沒開始寫）
        await query(
          "UPDATE tasks SET status = $2, merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
          [rows[0].id, safeReturnStatus(cd.prior_status, 'analysis_running')]
        );
        runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
        return res.json({ ok: true, done: true });
      }

      await query(
        "UPDATE tasks SET status = 'deploy_testing', merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
        [rows[0].id]
      );
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true, done: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 逐檔追問釐清（給非工程師）：body = { repo, file, question }。針對單一衝突檔問 AI，白話作答並在必要
  // 時調整 ★建議；問答串存回 merge_conflict_data.details[file].qa。全程停 merge_conflict、不推進 pipeline。
  app.post('/api/tasks/:id/merge-clarify', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, task_id, status, project_id, merge_conflict_data, analysis_yaml FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'merge_conflict') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not merge_conflict` });
      }
      const repo = String(req.body?.repo || '').trim();
      const file = String(req.body?.file || '').trim();
      const question = String(req.body?.question || '').trim();
      if (!repo || !file) return res.status(400).json({ error: 'repo and file required' });
      if (!question) return res.status(400).json({ error: 'question required' });
      if (!rows[0].project_id) return res.status(400).json({ error: '此任務沒有專案，無法追問' });

      let cd = null;
      try { cd = rows[0].merge_conflict_data ? JSON.parse(rows[0].merge_conflict_data) : null; } catch { cd = null; }
      if (!cd || !Array.isArray(cd.repos)) return res.status(400).json({ error: '無衝突資料可追問' });
      if (cd.rebuild) return res.status(400).json({ error: '重建來源的衝突不支援追問，請手動解決' });
      const repoEntry = cd.repos.find(r => r.repo === repo);
      if (!repoEntry || !(repoEntry.files || []).includes(file)) {
        return res.status(400).json({ error: '找不到該衝突檔' });
      }

      const { rows: repos } = await query(
        "SELECT local_path, label FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL",
        [rows[0].project_id]
      );
      const repoRow = repos.find(r => r.label === repo);
      if (!repoRow) return res.status(400).json({ error: `找不到 repo：${repo}` });

      repoEntry.details = repoEntry.details || {};
      const detail = repoEntry.details[file] = repoEntry.details[file] || {};
      detail.qa = detail.qa || [];

      const { clarifyConflict, DEFAULT_LABELS, SYNC_LABELS } = require('./pipeline/merge-agent');
      // sync 衝突的兩側（ours=ai-dev、theirs=main）與併 testing 相反，標籤要跟著換，
      // 否則 AI 的白話說明會跟同一張卡片上的按鈕文案（取工程師版／取 AI 版）自相矛盾。
      const result = await clarifyConflict(
        repoRow.local_path, file,
        { question, priorDetail: repoEntry.details[file], businessContext: rows[0].analysis_yaml, history: detail.qa },
        null, { taskId: rows[0].id, userId: req.userId, ...(cd.sync ? SYNC_LABELS : DEFAULT_LABELS) }
      );

      detail.qa.push({ q: question, a: result.answer });
      const changed = result.recommendation !== 'keep';
      if (changed) { detail.recommendation = result.recommendation; detail.rationale = result.rationale; }

      await query(
        'UPDATE tasks SET merge_conflict_data = $2, updated_at = NOW() WHERE id = $1',
        [rows[0].id, JSON.stringify(cd)]
      );
      // 不改 status、不呼叫 runPipeline：追問不推進 pipeline，使用者按裁決鈕才往前走
      res.json({ ok: true, answer: result.answer, recommendation: detail.recommendation, rationale: detail.rationale, changed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
