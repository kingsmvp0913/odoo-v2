const path = require('path');
const yaml = require('js-yaml');
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { abortTask, runPipeline } = require('./pipeline/runner');
const { removeWorktree, deleteBranchLocal } = require('./pipeline/git');
const { writebackTaskMessage } = require('./pipeline/sync');
const { uninstallModule } = require('./pipeline/env-agent');
const { rebuildTesting } = require('./pipeline/rebuild-testing');
const { withProjectLock } = require('./pipeline/project-lock');
const { saveAttachmentFile, deleteTaskDir, readAttachmentFile, sniffFile, attachmentSize } = require('./lib/attachments');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }
});
function uploadMessageFiles(req, res, next) {
  upload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// 刪除任務時清掉該任務的 worktree 與分支（task/<task_id>）。best-effort，不阻斷刪除。
async function cleanupTaskGit(task) {
  if (!task.project_id || !task.git_branch) return;
  const { rows: repos } = await query(
    "SELECT local_path FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [task.project_id]
  );
  if (!repos.length) return;
  const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);
  for (const repo of repos) {
    const wtPath = path.join(wtParent, path.basename(repo.local_path));
    await removeWorktree(repo.local_path, wtPath).catch(() => {});
    await deleteBranchLocal(repo.local_path, task.git_branch, true).catch(() => {});
  }
}

// 從任務 analysis_yaml 取 module 名（與 deploy-testing 同套解析）；取不到回空字串。
function taskModule(task) {
  if (!task || !task.analysis_yaml) return '';
  try { return (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; }
  catch { return ''; }
}

// 從 analysis_yaml 取澄清摘要與問題清單，供 confirm_pending 在前端列出讓使用者回答（前端無 YAML parser）。
// 兼容巢狀 clarification_channel.questions 與扁平陣列（與 teams.js notifyQuestion 同套解析）。取不到回空。
function taskClarification(task) {
  if (!task || !task.analysis_yaml) return { summary: '', questions: [] };
  try {
    const parsed = yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {};
    const ch = parsed.clarification_channel;
    const questions = Array.isArray(ch?.questions) ? ch.questions.filter(q => typeof q === 'string')
      : Array.isArray(ch) ? ch.filter(q => typeof q === 'string') : [];
    return { summary: typeof parsed.summary === 'string' ? parsed.summary : '', questions };
  } catch { return { summary: '', questions: [] }; }
}

// 從 analysis_yaml 解析出審核頁要渲染的規格（前端無 YAML parser）：只挑人要看的欄位，
// case_id/odoo_version/clarification_channel/low_confidence 屬 metadata/內部控制，不外吐。解析失敗回 null。
function taskSpec(task) {
  if (!task || !task.analysis_yaml) return null;
  try {
    const p = yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {};
    const strList = v => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    return {
      summary: typeof p.summary === 'string' ? p.summary : '',
      module: typeof p.module === 'string' ? p.module : '',
      execution_mode: typeof p.execution_mode === 'string' ? p.execution_mode : '',
      requirements: strList(p.requirements),
      acceptance: strList(p.acceptance),
    };
  } catch { return null; }
}

// 刪任務時卸載其測試區 module（子系統 A）。best-effort，回警告字串或 null，永不 throw、不擋刪除。
// excludeIds：本次一併刪除的任務 id（含自己）——同專案其他「未隱藏且不在此清單」的任務若也用同一 module，
// 代表還有人在用 → 跳過卸載。依存判斷在 JS 端做，避開 pg-mem 對 ANY(int[]) 的限制。
async function uninstallTaskModule(task, excludeIds) {
  const moduleName = taskModule(task);
  if (!task.project_id || !moduleName) return null;
  const { rows: siblings } = await query(
    'SELECT id, analysis_yaml FROM tasks WHERE project_id = $1 AND is_hidden = false',
    [task.project_id]
  );
  const ex = new Set(excludeIds);
  if (siblings.some(s => !ex.has(s.id) && taskModule(s) === moduleName)) return null;
  try {
    const r = await withProjectLock(task.project_id, () => uninstallModule(task.project_id, moduleName));
    if (r && r.result === 'skipped_dependents') {
      return `模組 ${moduleName} 因有其他模組依存（${(r.dependents || []).join('、')}），已保留未卸載，請自行處理。`;
    }
    return null;
  } catch (err) {
    return `模組 ${moduleName} 卸載失敗（已略過，不影響刪除）：${err.message}`;
  }
}

const NEEDS_ACTION_STATUSES = ['confirm_pending', 'clarify_pending', 'cs_data_needed', 'cs_reply_pending', 'merge_conflict', 'spec_review', 'review_pending', 'stopped'];
const ANSWER_ALLOWED_STATUSES = ['confirm_pending', 'clarify_pending'];
const SAFE_INLINE_MIMETYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

function registerRoutes(app) {
  // List tasks with optional filters
  app.get('/api/tasks', verifyToken, async (req, res) => {
    try {
      const { needs_action, source, status, archived } = req.query;
      const conditions = ['user_id = $1'];
      const params = [req.userId];
      conditions.push(archived === 'true' ? 'is_hidden = true' : 'is_hidden = false');

      if (needs_action === 'true') {
        conditions.push(`status = ANY($${params.length + 1}::text[])`);
        params.push(NEEDS_ACTION_STATUSES);
      } else if (status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(status);
      }
      if (source) {
        conditions.push(`source = $${params.length + 1}`);
        params.push(source);
      }

      const sql = `SELECT t.id, t.task_id, t.source, t.title, t.status, t.is_paused, t.project_id, t.git_branch, t.reentry_count, t.approved_at, t.created_at, t.updated_at,
                          e.url AS env_url,
                          p.name AS project_name, p.e2e_disabled
                   FROM tasks t
                   LEFT JOIN odoo_envs e ON e.project_id = t.project_id AND e.status = 'running'
                   LEFT JOIN projects p ON p.id = t.project_id
                   WHERE t.${conditions.join(' AND t.')} ORDER BY t.updated_at DESC`;
      const { rows } = await query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manually create a task → enters pipeline as 'new'（立刻觸發 triage，不等下一輪排程）
  // 掛 uploadMessageFiles：新增任務可夾帶附件（origin='manual'），純 JSON 呼叫仍相容（multer 放行、req.files 空）
  app.post('/api/tasks', verifyToken, uploadMessageFiles, async (req, res) => {
    try {
      const { title, original_text, project_id } = req.body || {};
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: '請填寫標題' });
      }
      const taskId = `manual_${Date.now()}`;
      const { rows } = await query(
        `INSERT INTO tasks (user_id, task_id, source, title, original_text, project_id, status)
         VALUES ($1, $2, 'manual', $3, $4, $5, 'new')
         RETURNING id, task_id, source, title, status, project_id, created_at, updated_at`,
        [req.userId, taskId, String(title).trim(), original_text || '', project_id || null]
      );
      const newId = rows[0].id;
      // 附件先落地再跑 pipeline：分診/分析經 assembleTaskContext 讀 task_attachments，須在觸發前寫入
      for (const file of req.files || []) {
        const relPath = saveAttachmentFile(newId, file.originalname, file.buffer);
        await query(
          `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
           VALUES ($1, $2, $3, $4, 'manual')`,
          [newId, file.originalname, file.mimetype, relPath]
        );
      }
      if ((req.files || []).length) {
        await query('UPDATE tasks SET has_attachment = true WHERE id = $1', [newId]);
      }
      runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Task detail + last 5 logs + 工單主附件
  app.get('/api/tasks/:id', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        `SELECT t.*, e.url AS env_url
           FROM tasks t
           LEFT JOIN odoo_envs e ON e.project_id = t.project_id AND e.status = 'running'
          WHERE t.id = $1 AND t.user_id = $2 AND t.is_hidden = false`,
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      const { rows: logs } = await query(
        'SELECT id, role, content, created_at FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 5',
        [req.params.id]
      );
      // 抓全部附件（含 message 的）算實際大小：主附件清單只給非空的主附件；has_attachment 依「有沒有任何非空附件」重算
      const { rows: attRows } = await query(
        'SELECT id, filename, mimetype, file_path, message_id FROM task_attachments WHERE task_id = $1',
        [req.params.id]
      );
      const withSize = attRows.map(a => ({ ...a, size: attachmentSize(a.file_path) }));
      // 主附件清單：濾掉 0-byte 空檔（來源未成功上傳的死列），沒有真內容就不吐給前端＝主附件區塊自然隱藏。不把 file_path 外洩給前端
      const attachments = withSize
        .filter(a => a.message_id === null && a.size > 0)
        .map(a => ({ id: a.id, filename: a.filename, mimetype: a.mimetype, size: a.size }));
      // 舊碼把空附件也設了 has_attachment=true → 殘留旗標讓「含附件」pill 誤顯示。依實際非空附件重算並自癒回寫，詳情頁與任務列表一起修正
      const realHasAttachment = withSize.some(a => a.size > 0);
      if (!!tasks[0].has_attachment !== realHasAttachment) {
        await query('UPDATE tasks SET has_attachment = $1 WHERE id = $2', [realHasAttachment, req.params.id]);
        tasks[0].has_attachment = realHasAttachment;
      }
      // 澄清問題只在 confirm_pending 出（初次分析）；clarify_pending 共用同一 answer 區但走時間軸對話，
      // 其 analysis_yaml 常殘留當初分析的舊問題，不可誤冒出來。
      const clarification = tasks[0].status === 'confirm_pending' ? taskClarification(tasks[0]) : { summary: '', questions: [] };
      // spec_review（MODE_B 規格審核閘門）：附解析後的規格供審核頁渲染；其他狀態不附（防殘留規格冒出）
      const spec = tasks[0].status === 'spec_review' ? taskSpec(tasks[0]) : null;
      res.json({ task: tasks[0], logs: logs.reverse(), attachments, clarification, spec });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 審核用 diff：任務分支相對主分支的程式變更（逐 repo）。分支已清（已核准）的 repo 標 missing。
  app.get('/api/tasks/:id/diff', verifyToken, async (req, res) => {
    try {
      const { rows: [task] } = await query(
        'SELECT id, project_id, git_branch FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (!task.project_id || !task.git_branch) return res.status(400).json({ error: '此任務沒有專案分支，無可檢視的程式變更' });

      const { getProjectInfo } = require('./pipeline/task-agent');
      const { getMainBranch, refExists, diffBranch } = require('./pipeline/git');
      const info = await getProjectInfo(task.project_id);
      if (!info?.repos?.length) return res.status(400).json({ error: '專案未設定任何已完成 clone 的 Repo' });

      // 超大 diff 截斷保護：審核介面看重點即可，完整內容仍在 git
      const MAX_CHARS = 300000;
      const repos = [];
      for (const repo of info.repos) {
        if (!(await refExists(repo.local_path, `refs/heads/${task.git_branch}`))) {
          repos.push({ label: repo.label, missing: true, diff: '' });
          continue;
        }
        const mainBranch = await getMainBranch(repo.local_path).catch(() => 'main');
        let diff = await diffBranch(repo.local_path, mainBranch, task.git_branch);
        const truncated = diff.length > MAX_CHARS;
        if (truncated) diff = diff.slice(0, MAX_CHARS);
        repos.push({ label: repo.label, diff, truncated });
      }
      res.json({ branch: task.git_branch, repos });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Edit task content — only while status='new'（尚未進 pipeline，之後分析/開發已依此內容展開，不再允許改）
  app.put('/api/tasks/:id', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (tasks[0].status !== 'new') {
        return res.status(400).json({ error: '任務已進入處理流程，無法修改內容' });
      }
      const { original_text } = req.body || {};
      if (!original_text || !String(original_text).trim()) {
        return res.status(400).json({ error: '請填寫內容' });
      }
      await query(
        'UPDATE tasks SET original_text = $2, updated_at = NOW() WHERE id = $1',
        [req.params.id, String(original_text)]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 外部溝通紀錄：sync 拉進來的聊天紀錄 + 使用者手動追加的留言，新到舊排序（畫面顯示用）
  app.get('/api/tasks/:id/messages', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      const { rows } = await query(
        'SELECT id, source, author, content, occurred_at, synced_to_odoo FROM task_messages WHERE task_id = $1 ORDER BY occurred_at DESC',
        [req.params.id]
      );
      const { rows: attachments } = await query(
        'SELECT id, message_id, filename, mimetype FROM task_attachments WHERE task_id = $1 AND message_id IS NOT NULL',
        [req.params.id]
      );
      const byMessage = {};
      attachments.forEach(a => { (byMessage[a.message_id] = byMessage[a.message_id] || []).push(a); });
      rows.forEach(m => { m.attachments = byMessage[m.id] || []; });
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 新增留言（不限任務狀態，逐步累積的補充資訊）；管理者開關開啟時 best-effort 回寫來源系統記錄備註
  app.post('/api/tasks/:id/messages', verifyToken, uploadMessageFiles, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, task_id, source FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      const { content } = req.body || {};
      if (!content || !String(content).trim()) return res.status(400).json({ error: '請填寫內容' });
      const trimmed = String(content).trim();

      const { rows: [me] } = await query('SELECT display_name FROM users WHERE id = $1', [req.userId]);
      const { rows: [inserted] } = await query(
        `INSERT INTO task_messages (task_id, source, author, content, occurred_at)
         VALUES ($1, 'manual', $2, $3, NOW())
         RETURNING id, source, author, content, occurred_at, synced_to_odoo`,
        [req.params.id, me?.display_name || null, trimmed]
      );

      const attachmentRows = [];
      for (const file of req.files || []) {
        const relPath = saveAttachmentFile(req.params.id, file.originalname, file.buffer);
        const { rows: [att] } = await query(
          `INSERT INTO task_attachments (task_id, message_id, filename, mimetype, file_path, origin)
           VALUES ($1, $2, $3, $4, $5, 'manual_reply')
           RETURNING id, filename, mimetype, file_path`,
          [req.params.id, inserted.id, file.originalname, file.mimetype, relPath]
        );
        attachmentRows.push(att);
      }

      const { rows: [cfg] } = await query('SELECT writeback_odoo_notes FROM teams_settings WHERE id = 1');
      // 沒帶 writeback 欄位時預設 true（維持現況行為）；前端明確傳 false 才跳過這則的回寫。
      // 留言改走 multipart（夾帶附件），writeback 以字串傳入，故以字串 'false' 比對。
      const wantsWriteback = String(req.body?.writeback) !== 'false';
      if (cfg?.writeback_odoo_notes && wantsWriteback) {
        try {
          const result = await writebackTaskMessage(req.userId, tasks[0], trimmed, attachmentRows);
          if (result?.messageExternalId) {
            await query(
              'UPDATE task_messages SET external_id = $2, synced_to_odoo = true WHERE id = $1',
              [inserted.id, String(result.messageExternalId)]
            );
            inserted.synced_to_odoo = true;
            for (let i = 0; i < attachmentRows.length; i++) {
              await query(
                'UPDATE task_attachments SET synced_to_odoo = true, external_attachment_id = $2 WHERE id = $1',
                [attachmentRows[i].id, String(result.attachmentExternalIds[i])]
              );
            }
          }
        } catch (e) { /* best-effort：回寫失敗不影響本地已儲存的留言與附件 */ }
      }
      res.json({ ...inserted, attachments: attachmentRows.map(({ file_path, ...rest }) => rest) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 附件下載：驗證附件屬於該任務且該任務屬於目前使用者，再串流本機檔案回傳
  app.get('/api/tasks/:id/attachments/:attId/download', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT a.filename, a.mimetype, a.file_path
         FROM task_attachments a
         JOIN tasks t ON t.id = a.task_id
         WHERE a.id = $1 AND a.task_id = $2 AND t.user_id = $3`,
        [req.params.attId, req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
      const att = rows[0];
      const buffer = readAttachmentFile(att.file_path);
      // 空檔（0 bytes）：來源附件本身無內容，直接回明確錯誤，不讓前端下載一個打不開的空檔
      if (!buffer.length) return res.status(410).json({ error: '此附件無內容（0 bytes），來源可能未成功上傳檔案' });
      // 舊資料常缺 mimetype／檔名缺副檔名（早期 sniff 只認 4 種）→ serve 時即時嗅測補齊，修好既有壞列免重新同步
      const sniff = sniffFile(buffer);
      const effMime = att.mimetype || sniff.mime;
      const safeMimetype = SAFE_INLINE_MIMETYPES.has(effMime) ? effMime : 'application/octet-stream';
      const fname = /\.[a-z0-9]+$/i.test(att.filename) ? att.filename : att.filename + sniff.ext;
      res.setHeader('Content-Type', safeMimetype);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fname)}"`);
      res.send(buffer);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Paginated logs
  app.get('/api/tasks/:id/logs', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      const offset = parseInt(req.query.offset) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const { rows } = await query(
        'SELECT id, role, content, created_at FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.params.id, limit, offset]
      );
      res.json(rows.reverse());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 執行歷程：該任務所有事件（依序回放，供 Terminal 頁載入歷史）
  app.get('/api/tasks/:id/events', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      // 無 limit → 全部（Terminal 全頁）；有 limit → 取最新 N 筆，before=<id> 再往前撈舊的（詳情頁即時歷程用）
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit) || 10, 200) : null;
      const before = parseInt(req.query.before) || 0;
      let rows;
      if (limit === null) {
        ({ rows } = await query('SELECT id, content, created_at FROM task_events WHERE task_id = $1 ORDER BY id', [req.params.id]));
      } else if (before > 0) {
        ({ rows } = await query('SELECT id, content, created_at FROM task_events WHERE task_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3', [req.params.id, before, limit]));
        rows.reverse();
      } else {
        ({ rows } = await query('SELECT id, content, created_at FROM task_events WHERE task_id = $1 ORDER BY id DESC LIMIT $2', [req.params.id, limit]));
        rows.reverse();
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle pause on a task
  app.put('/api/tasks/:id/pause', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, is_paused FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const newPaused = !rows[0].is_paused;
      await query(
        'UPDATE tasks SET is_paused = $2, updated_at = NOW() WHERE id = $1',
        [req.params.id, newPaused]
      );
      if (newPaused) abortTask(req.params.id);
      else runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true, is_paused: newPaused });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Archive task (admin only — hides from main view, visible in archived tab)
  // batch 路由必須先於 `/api/tasks/:id/...` 註冊：Express 依註冊順序比對，後註冊的
  // batch/archive 會被 :id/archive 以 id='batch' 吞掉（整數轉型 500，批次封存整個失效）。
  app.post('/api/tasks/batch/archive', verifyToken, async (req, res) => {
    try {
      // 批次操作一律只動「自己的」任務（WHERE user_id），故開放一般使用者管理自己的任務清單
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      ids.forEach(id => abortTask(id)); // 封存執行中任務：中止在飛 agent（健檢項11）
      const { rowCount } = await query(
        'UPDATE tasks SET is_hidden = true, is_paused = false, updated_at = NOW() WHERE id = ANY($1::int[]) AND user_id = $2',
        [ids, req.userId]
      );
      res.json({ ok: true, affected: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/tasks/batch/unarchive', verifyToken, async (req, res) => {
    try {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      const { rowCount } = await query(
        'UPDATE tasks SET is_hidden = false, updated_at = NOW() WHERE id = ANY($1::int[]) AND user_id = $2',
        [ids, req.userId]
      );
      res.json({ ok: true, affected: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/tasks/:id/archive', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可封存任務' });
      const { rows } = await query('SELECT id FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      abortTask(req.params.id); // 封存執行中任務：中止在飛 agent，否則子行程續跑到逾時（健檢項11）
      await query(
        "UPDATE tasks SET is_hidden = true, is_paused = false, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Unarchive task (admin only — restores to active list)
  app.post('/api/tasks/:id/unarchive', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可解除封存' });
      const { rows } = await query('SELECT id FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      await query(
        "UPDATE tasks SET is_hidden = false, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Delete task permanently (admin only — removes from DB; re-sync will re-import)
  app.delete('/api/tasks/:id', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可刪除任務' });
      const { rows } = await query('SELECT id, task_id, project_id, git_branch, approved_at, analysis_yaml FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].approved_at) return res.status(403).json({ error: '已人工審核通過的任務不可刪除' });
      abortTask(req.params.id); // 先中止在飛 agent，否則子行程會邊清 worktree 邊續寫（健檢項11）
      const warnings = [];
      const uw = await uninstallTaskModule(rows[0], [rows[0].id]);
      if (uw) warnings.push(uw);
      await cleanupTaskGit(rows[0]);
      // 只清「任務生命週期」子表（隨任務死）。以下四張刻意「不」隨任務刪、保留為跨任務資料，勿再當漏刪補進來：
      //   token_usage       → 計費/成本歷史（token-report ?all=true 專門把已刪任務列為孤兒；刪了成本統計會縮水）
      //   prompt_logs       → 全域只留最新 100 筆的除錯 ring buffer，自動汰除（見 claude-runner）
      //   task_rejections   → 退回稽核＋分類器訓練語料（reject-triage 算 allow_bug、classify-rejections 餵訓練、admin 有獨立管理頁）
      //   classify_samples  → 分類器準確率訓練語料（admin 依 recorded_at 時窗統計）
      await query('DELETE FROM task_events WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM task_logs WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM task_attachments WHERE task_id = $1', [req.params.id]);
      deleteTaskDir(req.params.id); // 連帶清磁碟上的 uploads/task_<id>（否則實體檔變孤兒）
      await query('DELETE FROM task_messages WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
      // 刪除後重建 testing 分支（清掉被刪任務留在 testing 的 source）；best-effort，警告併回
      if (rows[0].project_id) {
        const rw = await rebuildTesting(rows[0].project_id, req.userId).catch(e => `testing 重建異常（已略過）：${e.message}`);
        if (rw) warnings.push(rw);
      }
      res.json({ ok: true, warnings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Batch operations：只動自己的任務（WHERE user_id）＋已審核通過的跳過不刪，故開放一般使用者
  app.post('/api/tasks/batch/delete', verifyToken, async (req, res) => {
    try {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      // 已審核通過的任務跳過不刪；其餘先清 worktree/分支再刪
      const { rows: ts } = await query(
        'SELECT id, task_id, project_id, git_branch, approved_at, analysis_yaml FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2',
        [ids, req.userId]
      );
      const deletable = ts.filter(t => !t.approved_at);
      const delIds = deletable.map(t => t.id);
      if (!delIds.length) return res.json({ ok: true, affected: 0 });
      delIds.forEach(id => abortTask(id)); // 先中止在飛 agent 再清 worktree／刪除（健檢項11）
      // 卸載各任務的測試區 module（互相排除整批 delIds：同批要刪的任務不算「還有人在用」）
      const warnings = [];
      for (const t of deletable) {
        const w = await uninstallTaskModule(t, delIds);
        if (w) warnings.push(w);
      }
      for (const t of deletable) await cleanupTaskGit(t);
      // 同單筆刪除：只清任務生命週期子表；token_usage/prompt_logs/task_rejections/classify_samples 刻意保留（原因見上方單筆刪除註解）。
      await query('DELETE FROM task_events WHERE task_id = ANY($1::int[])', [delIds]);
      await query('DELETE FROM task_logs WHERE task_id = ANY($1::int[])', [delIds]);
      await query('DELETE FROM task_attachments WHERE task_id = ANY($1::int[])', [delIds]);
      delIds.forEach(id => deleteTaskDir(id)); // 連帶清各任務磁碟上的 uploads/task_<id>
      await query('DELETE FROM task_messages WHERE task_id = ANY($1::int[])', [delIds]);
      const { rowCount } = await query('DELETE FROM tasks WHERE id = ANY($1::int[])', [delIds]);
      // 刪除後每個涉及專案重建一次 testing（去重）
      const projectIds = [...new Set(deletable.map(t => t.project_id).filter(Boolean))];
      for (const pid of projectIds) {
        const rw = await rebuildTesting(pid, req.userId).catch(e => `testing 重建異常（已略過）：${e.message}`);
        if (rw) warnings.push(rw);
      }
      res.json({ ok: true, affected: rowCount, warnings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/tasks/batch/pause', verifyToken, async (req, res) => {
    try {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      const paused = req.body.paused !== false; // default true (pause)
      const { rowCount } = await query(
        'UPDATE tasks SET is_paused = $2, updated_at = NOW() WHERE id = ANY($1::int[]) AND user_id = $3',
        [ids, paused, req.userId]
      );
      if (paused) ids.forEach(id => abortTask(id));
      else runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true, affected: rowCount, is_paused: paused });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });



  // User answer to clarification question
  app.post('/api/tasks/:id/answer', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (!ANSWER_ALLOWED_STATUSES.includes(tasks[0].status)) {
        return res.status(400).json({ error: `Task status '${tasks[0].status}' does not accept answers` });
      }

      const { user_answer } = req.body;
      if (!user_answer) return res.status(400).json({ error: 'user_answer required' });

      // confirm_pending → confirm_answered（回初次分析）；
      // clarify_pending → clarify_answered（QA 規格裁決／分診問人／respec-patch 澄清續談，答完由 resume_status 導回原關）
      // 條件更新防雙擊：輸掉競態的請求不再重複寫入回答（否則下游 agent 會讀到重複答案）
      const nextStatus = tasks[0].status === 'clarify_pending' ? 'clarify_answered' : 'confirm_answered';
      const { rowCount } = await query(
        "UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1 AND status = $3",
        [req.params.id, nextStatus, tasks[0].status]
      );
      if (!rowCount) return res.json({ ok: true });
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, user_answer]
      );
      runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // Resolve a blocked task — saves user's resolution note, resets status to new for retriage
  app.post('/api/tasks/:id/resolve-blocker', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status, resume_status, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (!['stopped'].includes(tasks[0].status)) {
        return res.status(400).json({ error: '只有失敗待確認的任務可以重新處理' });
      }
      const { resolution } = req.body;
      if (!resolution?.trim()) return res.status(400).json({ error: '請填寫解決說明' });

      if (tasks[0].project_id) {
        // 專案任務：不再盲目 resume——交給分診員讀 diff/log＋你的指示，判 resume/advance/fix/respec 決定下一步。
        // 保留 resume_status/blocker_content/計數器供分診讀取，最終落點與計數歸零由分診 goto 處理。
        // 條件更新防雙擊：先搶到轉移權的請求才落地修正指示，避免分診讀到重複指示
        const { rowCount } = await query(
          "UPDATE tasks SET status = 'resolve_triage', updated_at = NOW() WHERE id = $1 AND status = 'stopped'",
          [req.params.id]
        );
        if (!rowCount) return res.json({ ok: true });
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
          [req.params.id, `[修正指示] ${resolution.trim()}`]
        );
      } else {
        // 非專案任務走原路：先落地修正指示（無分診員，直接續跑）
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
          [req.params.id, `[修正指示] ${resolution.trim()}`]
        );
        // 非專案任務：無 worktree/diff 可判 → 沿用直接回中斷的那一關續跑（沒記錄則退回 new）。
        // 只歸零與續跑關卡對應的計數器——全歸零會讓「繼續」一鍵繳械所有重試上限，
        // 同樣的失敗可無上限重演（健檢 U2，任務 52 無限循環的直接機制）
        const RESUME_COUNTER = {
          qa_running: 'qa_retry_count',
          deploy_testing: 'deploy_retry_count',
          playwright_running: 'pw_retry_count'
        };
        const counterCol = RESUME_COUNTER[tasks[0].resume_status];
        await query(
          `UPDATE tasks SET status = COALESCE(resume_status, 'new'),
           blocker_content = NULL, blocker_type = NULL, resume_status = NULL,
           ${counterCol ? counterCol + ' = 0,' : ''} updated_at = NOW() WHERE id = $1`,
          [req.params.id]
        );
      }
      runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes, NEEDS_ACTION_STATUSES };
