const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query, withTransaction } = require('./db');
const { verifyToken } = require('./auth');
const { runGraphify } = require('./pipeline/graphify-runner');
// 背景路徑（triggerClone → updateMainClone → reconcileAiBranch）用得到的一律在這裡取。
// 那條路是 fire-and-forget，在測試裡會活過測試本身——延遲 require 會在 jest 環境拆掉之後才執行，
// 拋「trying to import a file after the Jest environment has been torn down」，全套測試零失敗卻 exit 1。
const { ensureTestingBranch, ensureMainBranch, pullBranch, ensureAiBranch, syncMainIntoAi, abortMerge, releaseAiToMain, getMainBranch, listRemoteBranches, setRemoteHead,
  aiBranchBase, aiBaseDrift, rebuildAiBranch, refExists, remoteAiRef } = require('./pipeline/git');
const { withProjectLock } = require('./pipeline/project-lock');
const { buildGitEnv } = require('./lib/git-identity');
const { deleteTaskDir } = require('./lib/attachments');

const REPOS_BASE = process.env.REPOS_BASE_DIR || path.resolve(__dirname, '..', '..', 'repos');

// 明列欄位，不用 SELECT */RETURNING *：projects 已存了 vpn_config_enc／vpn_username／vpn_password_enc
// （VPN 憑證密文），這些路由給一般已登入使用者，密文外流一樣是機密外洩。VPN 狀態改走專屬的
// GET /api/projects/:id/vpn（只回 has_config/vpn_username），這裡完全不帶三個 vpn_* 欄位。
const PROJECT_PUBLIC_COLS = 'id, name, odoo_version, description, created_at, updated_at, folder_name, port, odoo_project_name, service_respondent_name, e2e_disabled, spec_tour_enabled, edition';

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
  // 整個回呼包 try/catch：這是 async callback，往外拋就是 unhandled rejection——Node 20 會直接
  // 終止進程（實測一個同步 TypeError 就讓整個 server 掛掉）。內部每個 await 各自 .catch() 擋不住
  // 同步階段拋出的錯，也擋不住日後新增的呼叫忘了掛 catch，故在最外層兜底。
  execFile('git', ['clone', '--', repoUrl, destPath], cloneOpts, async (err, _stdout, stderr) => {
   try {
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
      // 遠端若已有 ai-dev（例：換 URL 重 clone、或這個 repo 先前就被平台用過），它可能還掛在舊基底上。
      // 排在 ensureTestingBranch 之前：testing 是以 ai-dev 為基準重長的，先扶正才不會把歪的帶下去。
      const notice = await reconcileAiBranch(destPath, null, gitEnv); // base 傳 null＝由它自己問主分支
      if (notice) console.warn(`[clone] repo ${repoId} [${notice.level}] ${notice.message}`);
      // 主 clone 常駐 testing 分支（GitLab Flow 環境分支，測試環境 addons 來源）
      try { await ensureTestingBranch(destPath); } catch { /* 不擋 clone 完成 */ }
      await query(
        // 只有 blocked（確定歪掉且救不了）才寫進 clone_error——前端無論 status 都會紅字顯示，
        // 語意是「需要你處理」。fixed 不必寫（沒事要做），warn 也不寫（只是沒查成功，寫了徒增雜訊）。
        'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
        [repoId, 'done', notice?.level === 'blocked' ? notice.message : null]
      ).catch(() => {});
      runGraphify(repoId, destPath);
    }
   } catch (e) {
     // 走到這裡代表上面漏了某個 catch。至少讓它留下痕跡，而不是把整個 server 帶走。
     console.error(`[clone] repo ${repoId} 回呼異常：${e && e.message}`);
   }
  });
}

// 同一個遠端可以有好幾種寫法：https://h/o/r.git、https://h/o/r/、git@h:o/r.git、ssh://git@h/o/r。
// 撞名守衛比對的是「是不是同一個 repo」，所以先收斂成 host/owner/name 再比。認不出來就回原字串
// （至少維持原本的完全相等比對），不要為了正規化而把兩個不同的 repo 判成同一個。
function normalizeRepoUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = s.match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+)$/);
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : s.toLowerCase();
}

// 把 ensureAiBranch 實際決定的遠端 AI 分支名記進 DB。撞名守衛唯一能信的就是這個值——它拿
// base_branch 現算會漏掉兩種真的會互相覆蓋的組合：(1) base_branch 為 null 時執行期改用偵測到的
// 主分支，算出來的名字與守衛算的不同；(2) 遠端已有裸 origin/ai-dev 時 ensureAiBranch 走「裸名
// 優先」完全無視 base_branch，於是所有既有 repo 一律同槽。best-effort：記不起來只是讓守衛退回
// 舊的推算方式，不該擋住 clone 完成。
async function recordRemoteAiBranch(repoId, repoPath) {
  try {
    const name = await remoteAiRef(repoPath);
    if (name) await query('UPDATE project_repos SET remote_ai_branch=$2 WHERE id=$1', [repoId, name]);
  } catch (e) {
    console.warn(`[recordRemoteAiBranch] repo ${repoId} 記錄遠端 AI 分支失敗：${e.message}`);
  }
}

// 把歪掉的 ai-dev 基底扶正。ai-dev 是 ensureAiBranch 在「建立當下的主分支」上長的，主分支之後
// 才被改對也不會自己跟上，同步從此是兩條平行線硬合（詳見 git.js 的 aiBranchBase 註解）。
// 零 AI 產出才重建；有產出就不動它，只回報——那些 commit 只存在於 ai-dev，重建即永久遺失。
// 回 null（無事）或 { level, message }，永不往外拋。level 必須分得夠細，因為呼叫端要據此決定
// 要不要中止同步——早期版本用「訊息開頭是不是 ⚠️」判斷，把「確定歪掉」和「偵測本身出錯」混成
// 一類，於是任何一個 git 探測失敗都會讓整個 reclone 變 error（規則 81：repo 一 error 就從
// pipeline 消失）。三種語意分開：
//   fixed   已扶正，無需任何人處理
//   blocked 基底確定不符且有 AI 產出，硬同步注定衝突 → 呼叫端應停下
//   warn    偵測不完整（git 探測失敗等），不知道歪沒歪 → 只記錄，照常往下走
// base 傳 null＝由本函式自己問 getMainBranch。刻意讓呼叫端能省略：首次 clone 那條路上取主分支
// 本身也可能拋（背景回呼跑在任何時間點，模組狀態不保證還在），放進這裡的 try 才不會炸到外面。
async function reconcileAiBranch(repoPath, base, gitEnv) {
  try {
    const effBase = base || await getMainBranch(repoPath);
    if (!effBase) return null;
    // 遠端的 ai 分支可能帶主分支後綴（多專案共用同一 repo），一律問 upstream，不可寫死 ai-dev
    const remoteAi = await remoteAiRef(repoPath);
    if (!await refExists(repoPath, `refs/remotes/origin/${remoteAi}`)) return null; // 還沒有＝之後自然長在對的分支上
    // 判「歪沒歪」一律走 aiBaseDrift 的正面驗證，不可用 aiBranchBase 反推——base 領先 ai-dev 時
    // 後者取不到 base（詳見 git.js 該函式註解），基底正確卻會被判 blocked。
    const { drifted, own } = await aiBaseDrift(repoPath, effBase);
    if (drifted === null) return { level: 'warn', message: `ai-dev 基底檢查未完成：無法比對 ${effBase} 與 ${remoteAi}` };
    if (!drifted) return null;                                                      // 基底正確（絕大多數）
    // 確定歪了才推導「到底長在哪」：那段要對每條已合併分支各 spawn 一次，不放在常態路徑上
    const actual = await aiBranchBase(repoPath, effBase);                           // 推導不出來就別寫成「從 null」
    const origin = actual ? `是從 ${actual} 長出來的` : '夾帶了其他分支的歷史';
    const from = actual ? `從 ${actual} ` : '';
    if (own !== 0) {
      return { level: 'blocked', message: `ai-dev ${origin}，但主分支是 ${effBase}；其上已有 ${own} 個 AI 產出，未自動重建。請先在 GitHub 上把 ai-dev 合併回 ${effBase}` };
    }
    const { oldSha } = await rebuildAiBranch(repoPath, effBase, gitEnv);
    return { level: 'fixed', message: `ai-dev 基底已${from}重建到 ${effBase}（舊 HEAD ${String(oldSha || '').slice(0, 7)}）` };
  } catch (e) {
    return { level: 'warn', message: `ai-dev 基底檢查未完成：${e.message}` };
  }
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
    await recordRemoteAiBranch(repoId, destPath);
    // 扶正基底必須排在 syncMainIntoAi 之前：基底歪掉時那次 merge 就是「兩條平行線硬合」，
    // 會炸出一整包看似內容衝突的假象（實測 28 檔），而真因只是 ai-dev 長錯地方。
    const aiNotice = await reconcileAiBranch(destPath, base, gitEnv);
    if (aiNotice) console.warn(`[updateMainClone] repo ${repoId} [${aiNotice.level}] ${aiNotice.message}`);
    if (aiNotice?.level === 'blocked') {
      // 扶不正就不要硬同步：那次 merge 注定衝突，還會把 ai-dev 弄成待解狀態。停在這裡讓人處理。
      // 只有 blocked 才擋——warn 代表「不確定」，不確定不足以中止使用者的更新。
      //
      // 但**不可** throw：外層 catch 會把 repo 標成 clone_status='error'，而全平台撈 repo 一律
      // WHERE clone_status='done'（規則 81），repo 一 error 就從 pipeline 消失——該專案所有任務
      // 立刻撈不到 repo、approve 直接 400。這正是本函式註解列為要避免的後果：偵測到問題不等於
      // 要讓 repo 從平台上消失。改成把原因寫進 clone_error 但維持 done：pull 與 ensureAiBranch
      // 都已成功，這個 clone 本身是可用的，只是 main→ai-dev 這一步沒做。
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
        [repoId, 'done', aiNotice.message.slice(0, 500)]
      );
      // ensureAiBranch 已把主 clone 切到 ai-dev，這裡要切回常駐分支，否則下次 deploy 會部署到錯分支
      try { await ensureTestingBranch(destPath); } catch { /* 回常駐分支失敗不擋 */ }
      return;
    }
    const sync = await syncMainIntoAi(destPath, gitEnv);
    if (sync.hasConflicts) {
      // 此處不綁任何任務，沒有裁決 UI 可用。abort 還原讓 ai-dev 維持原狀並 fail loud。
      // 訊息只留「去 GitHub 合併」這條：外層 catch 會把 repo 標成 clone_status='error'，而全平台
      // 撈 repo 一律 WHERE clone_status='done'——repo 一旦是 error 就從 pipeline 消失，「開一張任務
      // 處理」保證撈到 0 個 repo、approve 直接 400，那是條死路，不能寫進指示裡。
      await abortMerge(destPath);
      // 分支名一律用實際的 base，不可寫死 'main'：主分支叫別的名字時（origin/HEAD 指向它、或使用者
      // 指定），訊息會把人指到一條根本不相干的分支上——實測某專案的訊息說「main → ai-dev 衝突、
      // 請把 ai-dev 合併回 main」，但 main 合進 ai-dev 其實 0 衝突，真正在合的是 kangyue。
      // 檔名也要截斷：28 個檔名全塞進 clone_error 會把畫面灌爆，看的人反而抓不到重點。
      const shown = sync.conflictFiles.slice(0, 5).join(', ');
      const more = sync.conflictFiles.length > 5 ? ` 等 ${sync.conflictFiles.length} 個檔案` : '';
      throw new Error(`${base} → ai-dev 同步衝突（${shown}${more}），請先在 GitHub 上把 ai-dev 合併回 ${base} 再更新`);
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
      const { name, odoo_version, description, folder_name, odoo_project_name, service_respondent_name, e2e_disabled, spec_tour_enabled } = req.body;
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
      if ('spec_tour_enabled' in req.body) setDirect('spec_tour_enabled', !!spec_tour_enabled);
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
        return res.json({ branches: [], base_branch: repo.base_branch, effective: null, ai_branch: null, ready: false });
      }
      const branches = await listRemoteBranches(repo.local_path).catch(() => []);
      const effective = await getMainBranch(repo.local_path).catch(() => null);
      // AI 分支在遠端的實際名字：既有專案是裸 ai-dev、新專案帶主分支後綴，兩種並存，
      // 不顯示的話使用者到 GitHub 上會找不到自己的那條。
      const { remoteAiRef } = require('./pipeline/git');
      const ai_branch = await remoteAiRef(repo.local_path).catch(() => null);
      res.json({ branches, base_branch: repo.base_branch, effective, ai_branch, ready: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 新增 repo 前先讀遠端分支：主分支只有這一次機會可選（PUT 之後就鎖死），所以要在還沒 clone
  // 的當下就能列給人挑。走 ls-remote 而非 listRemoteBranches（後者要有本地 clone 才行）。
  // 失敗一律回 200 + 空清單：私有 repo 沒 PAT、網址打錯都會失敗，但那不該擋住新增流程
  // （沿用首次 clone 的 best-effort 態度），前端降級成自動偵測即可。
  app.get('/api/git/remote-branches', verifyToken, async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return res.json({ branches: [], defaultBranch: null, ok: false, reason: '未提供網址' });
    // 與 triggerClone 同一條白名單：少了它，`/path/to/repo` 或 `file://` 會讓這個端點變成
    // 「列出平台主機上任意 git repo 的分支」的探測器，而它只要 verifyToken 就能打。
    if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(url)) {
      return res.json({ branches: [], defaultBranch: null, ok: false, reason: '不支援的 Git URL 格式' });
    }
    try {
      const { listRemoteBranchesByUrl } = require('./pipeline/git');
      const r = await listRemoteBranchesByUrl(url, await optionalGitEnv(req.userId));
      res.json({ ...r, ok: true });
    } catch (err) {
      res.json({ branches: [], defaultBranch: null, ok: false, reason: (err.stderr || err.message || '').slice(0, 200) });
    }
  });

  app.post('/api/projects/:id/repos', verifyToken, async (req, res) => {
    try {
      const { label, repo_url, is_primary, base_branch } = req.body;
      if (!label || !repo_url) return res.status(400).json({ error: 'label and repo_url required' });

      const { rows: [project] } = await query('SELECT folder_name, name FROM projects WHERE id=$1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      // 同一個客戶 repo 可以被多個專案使用（跟不同主分支平行開發），但兩個專案不能落在同一條
      // 遠端 ai 分支上——那會讓雙方的 AI 產出互相 force push 覆蓋，而且是靜默的。遠端名由主分支
      // 決定，所以「同 repo_url ＋ 同主分支」就是撞名。比對算出來的分支名而非主分支原值，
      // 才能連 feature/x 與 feature-x 這種正規化後才撞的邊角一起擋掉。
      {
        const { remoteAiBranchName, AI_BRANCH } = require('./pipeline/git');
        const mine = remoteAiBranchName(base_branch || '');
        // repo_url 用正規化後的值比對：差一個 `.git`、一條尾斜線、或 https 與 git@ 寫法不同，
        // 指的都是同一個遠端，但字串完全相等比對會全部放行。
        const { rows: siblings } = await query(
          'SELECT project_id, base_branch, repo_url, remote_ai_branch FROM project_repos WHERE project_id<>$1',
          [req.params.id]
        );
        const mineUrl = normalizeRepoUrl(repo_url);
        const sameRepo = siblings.filter(s => normalizeRepoUrl(s.repo_url) === mineUrl);
        // 對方已經記下實際落點就比對它，否則才退回用 base_branch 推算（尚未 clone 完的新列）。
        // 已經坐在裸 ai-dev 上的既有 repo 一律撞——那條分支不帶主分支後綴，誰進來都會共用它。
        const clash = sameRepo.find(s => {
          const theirs = s.remote_ai_branch || remoteAiBranchName(s.base_branch || '');
          return theirs === mine || theirs === AI_BRANCH;
        });
        if (clash) {
          const theirs = clash.remote_ai_branch || remoteAiBranchName(clash.base_branch || '');
          // 對方是「還沒記下落點的自動偵測」時，我們並不知道它最後會落在哪，只知道有機會撞上。
          // 講白比假裝確定好：使用者看得懂該去把對方的主分支指定清楚，而不是以為自己選錯分支。
          const unknown = !clash.remote_ai_branch && !clash.base_branch;
          return res.status(409).json({
            error: unknown
              ? `專案 #${clash.project_id} 也在用這個 repo，且它的主分支是自動偵測、尚未確定會落在哪條遠端 AI 分支上，可能與本專案共用同一條而互相覆蓋。請先為該專案指定主分支（或等它 clone 完成）後再試。`
              : `專案 #${clash.project_id} 已經以「${clash.base_branch || '自動偵測'}」使用這個 repo，兩者會共用同一條遠端 AI 分支（${theirs}）而互相覆蓋。請改選其他主分支。`,
          });
        }
      }

      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }

      const destPath = computeDestPath(project.folder_name || project.name, label);
      const { rows } = await query(
        `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status, base_branch)
         VALUES ($1, $2, $3, $4, $5, 'cloning', $6) RETURNING *`,
        // 主分支在此刻定案（之後 PUT 會擋）。null＝沿用遠端 HEAD，triggerClone 那邊會照 origin/HEAD 走。
        [req.params.id, label, repo_url, destPath, is_primary || false, base_branch || null]
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

      // 主分支只能在新增 repo 時決定，之後不得修改：ai-dev 是建立當下從主分支長出來的，事後改
      // 主分支並不會讓它跟著搬家，於是同步變成兩條平行線硬合（實測某專案因此在 28 檔衝突）。
      // 與其容許一個必然造成不一致的入口再去偵測補救，不如關掉它——要換分支請刪掉 repo 重加。
      // 送相同值不算改動（前端整包 PUT 會原樣帶回來），只有真的要改才擋。
      const nextBaseBranch = existing.base_branch;
      if (base_branch !== undefined && (base_branch || null) !== existing.base_branch) {
        return res.status(400).json({
          error: `主分支不能事後修改（目前：${existing.base_branch || '自動偵測'}）。ai-dev 已經長在它上面，改設定不會讓 ai-dev 跟著搬家。請刪除這個 repo 後重新新增並選擇正確的主分支。`,
        });
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

      // base_branch 已不可變，故此處無需再套 origin/HEAD——新增時 triggerClone 那段已經設好，
      // 換 URL 時下面的 triggerClone 會重新套用一次。
      if (urlChanged) {
        triggerClone(req.params.id, rows[0].id, rows[0].repo_url, newLocalPath, await optionalGitEnv(req.userId), req.userId);
      }
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 任務工作樹住在主 clone 的 sibling：`<專案根>/.worktrees/<task_id>/<repo 目錄名>`（見
  // task-agent.js 的 worktreeParent）。移除 repo 只刪 local_path 的話，它們會整批留在磁碟上
  // （每份約 58MB），而且同一個 repo 再加回來時，殘骸的 `.git` 指向已消失的 admin 目錄——
  // 那正是正式站 task_service_3900 卡死的來源。同一層還有別的 repo 的工作樹，只能逐一挑掉自己的。
  // 非同步刪：每份工作樹約 58MB，任務一多就是好幾 GB，同步版會把 event loop 卡住整段時間——
  // 全平台的 API 與 socket 一起停擺。同一個 handler 隔二十行的主 clone 刪除本來就已是非同步。
  async function removeRepoWorktrees(localPath) {
    const wtRoot = path.join(path.dirname(localPath), '.worktrees');
    const subdir = path.basename(localPath);
    let taskDirs;
    try { taskDirs = await fs.promises.readdir(wtRoot); } catch { return; } // 沒有 .worktrees＝這 repo 沒跑過任務
    for (const t of taskDirs) {
      await fs.promises.rm(path.join(wtRoot, t, subdir), { recursive: true, force: true })
        .catch(() => { /* 刪不掉就留著，不擋移除 repo */ });
    }
  }

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
        await removeRepoWorktrees(repo.local_path);   // 維持原本「回應前已刪完」的語意，只是不再卡住 event loop
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
