const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { query } = require('./db');
const { HUMAN_STATUSES } = require('../public/js/status-labels.js');
const { verifyToken } = require('./auth');
const { abortTask, runPipeline } = require('./pipeline/runner');
const { removeWorktree, deleteBranchLocal, branchMergedInto } = require('./pipeline/git');
const { writebackTaskMessage } = require('./pipeline/sync');
const { uninstallModule } = require('./pipeline/env-agent');
const { rebuildTesting } = require('./pipeline/rebuild-testing');
const { invalidate: invalidateEmbedding } = require('./lib/embedding-index');
const { withProjectLock } = require('./pipeline/project-lock');
const { saveAttachmentFile, deleteTaskDir, readAttachmentFile, sniffFile, attachmentSize, uploadAttachmentFiles } = require('./lib/attachments');
const { loadTaskForActor } = require('./lib/task-access');

// multer 設定已移到 lib/attachments 當單一來源：新增任務／留言／人工退回三個入口共用同一組限制，
// 各持一份會漂移成「有的入口能傳、有的不能」且完全無訊號。此處保留舊名，呼叫端不動。
const uploadMessageFiles = uploadAttachmentFiles;

// 刪除任務時清掉該任務的 worktree 與分支（task/<task_id>）。best-effort，不阻斷刪除；
// 比照 uninstallTaskModule 回警告字串陣列（永不 throw），由呼叫端併進 res.warnings。
async function cleanupTaskGit(task) {
  const warnings = [];
  // 安全邊界：只有 project_id／task_id 缺席才真的無從清起——工作樹路徑完全由 project_repos.local_path
  // 與 task_id 推導，兩者缺一就沒有可信的目標，寧可漏清也不亂刪。git_branch 刻意不再當前提：
  // 工作樹在 analysis 關就建好、git_branch 要到 coding 關才寫入，用它當守衛會讓「進 coding 前被刪」
  // 的任務整包工作樹（每份約 58MB）永遠留在磁碟上，沒有任何其他路徑會回收它。
  if (!task.project_id || !task.task_id) return warnings;
  const { rows: repos } = await query(
    "SELECT local_path FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [task.project_id]
  );
  if (!repos.length) return warnings;
  const wtRoot = path.join(path.dirname(repos[0].local_path), '.worktrees');
  const wtParent = path.join(wtRoot, task.task_id);
  // task_id 是外部同步進來的字串又直接當目錄名用：確認它沒把路徑帶出 .worktrees（`..`／子路徑），
  // 否則下面的 rmdir 會刪到別人的目錄。推導不出安全路徑就整個放棄。
  if (path.dirname(path.resolve(wtParent)) !== path.resolve(wtRoot)) return warnings;
  for (const repo of repos) {
    const wtPath = path.join(wtParent, path.basename(repo.local_path));
    await removeWorktree(repo.local_path, wtPath).catch(() => {}); // 失敗與否一律看下方「目錄是否真的空了」，比錯誤訊息可靠
    // 分支刪除失敗刻意不出警告：清理現在也涵蓋沒進過 coding 的任務，「branch not found」是常態
    // 而非異常，且殘留 ref 不佔磁碟——為它噴警告只會把下方真正的磁碟警告淹掉。
    if (task.git_branch) await deleteBranchLocal(repo.local_path, task.git_branch, true).catch(() => {});
  }
  // 外層 .worktrees/<task_id>/ 從來沒人刪（只刪內層 <label>），空目錄就這樣一直累積。
  // 只在「確認已空」時用非遞迴 rmdir 收掉；還有殘留就保留現場並浮上來，絕不遞迴刪掉
  // 可能屬於別的 repo／別人的內容。這也是移除失敗唯一的對外訊號（原本被 .catch(() => {}) 吞掉）。
  let left;
  try { left = fs.readdirSync(wtParent); } catch { return warnings; } // 讀不到＝目錄不存在，本來就沒東西可清
  if (left.length) {
    warnings.push(`工作樹 ${wtParent} 未能完全清除（殘留：${left.join('、')}），請自行刪除以釋放磁碟空間。`);
    return warnings;
  }
  try { fs.rmdirSync(wtParent); }
  catch (err) { warnings.push(`工作樹目錄 ${wtParent} 刪除失敗（${err.message}），請自行刪除以釋放磁碟空間。`); }
  return warnings;
}

// 從任務 analysis_yaml 取 module 名（與 deploy-testing 同套解析）；取不到回空字串。
function taskModule(task) {
  if (!task || !task.analysis_yaml) return '';
  try { return (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; }
  catch { return ''; }
}

// 從 analysis_yaml 取澄清說明與題目清單，供 confirm_pending 在前端渲染（前端無 YAML parser）。
// 題目格式有兩代：新版是含 id/type/required/options/depends_on 的物件，舊版是純字串陣列
// （既有任務的 analysis_yaml 已凍結在舊格式）——舊字串就地補成 text 必答題，不做資料遷移。
// intro 是白話說明段，刻意與 questions 分家：它一旦混進題目清單就會被編號成「Q1」並被要求作答。
function normalizeQuestion(q, idx) {
  const fallbackId = `q${idx + 1}`;
  if (typeof q === 'string') return { id: fallbackId, text: q, type: 'text', required: true };
  if (!q || typeof q !== 'object' || typeof q.text !== 'string' || !q.text.trim()) return null;
  const out = {
    id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : fallbackId,
    text: q.text,
    type: q.type === 'choice' ? 'choice' : 'text',
    required: q.required !== false
  };
  // 預填答案：clarify-chat 在 revise 時把對話中已確定的答案填進來，前端拿它當答案框初值。
  // 不在白名單裡就會被這個函式丟掉，使用者會被要求重答自己剛講過的事。
  if (q.answer !== undefined && q.answer !== null && String(q.answer).trim()) out.answer = String(q.answer);
  // 建議答案（choice 題填 option 的 key、text 題填一句話）與其依據。同樣是白名單成員：
  // 漏放行的話 agent 推導出的建議在畫面上完全不存在，而且沒有任何錯誤訊息，只是使用者少了一個提示。
  // 這是選用欄位——純屬「使用者要什麼」的題目 agent 刻意不填，前端沒有就不顯示那一行。
  if (typeof q.recommended === 'string' && q.recommended.trim()) out.recommended = q.recommended.trim();
  if (typeof q.recommended_why === 'string' && q.recommended_why.trim()) out.recommended_why = q.recommended_why.trim();
  if (out.type === 'choice') {
    out.options = (Array.isArray(q.options) ? q.options : [])
      .filter(o => o && typeof o.key === 'string' && typeof o.label === 'string')
      .map(o => ({ key: o.key, label: o.label }));
    if (!out.options.length) { out.type = 'text'; delete out.options; } // 選項全壞的 choice 題退成文字題，總比題目消失好
  }
  const dep = q.depends_on;
  if (dep && typeof dep === 'object' && typeof dep.question === 'string' && dep.equals !== undefined) {
    out.depends_on = { question: dep.question, equals: String(dep.equals) };
  }
  return out;
}

function taskClarification(task) {
  const empty = { summary: '', intro: '', questions: [] };
  if (!task || !task.analysis_yaml) return empty;
  try {
    const parsed = yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {};
    const ch = parsed.clarification_channel;
    const rawList = Array.isArray(ch?.questions) ? ch.questions : Array.isArray(ch) ? ch : [];
    const questions = rawList.map(normalizeQuestion).filter(Boolean);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      intro: typeof ch?.intro === 'string' ? ch.intro : '',
      questions
    };
  } catch { return empty; }
}

// 從 analysis_yaml 解析出審核頁要渲染的規格（前端無 YAML parser）：只挑人要看的欄位，
// case_id/odoo_version/clarification_channel/low_confidence 屬 metadata/內部控制，不外吐。解析失敗回 null。
// permissions 是白名單成員：它是使用者按「核准」的三大依據之一，漏放行會讓審核頁權限區塊永遠空白且無錯誤訊息。
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
      permissions: typeof p.permissions === 'string' ? p.permissions : '',
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

// 封存只設 is_hidden，但任務一過 QA 就已經 merge 進 testing 了——那些 commit 會留在部署來源，
// 下一張任務併進來就撞 merge_conflict（實測 #147 封存後 #149 併 testing 撞 UU／AA，只能人工重置）。
// rebuildTesting 會 reset 回 ai-dev 再重併「未封存且在飛」的任務，剛好把已封存的排除掉——所以
// 呼叫端必須排在 is_hidden 寫入「之後」，否則這些任務會被自己重併回去。
// 只對「碼真的還在 testing」的專案動手：rebuildTesting 是 reset --hard，而正常的 done→封存
// （碼早已在 ai-dev）不該白跑一次。回傳 best-effort 的警告字串陣列。
async function reclaimTestingFrom(tasks, userId) {
  const dirty = new Set();
  for (const t of tasks) {
    if (!t.project_id || !t.git_branch || dirty.has(t.project_id)) continue;
    const { rows: repos } = await query(
      "SELECT local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL",
      [t.project_id]
    );
    for (const r of repos) {
      if (await branchMergedInto(r.local_path, t.git_branch, 'testing')) { dirty.add(t.project_id); break; }
    }
  }
  const warnings = [];
  for (const pid of dirty) {
    const rw = await rebuildTesting(pid, userId).catch(e => `testing 重建異常（已略過）：${e.message}`);
    if (rw) warnings.push(rw);
  }
  return warnings;
}

const ANSWER_ALLOWED_STATUSES = ['confirm_pending', 'clarify_pending'];
const SAFE_INLINE_MIMETYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

// 建立任務時要一併帶進來的對話圖片 id。走 multipart 時整個 body 都是字串（FormData 送 JSON 字串），
// 走純 JSON 時是陣列——兩種都要吃得下，否則「有附檔＋從對話轉」的組合會靜默漏掉圖。
function parseChatAttachmentIds(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = raw.split(','); }
  }
  if (!Array.isArray(list)) return [];
  return list.map(Number).filter(Number.isInteger);
}

function registerRoutes(app) {
  // List tasks with optional filters
  app.get('/api/tasks', verifyToken, async (req, res) => {
    try {
      const { needs_action, source, status, archived } = req.query;
      const showAll = req.query.all === 'true' && req.isAdmin;
      const conditions = [];
      const params = [];
      if (!showAll) { conditions.push(`user_id = $${params.length + 1}`); params.push(req.userId); }
      conditions.push(archived === 'true' ? 'is_hidden = true' : 'is_hidden = false');

      if (needs_action === 'true') {
        conditions.push(`status = ANY($${params.length + 1}::text[])`);
        params.push(HUMAN_STATUSES);
      } else if (status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(status);
      }
      if (source) {
        conditions.push(`source = $${params.length + 1}`);
        params.push(source);
      }

      const sql = `SELECT t.id, t.task_id, t.source, t.title, t.status, t.is_paused, t.project_id, t.git_branch, t.reentry_count, t.approved_at, t.merged_to_main_at, t.created_at, t.updated_at,
                          t.user_id AS owner_id, COALESCE(u.display_name, u.username) AS owner_name,
                          e.status AS env_status,
                          p.name AS project_name, p.e2e_disabled
                   FROM tasks t
                   -- 不限 running：環境被閒置回收後仍要帶回 idle，前端的「🖥 測試機」入口才不會
                   -- 整個消失。按下去由 /env/sso 自動起環境（202）或帶出建立失敗原因（409）。
                   LEFT JOIN odoo_envs e ON e.project_id = t.project_id
                   LEFT JOIN projects p ON p.id = t.project_id
                   LEFT JOIN users u ON u.id = t.user_id
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
      const { title, original_text, project_id, chat_id } = req.body || {};
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
      let attachmentCount = (req.files || []).length;
      // 由對話轉來時，把 chat-to-task 挑出、使用者在草稿視窗確認過的那幾張圖複製進任務。
      // 複製實體檔而非共用路徑：刪對話會把整個 chat_<id>/ 目錄清掉，共用的話任務附件會跟著消失。
      // 同樣要早於 runPipeline（見 pipeline 規則 86：assembleTaskContext 是 agent 起跑時才查）。
      const wantIds = parseChatAttachmentIds(req.body.chat_attachment_ids);
      if (chat_id && wantIds.length) {
        // JOIN project_chats 帶 user_id 條件：少了它，隨便帶一組別人的 chat_id／附件 id
        // 就能把別人對話裡的圖複製進自己的任務
        const { rows: srcAtts } = await query(
          `SELECT a.id, a.filename, a.mimetype, a.file_path
             FROM project_chat_attachments a
             JOIN project_chats c ON c.id = a.chat_id
            WHERE a.chat_id = $1 AND c.user_id = $2`,
          [chat_id, req.userId]
        );
        for (const a of srcAtts) {
          if (!wantIds.includes(a.id)) continue;
          try {
            const relPath = saveAttachmentFile(newId, a.filename, readAttachmentFile(a.file_path));
            await query(
              `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
               VALUES ($1, $2, $3, $4, 'chat')`,
              [newId, a.filename, a.mimetype, relPath]
            );
            attachmentCount++;
          } catch (err) {
            // 實體檔不見了（手動清過 uploads 之類）。任務已經建好，不因此整包失敗，但也不能無聲——
            // 使用者以為圖帶進來了，後面每一關都會照著「有圖」的假設做（Rule 12）。
            await query(
              "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
              [newId, `[附件] 對話圖片「${a.filename}」複製失敗（${String(err.message).slice(0, 120)}），本任務沒有這張圖`]
            ).catch(() => {});
          }
        }
      }
      if (attachmentCount) {
        await query('UPDATE tasks SET has_attachment = true WHERE id = $1', [newId]);
      }
      // 由排障對話轉來的任務：回頭在對話上標記，列表才顯示「已轉任務」徽章。
      // 帶 user_id 條件擋偽造的 chat_id；對不到列就靜默略過——任務已經建好了，
      // 不該為了標記不成而讓整個建立失敗。
      // 一併記下「轉到第幾則訊息為止」：下次同一場對話再轉任務時，這條線之前的內容只當背景，
      // 不會被再摘一次成需求。寫在建立任務這一刻而非產草稿那一刻——草稿可能被使用者取消，
      // 提早推進分界線會讓那段對話再也進不了任何任務。
      if (chat_id) {
        await query(
          `UPDATE project_chats
              SET converted_task_id = $1,
                  converted_upto_message_id = COALESCE(
                    (SELECT MAX(id) FROM project_chat_messages WHERE chat_id = $2),
                    converted_upto_message_id)
            WHERE id = $2 AND user_id = $3`,
          [newId, chat_id, req.userId]
        );
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
        `SELECT t.*, e.status AS env_status
           FROM tasks t
           -- 不限 running：理由同列表 route（環境被回收後入口不得消失）
           LEFT JOIN odoo_envs e ON e.project_id = t.project_id
          WHERE t.id = $1 AND (t.user_id = $2 OR $3 = true) AND t.is_hidden = false`,
        [req.params.id, req.userId, !!req.isAdmin]
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
      // AI 回話期間（clarify_chat_running）也要照出：題目一消失，畫面就整塊換成通用留言框，
      // 使用者每問一句就被踢離「提問」頁籤，回來還得自己切回去。只認回程是 confirm_pending 的那種。
      const showClar = tasks[0].status === 'confirm_pending'
        || (tasks[0].status === 'clarify_chat_running' && tasks[0].clarify_from === 'confirm_pending');
      const clarification = showClar ? taskClarification(tasks[0]) : { summary: '', intro: '', questions: [] };
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
      const task = await loadTaskForActor(req.params.id, req, 'id, project_id, git_branch');
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (!task.project_id || !task.git_branch) return res.status(400).json({ error: '此任務沒有專案分支，無可檢視的程式變更' });

      const { getProjectInfo } = require('./pipeline/task-agent');
      const { AI_BRANCH, refExists, diffBranch } = require('./pipeline/git');
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
        // diff 基底＝任務切點 ai-dev：用 main 會讓審核者看到其他已核准任務夾雜其中的改動
        const baseBranch = AI_BRANCH;
        let diff = await diffBranch(repo.local_path, baseBranch, task.git_branch);
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
      const task = await loadTaskForActor(req.params.id, req, 'id, status');
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.status !== 'new') {
        return res.status(400).json({ error: '任務已進入處理流程，無法修改內容' });
      }
      const { original_text } = req.body || {};
      if (!original_text || !String(original_text).trim()) {
        return res.status(400).json({ error: '請填寫內容' });
      }
      await query(
        'UPDATE tasks SET original_text = $2, updated_at = NOW() WHERE id = $1',
        [task.id, String(original_text)]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 外部溝通紀錄：sync 拉進來的聊天紀錄 + 使用者手動追加的留言，新到舊排序（畫面顯示用）
  app.get('/api/tasks/:id/messages', verifyToken, async (req, res) => {
    try {
      const task = await loadTaskForActor(req.params.id, req, 'id');
      if (!task) return res.status(404).json({ error: 'Task not found' });
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
      const task = await loadTaskForActor(req.params.id, req, 'id, task_id, source, user_id');
      if (!task) return res.status(404).json({ error: 'Task not found' });
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
          const result = await writebackTaskMessage(task.user_id, task, trimmed, attachmentRows);
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
         WHERE a.id = $1 AND a.task_id = $2 AND (t.user_id = $3 OR $4 = true)`,
        [req.params.attId, req.params.id, req.userId, !!req.isAdmin]
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
      const task = await loadTaskForActor(req.params.id, req, 'id');
      if (!task) return res.status(404).json({ error: 'Task not found' });

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
      const task = await loadTaskForActor(req.params.id, req, 'id');
      if (!task) return res.status(404).json({ error: 'Task not found' });

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
      const task = await loadTaskForActor(req.params.id, req, 'id, is_paused, user_id');
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const newPaused = !task.is_paused;
      await query(
        'UPDATE tasks SET is_paused = $2, updated_at = NOW() WHERE id = $1',
        [req.params.id, newPaused]
      );
      if (newPaused) abortTask(req.params.id);
      else runPipeline(task.user_id).catch(err => console.error('[TASKS] pipeline error:', err.message));
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
      // 先撈出實際會被封存的那幾張（同樣受 user_id 限制），封存後才有依據判斷要不要把碼從 testing 收回
      const { rows: archiving } = await query(
        'SELECT id, project_id, git_branch FROM tasks WHERE id = ANY($1::int[]) AND (user_id = $2 OR $3 = true)',
        [ids, req.userId, !!req.isAdmin]
      );
      const { rowCount } = await query(
        'UPDATE tasks SET is_hidden = true, is_paused = false, updated_at = NOW() WHERE id = ANY($1::int[]) AND (user_id = $2 OR $3 = true)',
        [ids, req.userId, !!req.isAdmin]
      );
      const warnings = await reclaimTestingFrom(archiving, req.userId);
      res.json({ ok: true, affected: rowCount, warnings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/tasks/batch/unarchive', verifyToken, async (req, res) => {
    try {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      const { rowCount } = await query(
        'UPDATE tasks SET is_hidden = false, updated_at = NOW() WHERE id = ANY($1::int[]) AND (user_id = $2 OR $3 = true)',
        [ids, req.userId, !!req.isAdmin]
      );
      res.json({ ok: true, affected: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/tasks/:id/archive', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可封存任務' });
      const { rows } = await query('SELECT id, project_id, git_branch FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      abortTask(req.params.id); // 封存執行中任務：中止在飛 agent，否則子行程續跑到逾時（健檢項11）
      await query(
        "UPDATE tasks SET is_hidden = true, is_paused = false, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      const warnings = await reclaimTestingFrom(rows, req.userId);
      res.json({ ok: true, warnings });
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
      warnings.push(...await cleanupTaskGit(rows[0]));
      // 只清「任務生命週期」子表（隨任務死）。以下四張刻意「不」隨任務刪、保留為跨任務資料，勿再當漏刪補進來：
      //   token_usage       → 計費/成本歷史（token-report ?all=true 專門把已刪任務列為孤兒；刪了成本統計會縮水）
      //   prompt_logs       → 全域只留最新 100 筆的除錯 ring buffer，自動汰除（見 claude-runner）
      //   task_rejections   → 退回稽核＋分類器訓練語料（classify-rejections 餵訓練、admin 有獨立管理頁）
      //   classify_samples  → 分類器準確率訓練語料（admin 依 recorded_at 時窗統計）
      await query('DELETE FROM task_events WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM task_logs WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM task_attachments WHERE task_id = $1', [req.params.id]);
      deleteTaskDir(req.params.id); // 連帶清磁碟上的 uploads/task_<id>（否則實體檔變孤兒）
      await query('DELETE FROM task_messages WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
      invalidateEmbedding({ taskId: Number(req.params.id) }); // DB 有 CASCADE，記憶體快取沒有
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
        'SELECT id, task_id, project_id, git_branch, approved_at, analysis_yaml FROM tasks WHERE id = ANY($1::int[]) AND (user_id = $2 OR $3 = true)',
        [ids, req.userId, !!req.isAdmin]
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
      for (const t of deletable) warnings.push(...await cleanupTaskGit(t));
      // 同單筆刪除：只清任務生命週期子表；token_usage/prompt_logs/task_rejections/classify_samples 刻意保留（原因見上方單筆刪除註解）。
      await query('DELETE FROM task_events WHERE task_id = ANY($1::int[])', [delIds]);
      await query('DELETE FROM task_logs WHERE task_id = ANY($1::int[])', [delIds]);
      await query('DELETE FROM task_attachments WHERE task_id = ANY($1::int[])', [delIds]);
      delIds.forEach(id => deleteTaskDir(id)); // 連帶清各任務磁碟上的 uploads/task_<id>
      await query('DELETE FROM task_messages WHERE task_id = ANY($1::int[])', [delIds]);
      const { rowCount } = await query('DELETE FROM tasks WHERE id = ANY($1::int[])', [delIds]);
      delIds.forEach(id => invalidateEmbedding({ taskId: Number(id) })); // DB 有 CASCADE，記憶體快取沒有
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
        'UPDATE tasks SET is_paused = $2, updated_at = NOW() WHERE id = ANY($1::int[]) AND (user_id = $3 OR $4 = true)',
        [ids, paused, req.userId, !!req.isAdmin]
      );
      if (paused) ids.forEach(id => abortTask(id));
      // 批次代操作無單一 owner，保留 req.userId（admin 自己觸發一輪掃描即可；見 task-3-brief）
      else runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true, affected: rowCount, is_paused: paused });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });



  // 必答判定：depends_on 條件不滿足的題目不算必答（前端會收起來，後端也要一致，不能只靠前端擋）。
  // 條件指向不存在的題目時 fail open——照樣視為要顯示、要作答，寧可多問也不要題目憑空消失。
  function unansweredRequired(questions, answers) {
    const byId = new Map(questions.map(q => [q.id, q]));
    return questions.filter(q => {
      if (!q.required) return false;
      const dep = q.depends_on;
      if (dep && byId.has(dep.question) && String(answers[dep.question] ?? '') !== String(dep.equals)) return false;
      return !String(answers[q.id] ?? '').trim();
    });
  }

  // User answer to clarification question
  // 送出回答不再直接推進：先轉 clarify_chat_running 交給 clarify-chat agent 判斷使用者是答完了還是在反問。
  // （舊行為讓「我還是不懂，怎麼重現？」被當成有效答案直接開工——正式站 task 5。）
  // 掛 uploadAttachmentFiles：回覆 AI 的提問時可夾帶截圖（純 JSON 呼叫仍相容，multer 放行、req.files 空）。
  // 這是 clarify 閘門唯一的附件入口——停在這個狀態時，畫面上的留言框與退回框都被閘門面板取代了。
  app.post('/api/tasks/:id/answer', verifyToken, uploadAttachmentFiles, async (req, res) => {
    try {
      const task = await loadTaskForActor(req.params.id, req);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (!ANSWER_ALLOWED_STATUSES.includes(task.status)) {
        return res.status(400).json({ error: `Task status '${task.status}' does not accept answers` });
      }

      // 兩種輸入：新版逐題 answers 物件；舊版單一 user_answer 字串（clarify_pending 的自由文字框仍用）
      // multipart 送出時所有欄位都是字串，answers 需先還原成物件才走得到逐題分支。
      if (req.body && typeof req.body.answers === 'string') {
        try { req.body.answers = JSON.parse(req.body.answers); } catch { /* 非 JSON 就當沒帶，落到 user_answer 分支 */ }
      }
      const answers = req.body && typeof req.body.answers === 'object' && req.body.answers ? req.body.answers : null;
      let user_answer = (req.body && req.body.user_answer) || '';
      if (answers) {
        const { questions } = taskClarification(task);
        const missing = unansweredRequired(questions, answers);
        if (missing.length) {
          return res.status(400).json({ error: `還有必答的問題沒回答：${missing.map(q => q.text).join('、')}` });
        }
        user_answer = questions
          .filter(q => String(answers[q.id] ?? '').trim())
          .map(q => `問：${q.text}\n答：${String(answers[q.id]).trim()}`)
          .join('\n\n');
      }
      if (!user_answer.trim()) return res.status(400).json({ error: 'user_answer required' });

      // 條件更新防雙擊：輸掉競態的請求不再重複寫入回答。
      // clarify_from 記回程狀態、clarify_mode 記這次入口——執行器靠這兩欄還原情境。
      // 不可用 resume_status：那欄是 verdict-router／reject-triage 的「要回去哪一關」，覆寫會洗掉 QA 裁決的回程。
      const { rowCount } = await query(
        "UPDATE tasks SET status='clarify_chat_running', clarify_from=$2, clarify_mode='answer_or_proceed', updated_at=NOW() WHERE id = $1 AND status = $2",
        [req.params.id, task.status]
      );
      if (!rowCount) return res.json({ ok: true });
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, user_answer]
      );
      // 附件必須早於 runPipeline 寫入：taskAttachmentNote 是在 agent 起跑時才查 task_attachments，
      // 寫晚了這輪就讀不到（比照 pipeline-routes 人工退回同段時序）。寫在 rowCount 檢查之後，
      // 輸掉雙擊競態的請求不該落附件。
      for (const file of req.files || []) {
        const relPath = saveAttachmentFile(task.id, file.originalname, file.buffer);
        await query(
          `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
           VALUES ($1, $2, $3, $4, 'manual')`,
          [task.id, file.originalname, file.mimetype, relPath]
        );
      }
      if ((req.files || []).length) await query('UPDATE tasks SET has_attachment = true WHERE id = $1', [task.id]);
      require('./notify').emitToUser(task.user_id, 'task:updated', { taskId: Number(req.params.id), status: 'clarify_chat_running' });
      runPipeline(task.user_id).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 澄清關主動提問：只回答、永不推進（mode='ask' 在結構上就不允許 proceed）
  // 同樣掛 uploadAttachmentFiles：「我不懂，你指的是哪裡？」這種反問最需要配一張截圖，
  // 而提問與送出回答走的是兩個端點——只補其中一個，另一條路徑照樣傳不了東西。
  app.post('/api/tasks/:id/clarify-ask', verifyToken, uploadAttachmentFiles, async (req, res) => {
    try {
      const task = await loadTaskForActor(req.params.id, req);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (!ANSWER_ALLOWED_STATUSES.includes(task.status)) {
        return res.status(400).json({ error: `Task status '${task.status}' 不接受提問` });
      }
      const question = ((req.body && req.body.question) || '').trim();
      if (!question) return res.status(400).json({ error: '請填寫你的問題' });

      const { rowCount } = await query(
        "UPDATE tasks SET status='clarify_chat_running', clarify_from=$2, clarify_mode='ask', updated_at=NOW() WHERE id = $1 AND status = $2",
        [req.params.id, task.status]
      );
      if (!rowCount) return res.json({ ok: true });
      await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)", [req.params.id, question]);
      // 與 /answer 同一段時序：附件必須早於 runPipeline 落地（taskAttachmentNote 在 agent 起跑時才查），
      // 且寫在 rowCount 檢查之後——輸掉雙擊競態的請求不該落附件。
      for (const file of req.files || []) {
        const relPath = saveAttachmentFile(task.id, file.originalname, file.buffer);
        await query(
          `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
           VALUES ($1, $2, $3, $4, 'manual')`,
          [task.id, file.originalname, file.mimetype, relPath]
        );
      }
      if ((req.files || []).length) await query('UPDATE tasks SET has_attachment = true WHERE id = $1', [task.id]);
      require('./notify').emitToUser(task.user_id, 'task:updated', { taskId: Number(req.params.id), status: 'clarify_chat_running' });
      runPipeline(task.user_id).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve a blocked task — saves user's resolution note, resets status to new for retriage
  app.post('/api/tasks/:id/resolve-blocker', verifyToken, async (req, res) => {
    try {
      const task = await loadTaskForActor(req.params.id, req, 'id, status, resume_status, project_id, user_id');
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (!['stopped'].includes(task.status)) {
        return res.status(400).json({ error: '只有失敗待確認的任務可以重新處理' });
      }
      const { resolution } = req.body;
      if (!resolution?.trim()) return res.status(400).json({ error: '請填寫解決說明' });

      if (task.project_id) {
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
        const counterCol = RESUME_COUNTER[task.resume_status];
        await query(
          `UPDATE tasks SET status = COALESCE(resume_status, 'new'),
           blocker_content = NULL, blocker_type = NULL, resume_status = NULL,
           ${counterCol ? counterCol + ' = 0,' : ''} updated_at = NOW() WHERE id = $1`,
          [req.params.id]
        );
      }
      runPipeline(task.user_id).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
