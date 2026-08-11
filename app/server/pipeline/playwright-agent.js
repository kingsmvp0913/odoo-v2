const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const yaml = require('js-yaml');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { E2E_LOGIN, E2E_PASSWORD } = require('./e2e-account');
const { getProjectInfo, worktreeParent, buildRepoPaths } = require('./task-agent');
const { getProjectNotes } = require('./project-notes');
const { coreSourceGuidance } = require('../lib/odoo-core-src');
const { runClaude, stopReason } = require('./claude-runner');
const { ensureEnvRunning } = require('./ensure-env');
const { runTourTests, restartEnv } = require('./env-agent');
const { classifyFailureWithAgent } = require('./failure-classifier');
const { extractOdooError, looksLikeInfraDeath } = require('./deploy-testing');
const { withProjectLock } = require('./project-lock');
const { diffNameOnly, AI_BRANCH } = require('./git');

const PW_LIMIT = 3;
// tour 產生＝重探索＋讀範例＋寫 tour/HttpCase，與 coding 同屬長階段，預設 600s 常不夠
//（106 事故：claude 執行逾時整整 600s、tour 沒寫完就被砍）。獨立放寬、可用 env 調整（比照 coding 的 CODING_TIMEOUT_MS）。
const E2E_TIMEOUT_MS = parseInt(process.env.PIPELINE_E2E_TIMEOUT_MS || '1200000', 10);

// 失敗診斷完整落地（比照 deploy-testing.js 的 saveDeployLog）：blocker/feedback 只留摘要，
// 完整 stdout/stderr/exitCode 存檔供事後鑑識，避免 tour 斷言細節與 traceback 永久遺失。
function saveTourLog(taskId, err) {
  try {
    const dir = process.env.E2E_LOG_DIR || path.join(__dirname, '..', '..', '..', 'data', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `e2e-task${taskId}-${Date.now()}.log`);
    fs.writeFileSync(file, [
      `exitCode: ${err.exitCode ?? '?'}｜killed: ${err.killed ? 'yes' : 'no'}`,
      '--- stderr ---', err.stderr || err.message || '(空)',
      '--- stdout ---', err.stdout || '(空)'
    ].join('\n'));
    return file;
  } catch { return null; }
}

// 從 odoo-bin 的 log 取「這次實際跑了幾支測試」。來源是 odoo.tests.result 的收尾行：
//   `0 failed, 29 error(s) of 48 tests when loading database 'test_x'`
// 回 null＝那行完全沒出現（odoo 沒跑到測試階段，如載入期就崩）。0 與 null 都不算通過，
// 但錯因不同，訊息要分開講。取最後一筆：--test-enable 在 at_install／post_install 兩個階段
// 各會印一次，最後那次才是完整結果。
function parseTestCount(log) {
  const all = [...String(log || '').matchAll(/of (\d+) tests/g)];
  return all.length ? parseInt(all[all.length - 1][1], 10) : null;
}

async function stopTask(taskId, userId, msg, blockerType = null) {
  await query("UPDATE tasks SET status='stopped', blocker_type=$3, blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, msg, blockerType]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

// tour 失敗屬程式問題：把報告餵回 coding 並加計數，滿 PW_LIMIT→stopped（沿用原 E2E 失敗語意）。
async function bounceToCoding(task, taskId, userId, report, logRef = '') {
  // 時間軸截短：report 可能整段夾著 tour 的 traceback／JS 堆疊，原文貼上去使用者讀不下去。
  // 完整內容仍走 retry_feedback 給 coding（見下方），logRef 保留讓人工追得到落檔。
  const brief = String(report).length > 300 ? `${String(report).slice(0, 300)}…（詳見完整 log）` : String(report);
  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, `[E2E tour 未通過]\n${brief}${logRef}`]);
  const nextCount = (task.pw_retry_count || 0) + 1;
  if (nextCount >= PW_LIMIT) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='code', pw_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
      [taskId, nextCount, `E2E tour 連續 ${PW_LIMIT} 次未通過，需人工介入。最後結果：${String(report).slice(0, 300)}${logRef}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }
  const { bumpReentryOrStop } = require('./reentry');
  if (await bumpReentryOrStop(taskId, userId)) return; // 總循環達上限 → 已標 stopped
  await query(
    "UPDATE tasks SET status='coding_running', pw_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
    [taskId, nextCount, `[E2E tour 未通過]\n${report}${logRef}`]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
}

// E2E via Odoo 原生 tour（獨立階段）：agent 產 tour+HttpCase 寫入模組並 commit（副作用），
// 再由 Node 跑 odoo-bin --test-enable 判 exit code；verdict 對映複用 deploy 的分類邏輯。
async function runTourStage(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, pw_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  // 持專案鎖與手動建立（env-routes）序列化——兩者同時觸發 runEnvSetup 會爭埠並互蓋 odoo_envs。
  // 只鎖住 ensureEnvRunning（秒級的探測／必要時起環境），不涵蓋下方長時 tour 產生——那才是
  // rule #61 要避免的「長持鎖卡住同專案其他任務」。task.project_id 已是 DB 數字，key 型別正確。
  if (!(await withProjectLock(task.project_id, () => ensureEnvRunning(task.project_id)))) {
    await stopTask(taskId, userId, '測試環境未運行且無法自動啟動，請至專案環境頁檢查', 'env');
    return true;
  }
  // 位址由內部埠現算，不讀 odoo_envs.url：子網域模式下開機時 url 一律存 NULL（對外網址是
  // 真人借到檢視名額的當下才算得出來，而 pipeline 從不借名額）。tour 是 docker exec 進容器跑的、
  // 不經對外網址，沿用 url 會讓正式機每張啟用 E2E 的任務都停在「未提供 URL」，本機重現不了。
  // 用 envBindHost 而非對外網址：那正是 ensureEnvRunning 剛剛探通的位址，agent 也連得到。
  const { rows: [env] } = await query('SELECT port FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (!env?.port) {
    await stopTask(taskId, userId, '測試環境未持有埠，無法執行 E2E 測試', 'env');
    return true;
  }
  const { envBindHost } = require('../port-alloc');
  const testUrl = `http://${envBindHost(env.port)}:${env.port}`;

  let moduleName = '';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; } catch { /* SD 解析失敗 */ }
  if (!moduleName) {
    await stopTask(taskId, userId, '無法從分析規格取得 module 名稱，無法產生 tour 測試', 'code');
    return true;
  }

  // 1) tour-author agent：把 tour+HttpCase 寫進模組並 commit（結果由下方 exit code 判，不解析其文字）
  const info = await getProjectInfo(task.project_id);
  // 防呆：無已 clone 完成的 repo 時不得 fallback 到 process.cwd()——
  // agent 帶 --dangerously-skip-permissions，會把測試檔寫進平台自身的 repo
  if (!info?.root) {
    await stopTask(taskId, userId, '專案未設定任何已完成 clone 的 Repo，無法產生 tour 測試', 'env');
    return true;
  }
  // 防結構性假綠燈：無任務分支＝tour 無法併入 testing，addons-path 收不到新 tour，
  // --test-tags 匹配不到任何測試 exit 0＝假通過直達人工審核
  if (!task.git_branch) {
    await stopTask(taskId, userId, '任務缺少 git 分支，tour 測試無法併入 testing 執行', 'tech');
    return true;
  }
  const cwd = worktreeParent(info.root, task.task_id);
  // 規格 tour 模式：tour 已在分析關依 acceptance 定稿（實作之前），這裡不得重產——重產等於
  // 讓 agent 照著已完成的實作重寫考題，測試會遷就實作，先定稿的意義整個消失。
  // 直接跳到下方「併入 testing → 跑 --test-enable」。
  //
  // 但旗標只說「本專案打算走這個模式」，不代表 tour 真的在。分析關的 writeSpecTour 是 best-effort、
  // 失敗靜默；而 spec_tour_enabled 是專案層開關又沒有 per-task 快照，開關打開當下所有已過分析關的
  // 在途任務，到這裡必然是「模式開著、worktree 裡沒有 tour」——這條路不需要任何失敗就會發生。
  // 只看旗標就跳過的話：模組裡有前一張任務留下的 tour 時，--test-tags /<module> 會跑到那些舊測試，
  // log 出現 odoo.tests 命名空間，下方的防假綠燈守衛因此失效 → 本次功能零 E2E 覆蓋卻直達人工審核。
  // 所以要看事實不看旗標：確認 tour 檔真的存在才跳過產生。
  const { rows: [tourCfg] } = await query('SELECT spec_tour_enabled FROM projects WHERE id=$1', [task.project_id]);
  const hasSpecTour = !!(tourCfg && tourCfg.spec_tour_enabled) && await specTourExists(info, cwd, moduleName);
  if (hasSpecTour) {
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', 'E2E tour 已於分析關依規格產出，本關直接執行、不重新產生')",
      [taskId]
    );
  } else if (tourCfg && tourCfg.spec_tour_enabled) {
    // 降級回本關產生：任務照樣走得完（等同關掉開關的既有行為），但必須留聲——否則「規格 tour
    // 沒產出」這件事沒有任何人看得到，而分析關那邊已經吞掉了失敗。
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `規格 tour 模式已啟用，但 worktree 內找不到 ${moduleName} 的 tour 測試檔（分析關可能未產出，或本任務在開關啟用前就已通過分析關）。本關改為自行產生 tour，先定稿的效果本次不生效。`]
    );
  }
  if (!hasSpecTour) try {
    const agent = loadAgent('playwright');
    // base 分支＝任務切點 ai-dev：供 source-routing 給出正確 diff 基底。
    // 用 main 會讓 agent 把其他已核准任務的變更誤認為自己的 diff。
    const baseBranch = AI_BRANCH;
    const projectNotes = await getProjectNotes(task.project_id).catch(() => null);
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      test_url: testUrl,
      login: E2E_LOGIN,
      module: moduleName,
      repo_paths: buildRepoPaths(info, task.task_id),
      odoo_core_src: coreSourceGuidance(info.odoo_version),
      main_branch: baseBranch,
      git_branch: task.git_branch || '（未設定）',
      project_notes: projectNotes || ''
    }).trim();
    // 登入密碼改讀該環境隨機 E2E 密碼（每環境獨立、非原始碼公開後門）；舊環境（無值）退回固定值相容。
    const { rows: [envCreds] } = await query('SELECT e2e_password FROM odoo_envs WHERE project_id=$1', [task.project_id]);
    const e2ePassword = envCreds?.e2e_password || E2E_PASSWORD;
    const result = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, env: { E2E_PASSWORD: e2ePassword }, agentType: 'playwright', timeoutMs: E2E_TIMEOUT_MS });
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', err);
    if (err.aborted) return true; // 手動暫停：非失敗，狀態原地不動，不列入 blocker，解除暫停後從這一關重跑
    await stopTask(taskId, userId, stopReason('Tour 產生失敗', err));
    return true;
  }

  // 2) tour commit 在任務分支（worktree），主 clone 的 testing 分支還沒有它——
  //    不先併入 testing，odoo-bin 的 addons-path（指主 clone）收不到新 tour，
  //    --test-tags 匹配不到任何測試就 exit 0＝結構性假綠燈。故先把 task 分支再併一次 testing
  //    （功能碼已在 merge 關卡併過，這次只帶入 tour 測試檔；mergeInto 同時保證 testing 已檢出）。
  //    動共用主 clone＋測試 DB → 全程持專案鎖，與同專案 merge/deploy/analysis 序列化。
  const clsCtx = { taskId: task.task_id, projectId: task.project_id, userId };
  let log = '', err = null, mergeStop = null, cls = null, tourClasses = [];
  await withProjectLock(task.project_id, async () => {
    for (const repo of (info.repos || [])) {
      try {
        const { mergeInto } = require('./git');
        const m = await mergeInto(repo.local_path, 'testing', task.git_branch);
        if (m.hasConflicts) {
          const { abortMerge } = require('./git');
          await abortMerge(repo.local_path).catch(() => {});
          mergeStop = `tour 測試檔併入 testing 發生衝突（${repo.subdir}: ${m.conflictFiles.join(', ')}），需人工處理`;
          return;
        }
      } catch (e) {
        mergeStop = `tour 測試檔併入 testing 失敗（${repo.subdir}）：${e.message}`;
        return;
      }
    }

    // 3) 這裡曾經先 `stopEnv` 再跑測試，理由是「測試進程 -u <module> 與 live server 同顆 DB 併跑會
    //    registry 走鏽」。那是 venv 時代的寫法：當時停 server＝砍一個 process、DB 仍在。
    //    docker 化之後 server 就是容器本身，而 stopEnv = stopContainer + **removeContainer**
    //    （env-agent.js:454），下一行的 runTourTests 卻是 `docker exec` 進同一個容器、開頭就檢查
    //    containerRunning → 必然 throw「測試容器未運行」。E2E 在 docker 模式下因此 100% 失敗，
    //    而這件事一直沒被發現，因為這一關歷來執行 0 次（token_usage 裡 playwright 一筆都沒有）。
    //    2026-08-11 首航實測證實：不停容器可正常執行，停了則 log 只有 19 bytes 的那句錯誤。
    //    原本要解決的 registry 走鏽仍然真實，改在**跑完之後**重啟容器處理（見 finally）。
    //    同類殘留 629e733 才修過一個（readAssetTraceback 讀 venv 時代才存在的 odoo.log）。
    // 併入 testing 之後才算 class：tour 檔此刻才在 worktree 裡是最終狀態。
    tourClasses = await tourTestClasses(info, cwd, moduleName, AI_BRANCH, task.git_branch).catch(() => []);
    try {
      // Node 跑 tour（odoo-bin --test-enable），依 exit code 判定
      try { ({ log } = await runTourTests(task.project_id, moduleName, signal, tourClasses)); } catch (e) { err = e; }
      if (err && signal?.aborted) return;

      // 失敗只分類一次（健檢 F3：舊版 148/172 對同一 err 逐字問 haiku 兩次）。
      // 逾時被殺／猝死當環境問題、不重試（F8/P4）；transient 自動重試一次，重試仍敗直接判 env（不重問，避免漂移）。
      if (err) cls = (err.killed || looksLikeInfraDeath(err)) ? 'env' : await classifyFailureWithAgent(err.message, clsCtx);
      if (err && cls === 'transient') {
        err = null;
        try { ({ log } = await runTourTests(task.project_id, moduleName, signal, tourClasses)); } catch (e) { err = e; }
        if (err && signal?.aborted) return;
        if (err) cls = 'env'; // 重試仍敗（含再次逾時）：一律當環境問題停等人工，不重新分類
      }
    } finally {
      // 重啟容器（無論成敗/中止）：測試進程的 `-u <module>` 已經動過 DB schema 與 ir.model 資料，
      // 常駐 server 記憶體裡的 registry 是升級前的版本。用 ensureEnvRunning 不行——它只探測埠通不通，
      // 容器本來就活著、直接回 ok，registry 照樣是舊的。restartEnv 才會真的重載。
      await restartEnv(task.project_id).catch(() => {});
    }
  });
  // 手動暫停中止子行程：非失敗，狀態原地不動，解除暫停後從這一關重跑
  if (signal?.aborted) return true;
  if (mergeStop) {
    await stopTask(taskId, userId, mergeStop, 'tech');
    return true;
  }

  if (!err) {
    // 防假綠燈：chrome 消失時 Odoo raise SkipTest（exit 0），log 會有此字樣＝tour 沒真的跑
    if (/Chrome executable not found|unittest\.SkipTest/i.test(log)) {
      await stopTask(taskId, userId, 'tour 被跳過（測試機找不到 Chrome），E2E 未實際執行。請確認測試環境已安裝 Google Chrome。', 'env');
      return true;
    }
    // 防假綠燈：--test-tags 匹配 0 個測試時 odoo-bin 仍 exit 0＝假綠燈直達人工審核。
    //
    // 這裡原本判斷「log 含不含 odoo.tests 命名空間」，註解寫著「真的有跑測試時必含，完全沒有＝沒測」。
    // 那個前提是錯的：2026-08-11 實測餵一個不存在的 class，log 照樣出現
    //     WARNING ... odoo.tests.result: 0 failed, 0 error(s) of 0 tests
    // 守衛因此放行 → 一題都沒考卻判定通過。這道守衛是整個「先寫 tour」模式的安全網，
    // 而它從未被驗證過（這一關歷來執行 0 次）。
    //
    // 改看題數：那行的數字才是資訊，logger 名稱不是。抓不到整行＝odoo 沒跑起來，同樣不算通過。
    const ran = parseTestCount(log);
    if (ran === null || ran === 0) {
      await bounceToCoding(task, taskId, userId, ran === 0
        ? `E2E 實際執行 0 支測試（指定的 tour 類別 ${tourClasses.join('、') || '（無）'} 在模組中不存在或未被 Odoo 載入）。請確認 tour 的 HttpCase 已寫入 <module>/tests/ 並在 tests/__init__.py 匯入。`
        : 'E2E 未產生任何測試結果（odoo-bin 未跑到測試階段），無法確認本次功能是否通過。');
      return true;
    }
    await query("UPDATE tasks SET status='review_pending', updated_at=NOW() WHERE id=$1", [taskId]);
    // 綠燈只留一行：這一關成功時原本完全不寫 task_logs，使用者看不出它跑過沒有。
    // 題數印在這裡不是裝飾——它就是上面那道守衛的結果，讓「0 支」這種數字在畫面上無所遁形。
    // 失敗才給細節（摘要進時間軸、全文走 retry_feedback、原始 log 落檔），見 bounceToCoding。
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, `[E2E 通過] ${ran} 支測試全數通過`]
    ).catch(() => {});
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'review_pending' });
    return true;
  }

  // 失敗分類（比照 deploy）：env／env 已非 running → 停等修環境；code → 退 coding 計數。
  // cls 已在 lock 內算過（健檢 F3），此處直接重用，不再問第二次 haiku。
  const odooErr = extractOdooError(err.message);
  const logFile = saveTourLog(taskId, err);
  const logRef = logFile ? `\n完整 log：${logFile}` : '';
  const { rows: [env2] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (cls !== 'code' || !env2 || env2.status !== 'running') {
    await stopTask(taskId, userId, `E2E tour 期間屬環境問題（非程式碼），請恢復環境後重試。最後錯誤：${odooErr.slice(0, 500)}${logRef}`, 'env');
    return true;
  }
  await bounceToCoding(task, taskId, userId, odooErr, logRef);
  return true;
}

// 本次任務產出的 tour 對應哪幾個 HttpCase class。
//
// 為什麼要算這個：`--test-tags /<module>` 會跑到模組內**所有**測試。鴻久實測 48 支裡有 25 支是
// 早就壞掉的既有測試（idx_maintenance.partner_id NOT NULL），與本次任務無關——tour 就算全對，
// exit code 仍非 0 → E2E 判失敗 → 退 coding → coding 被禁止改測試檔 → 三輪 stopped。
// 收窄成 `/<module>:ClassA,/<module>:ClassB` 後實測 48→4，既有壞測試全數排除。
//
// 為什麼由平台推導而不是讓 agent 自己標 tag：守門條件寫在 prompt 裡等於沒守門（規則 60）。
// 平台在此刻已知 base 分支與任務分支，diff 是確定性的事實。
//
// 只取 diff 內的檔案（不是掃整個 tests/ 目錄）：模組裡可能躺著前一張任務留下的 tour，
// 那些不是本次的考題，跑它們＝拿別人的錯誤退本次任務。
async function tourTestClasses(info, cwd, moduleName, baseBranch, taskBranch) {
  const fsp = require('fs').promises;
  const classes = new Set();
  for (const repo of (info.repos || [])) {
    const wt = path.join(cwd, repo.subdir);
    let changed = [];
    try { changed = await diffNameOnly(wt, baseBranch, taskBranch); } catch { continue; }
    const testFiles = changed.filter(f => new RegExp(`(^|/)${moduleName}/tests/[^/]+\\.py$`).test(f));
    for (const rel of testFiles) {
      // 檔案讀不到（本次是刪除）→ 跳過，不讓單一檔案的意外吃掉整份清單
      const src = await fsp.readFile(path.join(wt, rel), 'utf8').catch(() => null);
      if (!src) continue;
      // 只收 HttpCase 子類：同一次 diff 常一併改到純 ORM 的 TransactionCase，那些不是考題
      for (const m of src.matchAll(/^class\s+(\w+)\s*\([^)]*HttpCase[^)]*\)\s*:/gm)) classes.add(m[1]);
    }
  }
  return [...classes];
}

// 規格 tour 是否真的躺在 worktree 裡。Odoo 的 tour 一律住 `<module>/static/tests/tours/`；
// 逐個 repo 子目錄找，任何一個有 .js 就算數。探測失敗一律當「沒有」——寧可多產一次 tour，
// 也不要在沒有測試的情況下跳過產生（那會變成假綠燈直達人工審核）。
async function specTourExists(info, cwd, moduleName) {
  const fsp = require('fs').promises;
  for (const repo of (info.repos || [])) {
    const dir = path.join(cwd, repo.subdir, moduleName, 'static', 'tests', 'tours');
    const files = await fsp.readdir(dir).catch(() => []);
    if (files.some(f => f.endsWith('.js'))) return true;
  }
  return false;
}

module.exports = { runTourStage };
