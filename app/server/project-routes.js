const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query, withTransaction } = require('./db');
const { verifyToken } = require('./auth');
// 背景路徑（triggerClone → updateMainClone → reconcileAiBranch）用得到的一律在這裡取。
// 那條路是 fire-and-forget，在測試裡會活過測試本身——延遲 require 會在 jest 環境拆掉之後才執行，
// 拋「trying to import a file after the Jest environment has been torn down」，全套測試零失敗卻 exit 1。
const { ensureTestingBranch, ensureMainBranch, pullBranch, ensureAiBranch, syncMainIntoAi, abortMerge, releaseAiToMain, getMainBranch, listRemoteBranches, setRemoteHead,
  aiBranchBase, aiBaseDrift, rebuildAiBranch, refExists, remoteAiRef } = require('./pipeline/git');
const { withProjectLock } = require('./pipeline/project-lock');
const { buildGitEnv } = require('./lib/git-identity');
const { deleteTaskDir, deleteChatDir } = require('./lib/attachments');
const { loadProjectForActor, canReleaseProject, requirePlatformAdmin } = require('./lib/tenant-access');

const REPOS_BASE = process.env.REPOS_BASE_DIR || path.resolve(__dirname, '..', '..', 'repos');

// 明列欄位，不用 SELECT */RETURNING *：projects 已存了 vpn_config_enc／vpn_username／vpn_password_enc
// （VPN 憑證密文），這些路由給一般已登入使用者，密文外流一樣是機密外洩。VPN 狀態改走專屬的
// GET /api/projects/:id/vpn（只回 has_config/vpn_username），這裡完全不帶三個 vpn_* 欄位。
const PROJECT_PUBLIC_COLS = 'id, name, odoo_version, description, created_at, updated_at, folder_name, port, odoo_project_name, service_respondent_name, service_contact_name, e2e_disabled, edition, auto_deploy_enabled';
// ⚠ GET /api/projects 用 `PROJECT_PUBLIC_COLS.replace('created_at', 'p.created_at')` 把裸欄位
// 改成帶別名——這是「第一個出現的字串」取代，現在正確只因為 project_companies 剛好只跟 projects
// 撞名 created_at 這一個欄位。以後在這裡加欄位，若新欄位跟 project_companies（或其他被 JOIN 進來
// 的表）同名，這個 .replace() 只會換掉「第一個出現的那個」，另一個同名欄位會漏改、留下裸欄位造成
// ambiguous column 或改錯目標——加欄位時務必回頭檢查那個呼叫點。

// folder_name 同時決定三個外部識別：測試容器名 odoo-test-<folder>、環境目錄 odoo-envs/<folder>、
// 測試資料庫 test_<folder>。容器名只吃 [a-zA-Z0-9_.-]，過去這裡不驗格式，填中文會被靜默清成一串
// `-` 再被剝光 → 所有純中文專案共用同一個容器名而互相砍掉（見 lib/docker-env.containerNameFor）。
// 「填了卻無效且沒人告訴你」是最糟的形式，所以當場擋下並說明。
// 不允許 `.`：目錄名以點開頭會變隱藏檔。上限 40——Postgres 資料庫名上限 63 bytes，`test_` 前綴另計。
const FOLDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const FOLDER_NAME_MAX = 40;
function validateFolderName(value, { required } = {}) {
  const v = String(value || '').trim();
  if (!v) return required ? '請填寫資料夾名稱（測試環境的容器、目錄與資料庫都用它命名）' : null;
  if (!FOLDER_NAME_RE.test(v)) return '資料夾名稱只能使用英文、數字、底線與連字號（例：lingyue-bio）——中文會讓測試環境無法正確建立';
  if (v.length > FOLDER_NAME_MAX) return `資料夾名稱最多 ${FOLDER_NAME_MAX} 個字元`;
  return null;
}

async function isAdminUser(userId) {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [userId]);
  return !!(rows.length && rows[0].role === 'admin');
}

async function requireAdmin(req, res, next) {
  try {
    if (!await isAdminUser(req.userId)) {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 可能回空字串——「slug 不出東西」是呼叫端要分辨的資訊（見 repoDirName），不可在這裡吞掉。
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function slugify(s) {
  return slug(s) || 'repo';
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

// repo 的目錄名。label 是使用者取的顯示名，中文居多——slug 出來是空字串，舊版一律退成 'repo'，
// 於是同一專案下**每個**純中文 label 的 repo 都算出同一個路徑：第二個 repo 的 destPath 已存在
// `.git`，triggerClone 會判成「已 clone」轉去 updateMainClone，等於拿新 URL 去更新別人的 clone
// （project_repos 只有 label 唯一約束，local_path 沒有，擋不住）。退回 URL 上的 repo 名比 'repo'
// 有意義，再撞就綴序號——目錄名同時是 worktree 的子目錄名與容器內的 addons 掛載點，必須唯一。
// taken：同專案已被佔用的目錄名集合（呼叫端查 project_repos 給）。
function repoDirName(label, repoUrl, taken = new Set()) {
  const fromUrl = slug(String(repoUrl || '').replace(/\.git$/i, '').split(/[/:]/).filter(Boolean).pop());
  const base = slug(label) || fromUrl || 'repo';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

// 同專案已被佔用的 repo 目錄名（excludeId＝正在編輯的那筆，它自己的舊路徑不算佔用）
async function takenRepoDirs(projectId, excludeId = null) {
  const { rows } = await query(
    'SELECT id, local_path FROM project_repos WHERE project_id=$1 AND local_path IS NOT NULL', [projectId]
  );
  return new Set(rows.filter(r => r.id !== excludeId).map(r => path.basename(r.local_path)).filter(Boolean));
}

function computeDestPath(projectFolder, label, repoUrl, taken) {
  return path.join(REPOS_BASE, slugify(projectFolder), repoDirName(label, repoUrl, taken));
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
      'UPDATE project_repos SET clone_status=$2, clone_error=$3, clone_status_at=NOW() WHERE id=$1',
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
        'UPDATE project_repos SET clone_status=$2, clone_error=$3, clone_status_at=NOW() WHERE id=$1',
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
      // 回寫這個 repo 的遠端 AI 分支落點。舊版只在 updateMainClone（已 clone 的「更新」路徑）記，
      // 首次 clone 一律留 NULL——於是新加的 repo 永遠沒有落點可查，撞名守衛只能拿 base_branch 推算，
      // 而 base_branch 也沒指定時就完全判不出來（正式資料 7 筆有 5 筆 remote_ai_branch 是 NULL）。
      // 此刻本地 ai-dev 多半還沒建，但 remoteAiRef 用的是與 ensureAiBranch 相同的優先序（遠端有裸
      // ai-dev 就沿用它，否則帶主分支後綴），推出來的正是之後真的會落腳的那條。
      await recordRemoteAiBranch(repoId, destPath);
      await query(
        // 只有 blocked（確定歪掉且救不了）才寫進 clone_error——前端無論 status 都會紅字顯示，
        // 語意是「需要你處理」。fixed 不必寫（沒事要做），warn 也不寫（只是沒查成功，寫了徒增雜訊）。
        'UPDATE project_repos SET clone_status=$2, clone_error=$3, clone_status_at=NOW() WHERE id=$1',
        [repoId, 'done', notice?.level === 'blocked' ? notice.message : null]
      ).catch(() => {});
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
        'UPDATE project_repos SET clone_status=$2, clone_error=$3, clone_status_at=NOW() WHERE id=$1',
        [repoId, 'done', aiNotice.message.slice(0, 500)]
      );
      // ensureAiBranch 已把主 clone 切到 ai-dev，這裡要切回常駐分支，否則下次 deploy 會部署到錯分支
      try { await ensureTestingBranch(destPath); } catch { /* 回常駐分支失敗不擋 */ }
      return;
    }
    const sync = await syncMainIntoAi(destPath, gitEnv);
    if (sync.hasConflicts) {
      // 此處不綁任何任務，沒有裁決 UI 可用。abort 還原讓 ai-dev 維持原狀並 fail loud。
      // 訊息只留「去 GitHub 合併」這條：「開一張任務處理」在 repo 出狀況時保證撈到 0 個 repo、
      // approve 直接 400，那是條死路，不能寫進指示裡。
      await abortMerge(destPath);
      // 分支名一律用實際的 base，不可寫死 'main'：主分支叫別的名字時（origin/HEAD 指向它、或使用者
      // 指定），訊息會把人指到一條根本不相干的分支上——實測某專案的訊息說「main → ai-dev 衝突、
      // 請把 ai-dev 合併回 main」，但 main 合進 ai-dev 其實 0 衝突，真正在合的是 kangyue。
      // 檔名也要截斷：28 個檔名全塞進 clone_error 會把畫面灌爆，看的人反而抓不到重點。
      const shown = sync.conflictFiles.slice(0, 5).join(', ');
      const more = sync.conflictFiles.length > 5 ? ` 等 ${sync.conflictFiles.length} 個檔案` : '';
      // 與上面的 blocked 分支同一個道理，**不可** throw：外層 catch 會把 repo 標成
      // clone_status='error'，而全平台撈 repo 一律 WHERE clone_status='done'（規則 81）——repo 一
      // error 就從 pipeline 消失，該專案所有任務立刻撈不到 repo、approve 直接 400。abortMerge 已把
      // ai-dev 還原，pull 與 ensureAiBranch 也都成功，這個 clone 本身可用，只是 main→ai-dev 這一步
      // 沒做；把原因寫進 clone_error（前端無論 status 都會紅字顯示）但維持 done。
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=$3, clone_status_at=NOW() WHERE id=$1',
        [repoId, 'done', `${base} → ai-dev 同步衝突（${shown}${more}），請先在 GitHub 上把 ai-dev 合併回 ${base} 再更新`.slice(0, 500)]
      );
      // ensureAiBranch 已把主 clone 切到 ai-dev，這裡要切回常駐分支，否則下次 deploy 會部署到錯分支
      try { await ensureTestingBranch(destPath); } catch { /* 回常駐分支失敗不擋 */ }
      return;
    }
    // 先回寫 done 再重建 testing，順序不可倒：doRebuild 撈 repo 帶 `WHERE clone_status='done'`，
    // 而 reclone 端點進來就把本 repo 標成 'cloning'——先重建的話它撈到 0 個 repo、直接 return null
    // （＝乾淨完成），testing 永遠不會被重長，連下面那道 fail-loud 都不會觸發。
    // 提早回寫不會讓 pipeline 插隊：整段仍在 triggerClone 的 withProjectLock 內，pipeline 的
    // git 操作拿不到鎖。此刻 pull 與 main→ai-dev 同步都已成功，這個 clone 本來就已經是 done。
    await query(
      'UPDATE project_repos SET clone_status=$2, clone_error=NULL, clone_status_at=NOW() WHERE id=$1',
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
  } catch (err) {
    const msg = (err.stderr || err.message || 'update failed').slice(0, 500);
    await query(
      'UPDATE project_repos SET clone_status=$2, clone_error=$3, clone_status_at=NOW() WHERE id=$1',
      [repoId, 'error', msg]
    ).catch(() => {});
  }
}

function registerRoutes(app) {
  // --- Projects ---

  app.get('/api/projects', verifyToken, async (req, res) => {
    try {
      // 租戶範圍（規格 §5.2）：平台管理員看全部；其他人只看自己公司綁到的專案。
      // 在 SQL 裡 JOIN 過濾，不要撈全部再用 JS 篩——後者在專案變多時是 N 筆傳輸，
      // 而且「忘記篩」的失敗方式是靜默外洩。
      // 內部公司刻意不特判：它看得到全部是因為遷移把全部綁給它了。
      // PROJECT_PUBLIC_COLS 是不帶別名的裸欄位清單，project_companies 也有 created_at，
      // JOIN 之後裸列會 ambiguous column——只在這個呼叫點補上 p. 別名，常數本身不動
      // （其餘呼叫點沒有 JOIN，加別名反而會查不到欄位）。
      const scopedCols = PROJECT_PUBLIC_COLS.replace('created_at', 'p.created_at');
      // can_release（側欄「上正式」按鈕要靠它算 v-if，見 UiNextApp.js）：JOIN 本來就在，
      // 順手多帶 pc.can_release 出來，不要逐筆 await canReleaseProject——17 個專案就是 17 次
      // 額外查詢。判準要跟 canReleaseProject（lib/tenant-access.js）完全一致：平台管理員必過；
      // 其餘要「是公司管理員」且「這個專案對這家公司的綁定勾了 can_release」才算，兩者缺一都是
      // false。平台管理員這條路沒有 JOIN，pc.can_release 撈不到，在下面組回應時另外補 true。
      const { rows: projects } = req.actor.isPlatformAdmin
        ? await query(`SELECT ${PROJECT_PUBLIC_COLS} FROM projects ORDER BY name ASC`)
        : await query(
            `SELECT ${scopedCols}, pc.can_release FROM projects p
               JOIN project_companies pc ON pc.project_id = p.id AND pc.company_id = $1
              ORDER BY p.name ASC`,
            [req.actor.companyId]
          );
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
        // 平台管理員一律 true（見上方註解）；否則沿用 pc.can_release，但一般使用者即使綁定
        // 有勾也不算——那顆勾是公司管理員的權限，不是全公司的（規格 §4.3）。
        can_release: req.actor.isPlatformAdmin || (req.actor.isCompanyAdmin && p.can_release === true),
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
      // 看不到就當它不存在（規格 §5.2）——回 403 等於告訴對方「這個 id 存在，只是你不能看」
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
      await query(
        'INSERT INTO project_favorites (user_id, project_id) VALUES ($1, $2) ON CONFLICT (user_id, project_id) DO NOTHING',
        [req.userId, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/favorite', verifyToken, async (req, res) => {
    try {
      // 看不到就當它不存在（規格 §5.2）——回 403 等於告訴對方「這個 id 存在，只是你不能看」
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
      await query('DELETE FROM project_favorites WHERE user_id = $1 AND project_id = $2', [req.userId, req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects', verifyToken, requirePlatformAdmin, async (req, res) => {
    try {
      const { name, odoo_version, description, folder_name, edition } = req.body;
      if (!name || !odoo_version) return res.status(400).json({ error: 'name and odoo_version required' });
      if (edition !== undefined && !EDITIONS.includes(edition)) {
        return res.status(400).json({ error: 'edition 只能是 community 或 enterprise' });
      }
      const folderErr = validateFolderName(folder_name, { required: true });
      if (folderErr) return res.status(400).json({ error: folderErr });
      // 測試埠不在此配發：已改為租約制，由 env-agent 於「啟動測試區」時向池借、停止時歸還
      // （見 port-alloc.js leasePort）。建立時就佔埠會讓沒開過測試區的專案白白吃掉併發槽。
      const project = await withTransaction(async (client) => {
        const { rows } = await client.query(
          // 新建專案預設關閉 E2E（e2e_disabled=true）；明確寫死於 INSERT 而非靠欄位 DEFAULT，
          // 因現有 DB 的欄位 DEFAULT 早已凍結成 false，改 schema 對現有機器無效。
          `INSERT INTO projects (name, odoo_version, description, folder_name, e2e_disabled, edition)
           VALUES ($1, $2, $3, $4, true, $5) RETURNING ${PROJECT_PUBLIC_COLS}`,
          [name, odoo_version, description || null, folder_name || null, edition || 'community']
        );
        const proj = rows[0];
        // 租戶隔離規格 §4.3：新建專案同一交易內自動綁內部公司（can_release=false），
        // 否則遷移跑完後新專案綁定數是 0，canSeeProject 對所有非平台管理員回 false，
        // GET /api/tasks 仍 200（列表不過濾）但每一張任務一開就 404，且完全無錯誤訊號。
        // 用 is_internal 找、不用名字找：名字未來可被公司管理員改（見 tools/migrate-tenants.js 同理由）。
        // 遷移還沒跑之前沒有內部公司，此時就是 no-op，讓建立專案在那個窗口照常可用。
        const { rows: internalRows } = await client.query(
          'SELECT id FROM companies WHERE is_internal = true LIMIT 1'
        );
        if (internalRows[0]) {
          await client.query(
            'INSERT INTO project_companies (project_id, company_id, can_release) VALUES ($1, $2, false)',
            [proj.id, internalRows[0].id]
          );
        }
        return proj;
      });
      return res.status(201).json(project);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id(\\d+)', verifyToken, async (req, res) => {
    try {
      // 看不到就當它不存在（規格 §5.2）——回 403 等於告訴對方「這個 id 存在，只是你不能看」
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
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
      // can_release：單一專案這裡是一筆資料，沒有 N+1 疑慮，直接呼叫既有判準
      // （lib/tenant-access.js），不要在路由裡重寫一份判斷邏輯。
      const can_release = await canReleaseProject(req.actor, req.params.id);
      res.json({ ...project, repos, unread_count: Number(unreadRow ? unreadRow.unread : 0), has_wiki: Number(wikiRow ? wikiRow.cnt : 0) > 0, can_release });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/projects/:id', verifyToken, requirePlatformAdmin, async (req, res) => {
    try {
      const { name, odoo_version, description } = req.body;
      const { rows } = await query(
        `UPDATE projects SET
           name = COALESCE($2, name),
           odoo_version = COALESCE($3, odoo_version),
           description = COALESCE($4, description),
           updated_at = NOW()
         WHERE id = $1 RETURNING ${PROJECT_PUBLIC_COLS}`,
        [
          req.params.id,
          name || null,
          odoo_version || null,
          Object.prototype.hasOwnProperty.call(req.body, 'description') ? (description ?? '') : null,
        ]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 租戶隔離規格 §2：建專案／加 repo 對客戶關閉，改成平台管理員限定。
  // （此處原本的決定是「一般使用者可建專案／加 repo，唯獨此步不擋」，
  // 但那個前提已被規格 §2 取代——建專案本身都收回了，這裡沒有再開放的理由。）
  app.patch('/api/projects/:id/mapping', verifyToken, requirePlatformAdmin, async (req, res) => {
    try {
      const { odoo_project_name, service_respondent_name, service_contact_name } = req.body;
      const conflicts = [];
      if ('odoo_project_name' in req.body) {
        conflicts.push(...await findMappingConflicts('odoo_project_name', odoo_project_name, req.params.id));
      }
      if ('service_respondent_name' in req.body) {
        conflicts.push(...await findMappingConflicts('service_respondent_name', service_respondent_name, req.params.id));
      }
      if ('service_contact_name' in req.body) {
        conflicts.push(...await findMappingConflicts('service_contact_name', service_contact_name, req.params.id));
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
      if ('service_contact_name' in req.body) setDirect('service_contact_name', service_contact_name || null);
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

  // 舊的 requireAdmin（P43 定義）與 requirePlatformAdmin 判同一件事（role==='admin'）；
  // 沒有測試斷言這支的拒絕訊息文字（比對 deploy-routes-authz.test.js 那種），直接換成
  // 共用的 requirePlatformAdmin，讓租戶靜態守衛（規格 §5.4）認得到「有人把關」。
  app.patch('/api/projects/:id', verifyToken, requirePlatformAdmin, async (req, res) => {
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
      // 這裡刻意不 required：既有專案有 folder_name 為 NULL 的（本規則上線前建立的三個），
      // 強制必填會讓他們連改別的欄位都被擋住。帶了才驗格式。
      const folderErr = validateFolderName(folder_name, { required: false });
      if (folderErr) return res.status(400).json({ error: folderErr });
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
      // 自動部署開關掛在這支（已有 requireAdmin）：它決定平台能不能連進客戶正式機下指令，
      // 與 folder_name／e2e_disabled 同屬高風險欄位，不放進一般使用者能打的 /mapping。
      if ('auto_deploy_enabled' in req.body) setDirect('auto_deploy_enabled', !!req.body.auto_deploy_enabled);
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

  // 同上：換成共用的 requirePlatformAdmin。
  app.delete('/api/projects/:id', verifyToken, requirePlatformAdmin, async (req, res) => {
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

      const { taskDbIds, chatIds } = await withTransaction(async (client) => {
        const { rows: taskRows } = await client.query(
          'SELECT id FROM tasks WHERE project_id = $1', [req.params.id]
        );
        const ids = taskRows.map(r => r.id);
        // 對話列本身由 project_chats 的 ON DELETE CASCADE 收掉，但磁碟上的 uploads/chat_<id>
        // 沒人管——要在刪掉之前先把 id 記下來（同 taskDbIds 的理由）
        const { rows: chatRows } = await client.query(
          'SELECT id FROM project_chats WHERE project_id = $1', [req.params.id]
        );
        if (ids.length) {
          // 參照 tasks(id) 的 5 張子表全是裸的 REFERENCES、**沒有任何 ON DELETE CASCADE**
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
          await client.query('DELETE FROM task_specs       WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [req.params.id]);
          await client.query('DELETE FROM task_messages    WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)', [req.params.id]);
          await client.query('DELETE FROM tasks WHERE project_id = $1', [req.params.id]);
        }
        const { rows } = await client.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
        if (!rows.length) {
          const e = new Error('Not found');
          e.status = 404;   // 交易由 withTransaction 回滾；用狀態碼帶出「不存在」與真錯誤區分
          throw e;
        }
        // 交易成功才清快取：擺在 throw 之前的話，404／回滾也會把還在的專案從快取抹掉。
        require('./lib/embedding-index').invalidate({ projectId: Number(req.params.id) });
        return { taskDbIds: ids, chatIds: chatRows.map(r => r.id) };
      });

      // ── 以下皆不可逆，只在 COMMIT 成功後執行 ──
      // 帶交易前取好的 snapshot：此刻 projects／project_repos／odoo_envs 的列都已被 cascade 刪掉，
      // 不傳的話 cleanupProjectEnv 會查到空的、什麼都不刪。
      await cleanupProjectEnv(req.params.id, envSnapshot); // 移除 env 目錄、各 repo clone 與整棵 .worktrees
      taskDbIds.forEach(id => deleteTaskDir(id));   // 各任務磁碟上的 uploads/task_<id>
      chatIds.forEach(id => deleteChatDir(id));     // 各對話磁碟上的 uploads/chat_<id>
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
      // 看不到就當它不存在（規格 §5.2）——回 403 等於告訴對方「這個 id 存在，只是你不能看」
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
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
      // 看不到就當它不存在（規格 §5.2）——回 403 等於告訴對方「這個 id 存在，只是你不能看」
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
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

  app.post('/api/projects/:id/repos', verifyToken, requirePlatformAdmin, async (req, res) => {
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
        // 「落點未知」必須用 null 表示，不能拿 remoteAiBranchName('') 充數——它回的正是裸
        // AI_BRANCH，於是「對方 remote_ai_branch 與 base_branch 都還是 NULL」會被當成
        // 「對方確定坐在裸 ai-dev 上」而無條件 409，第二個用同一 repo 的專案根本加不進來。
        const mine = base_branch ? remoteAiBranchName(base_branch) : null;
        // repo_url 用正規化後的值比對：差一個 `.git`、一條尾斜線、或 https 與 git@ 寫法不同，
        // 指的都是同一個遠端，但字串完全相等比對會全部放行。
        const { rows: siblings } = await query(
          `SELECT pr.project_id, pr.base_branch, pr.repo_url, pr.remote_ai_branch, p.name AS project_name
             FROM project_repos pr JOIN projects p ON p.id = pr.project_id
            WHERE pr.project_id <> $1`,
          [req.params.id]
        );
        const mineUrl = normalizeRepoUrl(repo_url);
        const sameRepo = siblings.filter(s => normalizeRepoUrl(s.repo_url) === mineUrl);
        // 只擋「已經確定會共用同一條分支」的三種形狀，其餘（落點還不知道）一律放行——擋一個
        // 未必會發生的撞名，代價是使用者完全加不了 repo，而且沒有任何補救入口。
        const clash = sameRepo.map(s => {
          // 對方已回寫實際落點就以它為準；否則才用 base_branch 推算（clone 尚未完成的新列）。
          const theirs = s.remote_ai_branch || (s.base_branch ? remoteAiBranchName(s.base_branch) : null);
          // (1) 對方確定坐在裸 ai-dev 上（只認回寫過的實際落點）：遠端只要有 ai-dev，
          //     ensureAiBranch 一律「裸名優先」，本專案選哪個主分支都會落在同一條。
          if (s.remote_ai_branch === AI_BRANCH) return { s, kind: 'bare', theirs: AI_BRANCH };
          // (2) 兩邊都沒指定主分支＝都靠自動偵測，而這是同一個 repo，偵測結果必然相同。
          if (!base_branch && !s.base_branch) return { s, kind: 'auto', theirs };
          // (3) 兩邊落點都算得出來且相同。
          if (mine && theirs && mine === theirs) return { s, kind: 'same', theirs };
          return null;
        }).find(Boolean);
        if (clash) {
          const { s, kind, theirs } = clash;
          // 訊息要指一條真的走得通的路。舊版對「落點未知」叫人「先為該專案指定主分支」，但
          // PUT 明文拒絕事後修改 base_branch（見下方端點），使用者照做只會撞到第二道拒絕。
          const MSG = {
            bare: `專案「${s.project_name}」已經把這個 repo 的 AI 產出放在裸的 ai-dev 分支上。遠端只要存在 ai-dev，任何專案都會優先沿用它，改選主分支也躲不開，兩邊會互相覆蓋。可行的做法是先在 GitHub 上把 ai-dev 合併回主分支並刪除遠端 ai-dev，兩邊各自重新加入這個 repo，之後才會長出帶主分支後綴的 AI 分支。`,
            auto: `專案「${s.project_name}」也在用這個 repo，而兩邊都沒有指定主分支——同一個 repo 自動偵測出來的主分支必然相同，會落在同一條遠端 AI 分支（${theirs || `${AI_BRANCH}-<偵測到的主分支>`}）而互相覆蓋。請在本次新增時明確指定一個與它不同的主分支（主分支只有新增這一次可以選，之後不能修改）。`,
            same: `專案「${s.project_name}」已經以「${s.base_branch || '自動偵測'}」使用這個 repo，兩者會共用同一條遠端 AI 分支（${theirs}）而互相覆蓋。請改選其他主分支。`,
          };
          return res.status(409).json({ error: MSG[kind] });
        }
      }

      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }

      const destPath = computeDestPath(
        project.folder_name || project.name, label, repo_url, await takenRepoDirs(req.params.id)
      );
      const { rows } = await query(
        `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status, base_branch, clone_status_at)
         VALUES ($1, $2, $3, $4, $5, 'cloning', $6, NOW()) RETURNING *`,
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

  app.put('/api/projects/:id/repos/:repoId', verifyToken, requirePlatformAdmin, async (req, res) => {
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
        newLocalPath = computeDestPath(
          project.folder_name || project.name, label || existing.label, repo_url,
          await takenRepoDirs(req.params.id, existing.id)
        );
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
        // 換 URL 是唯一會動 clone_status 的分支（否則 newCloneStatus 沿用原值），時間戳只在真的
        // 變動時更新，否則「上次何時離開 done」會被無關的改名編輯洗掉。
        await query('UPDATE project_repos SET clone_status_at=NOW() WHERE id=$1', [rows[0].id]);
        console.warn(`[repo ${rows[0].id}] 換 URL → clone_status ${existing.clone_status} → cloning，此期間該專案無法建立測試環境`);
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

  app.delete('/api/projects/:id/repos/:repoId', verifyToken, requirePlatformAdmin, async (req, res) => {
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

  app.post('/api/projects/:id/repos/:repoId/reclone', verifyToken, requirePlatformAdmin, async (req, res) => {
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

      // 這一步把 repo 移出 done，等同讓它從整個 pipeline 消失（規則 81）——測試環境會被建成沒有任何
      // 客製模組的空殼、任務也撈不到 repo。而 triggerClone 是背景執行：平台若在它跑完前重啟，沒有任何
      // catch 會執行，狀態就永久卡在 cloning，clone_error 又剛被清成 NULL，事後查不到一點痕跡
      //（2026-08-24 萊峰19 的第一次事故）。落一行 log 與時間戳，至少讓「從什麼時候開始不是 done」查得到。
      await query(
        "UPDATE project_repos SET clone_status='cloning', clone_error=NULL, clone_status_at=NOW() WHERE id=$1",
        [repo.id]
      );
      console.warn(`[reclone] repo ${repo.id}（${repo.label}）clone_status ${repo.clone_status} → cloning，`
        + '此期間該專案無法建立測試環境');
      triggerClone(req.params.id, repo.id, repo.repo_url, repo.local_path, gitEnv, req.userId);
      res.json({ ok: true, cloning: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- 上正式（ai-dev → main）---

  // 待上正式＝已核准併進 ai-dev、但尚未被「上正式」按鈕推上 main 的任務。
  // 前端 TaskList 的「待上正式」篩選用同一份定義，兩處數字必然一致。
  const PENDING_RELEASE_SQL =
    `SELECT t.task_id, t.title, t.status, t.approved_at,
            u.display_name AS submitter_name, c.name AS submitter_company
     FROM tasks t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE t.project_id = $1 AND t.approved_at IS NOT NULL AND t.merged_to_main_at IS NULL
     ORDER BY t.approved_at`;

  app.get('/api/projects/:id/pending-release', verifyToken, async (req, res) => {
    try {
      // 看不到就當它不存在（規格 §5.2）——回 403 等於告訴對方「這個 id 存在，只是你不能看」
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
      // 規格 §8 P5：看得到專案的成員可唯讀待上正式清單；真正上正式仍由 POST 的權限檢查把關。
      const canRelease = await canReleaseProject(req.actor, req.params.id);
      const { rows } = await query(PENDING_RELEASE_SQL, [req.params.id]);
      // 彈窗要先知道「按下去會不會動到客戶正式機」才有辦法把警告寫對。
      // 沒有這段的話，警告只能寫死成一句通用的話，於是每次都出現，於是沒有人會看。
      const { rows: [p] } = await query('SELECT auto_deploy_enabled FROM projects WHERE id = $1', [req.params.id]);
      const { rows: [n] } = await query(
        "SELECT COUNT(*)::int AS c FROM project_deploy_targets WHERE project_id = $1 AND env = 'prod' AND enabled = true",
        [req.params.id]
      );
      res.json({
        tasks: rows,
        prodDeploy: {
          autoDeploy: !!(p && p.auto_deploy_enabled),
          targets: n.c,
          canRelease,
        },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/release', verifyToken, async (req, res) => {
    try {
      // 看不到就當它不存在（規格 §5.2），且務必排在 canReleaseProject 之前：
      // canReleaseProject 只分「看得到但不能按」（403）與「不能按」，不負責分辨
      // 「看不到」與「真的不存在」——先過 loadProjectForActor 的範圍檢查再讓它接手，
      // 才不會讓別家公司的管理員用「打得到 403 還是 404」當 oracle 探出 id 存在。
      // ⚠ 別把這一步搬到 canReleaseProject 之後、也別改回裸的 SELECT，那正是本輪要補的洞。
      const project = await loadProjectForActor(req.params.id, req, 'id, name');
      if (!project) return res.status(404).json({ error: 'Not found' });

      // 上正式是專案層批次，會把同事已核准的任務一起帶上去，所以必須有人負責（規格 §4.3）：
      // 平台管理員，或「該公司對這個專案的綁定勾了可上正式」的公司管理員。一般成員一律不行。
      // ⚠ 這一行是硬性前提：第 1 部把 GIT 憑證改成可退回公司憑證，順手拆掉了
      // 「沒有個人 PAT 就擋」這道事實上的煞車。沒有這一行，只要有人替公司設了 PAT，
      // 該公司每個成員都能對任何專案按上正式。
      if (!await canReleaseProject(req.actor, req.params.id)) {
        return res.status(403).json({ error: '只有平台管理員或公司管理員能上正式' });
      }

      // GIT 憑證退回規則（09-11／09-14 裁決，規格 §6）：個人 → 公司 → 擋下。
      // 原本刻意「只用本人 PAT、不退機器憑證」是為了歸屬，但客戶不會每個人都有 PAT；
      // 改由 buildGitEnv 回傳的 source 記錄是用誰的身分推的，歸屬仍然看得出來。
      let gitEnv;
      try {
        gitEnv = await buildGitEnv(req.userId);
      } catch (e) {
        if (e.code === 'NO_GIT_CRED') return res.status(400).json({ error: req.actor.isPlatformAdmin ? '請先到設定填個人 GitHub PAT' : '公司尚未設定 GIT，請聯絡平台' });
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
      if (!allOk) {
        await require('./notify').notifyProjectMergeFailure(project.id, project.name).catch(err => {
          console.error('[RELEASE] 合併失敗通知未送達:', err.message);
        });
      }
      let tasks = [];
      if (allOk && anyMerged) {
        const { rows } = await query(
          `UPDATE tasks SET merged_to_main_at = NOW()
           WHERE project_id = $1 AND approved_at IS NOT NULL AND merged_to_main_at IS NULL
           RETURNING id, task_id, title`,
          [project.id]
        );
        tasks = rows;
      }
      // 上正式之後接部署。刻意放在 merged_to_main_at 標記之後：碼已經 push 上 main
      // 是既成事實，部署失敗不可以讓 /release 回錯——回錯使用者會重按，變成重複 merge。
      // 授權：這條路徑會 SSH 進客戶的正式機下指令，門檻必須跟專用的部署端點一致
      // （deploy-routes.js 是 admin ＋ 明確 confirm）。這裡原本只驗登入、也不要求確認，
      // 等於整套授權設計可以繞過——平台現有的非 admin 帳號都按得到。
      // 合併到 main 那一半維持原樣（本來就開放），只把「動客戶正式機」這一半關起來，
      // 並且任何一種「沒部署」都要講出原因：靜默略過會讓人以為已經上線。
      let deploy = [], deploySkipped = false, deploySkipReason = null;
      if (allOk && anyMerged) {
        const { isAutoDeployEnabled } = require('./lib/auto-deploy-switch');
        const { rows: targets } = await query(
          "SELECT * FROM project_deploy_targets WHERE project_id = $1 AND env = 'prod' AND enabled = true ORDER BY id",
          [project.id]
        );
        if (!await isAutoDeployEnabled(project.id)) {
          deploySkipped = true;
          deploySkipReason = '此專案未啟用自動部署，客戶正式區未更新。';
        } else if (!targets.length) {
          deploySkipped = true;
          deploySkipReason = '此專案沒有啟用中的正式區部署目標，客戶正式區未更新。';
        } else if (!await canReleaseProject(req.actor, project.id)) {
          deploySkipped = true;
          deploySkipReason = '部署到客戶正式區需要這個專案的上正式權限。程式已上 main，請通知管理員執行部署。';
        } else if (req.body.confirmDeploy !== true) {
          deploySkipped = true;
          deploySkipReason = '未確認正式區部署。程式已上 main，客戶正式區未更新。';
        } else {
          const { runDeployGroup } = require('./lib/deploy-run');
          const { groupTargets } = require('./lib/deploy-cmd');
          // 掛在同一個容器／服務上的多個資料庫合成一輪：停一次、逐個升、起一次。
          // 一個目標停一次的話客戶會被斷線 N 次，而兩次停機之間服務是活的——
          // 使用者這時進得來，用到的卻是只升了一半的狀態。
          const groups = groupTargets(targets);
          // 與 pipeline 的 git 操作互斥：部署要 fetch／archive 同一個主 clone。
          // 前面那把鎖在 releaseAiToMain 結束時已釋放，這裡是重新取。
          deploy = await withProjectLock(Number(project.id), async () => {
            const out = [];
            for (const ids of groups) {
              try {
                out.push(...await runDeployGroup(ids, { trigger: 'manual_prod', userId: req.userId }));
              } catch (e) {
                // 一組炸了不能拖垮其他組——它們是不同的機器／容器
                for (const id of ids) out.push({ targetId: id, ok: false, error: e.message });
              }
            }
            return out;
          });
        }
        // 這次上正式的每一張任務都要在自己的對話裡看得到結果：這個回應只活在按下按鈕的
        // 那一瞬間，彈窗一關就查不到了，而 task_logs 是使用者事後找得回來的唯一真相。
        // 與測試區那條不同，開關關著也照寫——使用者是主動按下去、等著看客戶機更新了沒。
        const { describeResults } = require('./lib/deploy-text');
        const detail = deploySkipped
          ? `客戶正式區未更新：${deploySkipReason}`
          : describeResults(deploy, targets, '客戶正式區').join('\n') || '客戶正式區未更新。';
        // 規格 §6／09-11 裁決：GIT 憑證退回個人 → 公司後，拿掉了「只用本人 PAT」那道歸屬煞車，
        // 改由 buildGitEnv 回傳的 source 補償——但 source 不落地就等於沒補償（全跑修法波第 3 項）。
        // 這裡是這條退回鏈唯一真正「代表某張任務推 code」的落點：task_logs 是使用者事後唯一找得回來的地方。
        const sourceLabel = gitEnv.source === 'company' ? '公司 GitHub 憑證' : '個人 GitHub 憑證';
        for (const t of tasks) {
          await query(
            "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
            [t.id, `[上正式] 程式已併入 main（使用${sourceLabel}推送）。\n${detail}`]
          ).catch(() => {});
        }
        if (!deploySkipped && deploy.some(d => !d.ok)) {
          await require('./notify').notifyProjectReleaseFailure(project.id, project.name, tasks).catch(err => {
            console.error('[RELEASE] 部署失敗通知未送達:', err.message);
          });
        }
      }

      const visibleResults = req.actor.isPlatformAdmin ? results : results.map(r =>
        (r.error || r.hasConflicts) ? { ...r, conflictFiles: [], error: '程式合併失敗，平台管理員處理中。' } : r
      );
      res.json({ ok: allOk, repos: visibleResults, tasks, deploy, deploySkipped, deploySkipReason });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Task ↔ Project assignment ---

  app.put('/api/tasks/:taskDbId/project', verifyToken, async (req, res) => {
    try {
      const { project_id } = req.body;
      // 目標專案 id 是從 body 進來的，不是路徑參數——之後補的靜態守衛只比對路徑上的
      // :id，攔不到這裡，範圍檢查只能手動補在這一步。看不到的專案當它不存在（規格
      // §5.2）：否則使用者能把自己的任務改掛到別家公司的專案上，而任務的 project_id
      // 決定 pipeline 用誰的 repo 跑 AI。project_id 為空（含 0／''／undefined）維持
      // 原本「拔掉專案綁定」的語意，不用經過這道檢查。
      if (project_id && !await loadProjectForActor(project_id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
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
