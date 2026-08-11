const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const yaml = require('js-yaml');
const { getProjectInfo, worktreeParent } = require('./task-agent');
const { ensureEnvRunning } = require('./ensure-env');
const { runTourTests, restartEnv } = require('./env-agent');
const { classifyFailureWithAgent } = require('./failure-classifier');
const { extractOdooError, looksLikeInfraDeath } = require('./deploy-testing');
const { withProjectLock } = require('./project-lock');
const { diffNameOnly, AI_BRANCH } = require('./git');

const PW_LIMIT = 3;
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

// E2E via Odoo 原生 tour（純程式關，無 agent）：把任務分支再併一次 testing 帶入考題，
// 跑 odoo-bin --test-enable，依「實際跑了幾支」與 exit code 判定；失敗分類複用 deploy 那套。
// 考題本身在更早的建立分支關就依 acceptance 定稿了（task-agent.js 的 runSpecTourGate）。
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
  // 持有埠＝這個環境真的被建起來過（ensureEnvRunning 探通的就是它），也是 finally 那次 restartEnv
  // 等待監聽的目標。tour 本身是 docker exec 進容器跑、不經網址，故只驗埠在不在，不再組 test_url
  //（那是給已移除的 tour-author agent 用的）。
  const { rows: [env] } = await query('SELECT port FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (!env?.port) {
    await stopTask(taskId, userId, '測試環境未持有埠，無法執行 E2E 測試', 'env');
    return true;
  }

  let moduleName = '';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; } catch { /* SD 解析失敗 */ }
  if (!moduleName) {
    await stopTask(taskId, userId, '無法從分析規格取得 module 名稱，無法決定要跑哪個模組的 tour', 'code');
    return true;
  }

  const info = await getProjectInfo(task.project_id);
  // 無已 clone 完成的 repo 就沒有 worktree，也就無從推導本次的 tour class
  if (!info?.root) {
    await stopTask(taskId, userId, '專案未設定任何已完成 clone 的 Repo，無法執行 tour 測試', 'env');
    return true;
  }
  // 防結構性假綠燈：無任務分支＝tour 無法併入 testing，addons-path 收不到新 tour，
  // --test-tags 匹配不到任何測試 exit 0＝假通過直達人工審核
  if (!task.git_branch) {
    await stopTask(taskId, userId, '任務缺少 git 分支，tour 測試無法併入 testing 執行', 'tech');
    return true;
  }
  const cwd = worktreeParent(info.root, task.task_id);
  // 考題不在這裡產。tour 一律在建立分支關依定稿的 acceptance 先寫（runSpecTourGate），
  // 本關只負責執行。這一關原本還留著一條「自己產 tour」的降級路徑，2026-08-11 移除：
  //   * 那條路是「先寫答案再出考題」——照著已完成的實作重寫考題，測試會遷就實作而靜默通過；
  //   * 它與先寫模式兩條路都從未被執行過（token_usage 裡 playwright 一筆都沒有），
  //     留著等於維護兩條沒人走過的路，而降級路徑天生最少被走、最容易爛掉；
  //   * 留著它也讓「考題沒產出」有地方遁形——現在沒有備援，缺 tour 會直接被下方的題數守衛判 0 支。
  // 於是本關成為純程式關（無 agent），status_labels 的 playwright_running 也隨之改標 actor:'system'。
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

    // 這裡曾經先 `stopEnv` 再跑測試，理由是「測試進程 -u <module> 與 live server 同顆 DB 併跑會
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

module.exports = { runTourStage };
