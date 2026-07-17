const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');
const { upgradeModules, installModuleRequirements, getDeclaredPythonDeps, installPythonPackage } = require('./env-agent');
const { ensureEnvRunning } = require('./ensure-env');
const { classifyFailureWithAgent } = require('./failure-classifier');
const { withProjectLock } = require('./project-lock');

const DEPLOY_LIMIT = 3;

// 從 Odoo 完整 log 抽出「真正的錯誤」給人看：Python traceback 的原因在「結尾的例外行」
// （如 odoo.exceptions.UserError: ...），開頭是無用的呼叫堆疊（server.py→decorator.py…）。
// 舊版從 traceback 開頭切 → blocker 只顯示呼叫堆疊、真正原因被截掉，使用者被迫翻 log。
// 改為：從尾端找最後一個例外行，連同其說明帶到最前，一眼看到原因（如「external dependency ... xlsxtpl」）。
function extractOdooError(log) {
  const s = String(log == null ? '' : log).trim();
  if (!s) return '(log 為空)';
  const lines = s.split(/\r?\n/);
  // Python 例外行：以「例外類別名（結尾 Error/Exception/Warning）: 訊息」起頭，且不含日誌時間戳前綴。
  // 從尾往上找最後一個 → 那是最外層、對人最有意義的原因。
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[\w.]*(Error|Exception|Warning|Interrupt)\b.*:/.test(lines[i].trim())) {
      return lines.slice(i).join('\n').trim().slice(0, 800);
    }
  }
  // 無標準例外行 → 退回最後一個 ERROR/CRITICAL 行起
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ERROR|CRITICAL/.test(lines[i])) return lines.slice(i).join('\n').trim().slice(0, 800);
  }
  // 完全沒有錯誤標記＝行程在載入模組前就死了，多半是環境/啟動層問題而非模組程式碼——
  // 標注出來，人與 coding agent 才不會拿 banner 當程式錯誤鑑識（健檢根因 C）
  return '（log 無 ERROR/Traceback——可能是環境或啟動層問題，非模組程式碼錯誤）\n' + s.slice(-600).trim();
}

// 進程異常死亡但 log 無任何 Odoo 錯誤行＝infra／資源層死亡（OS-kill／OOM／crash／access violation），
// 非模組程式碼問題。真程式錯（ParseError／ImportError／語法錯）必在 log 留 ERROR／CRITICAL／Traceback；
// 完全沒有＝還沒載到本模組就整個被幹掉（如核心模組升級吃光資源）——退 coding 無用（改本模組救不了核心死），
// 一律歸 env。107 事故：deploy log exitCode 4294967295、killed:no、只到核心模組載入即中止。
// 註：err.killed（我方 timeout kill）另由 stopEnvTimeout 攔，不走這裡。
function looksLikeInfraDeath(err) {
  if (!err) return false;
  // OS-kill／crash／OOM／access violation 在 Windows 以非常規退出碼結束（4294967295=0xFFFFFFFF、0xC000_xxxx
  // 等 >=2^31），POSIX 被信號殺為負值。正常 Odoo 程式錯誤走 SystemExit(1)——exit 1 的清楚錯誤交既有 classifier，
  // 不在此攔（否則會把「Connection refused」這類已能正確歸 env 的搶走、改成不同 verdict）。
  const code = err.exitCode;
  const abnormalExit = typeof code === 'number' && (code < 0 || code >= 0x80000000);
  if (!abnormalExit) return false;
  // 且 log 無任何 Odoo 錯誤行（真程式錯必留 ERROR／CRITICAL／Traceback）：猝死＋無錯誤＝還沒載到本模組就被幹掉。
  const log = `${err.message || ''}\n${err.stderr || ''}\n${err.stdout || ''}`;
  const hasOdooError = /Traceback \(most recent call last\)|\bERROR\b|\bCRITICAL\b|^[ \t]*[\w.]*(Error|Exception|Warning|Interrupt)\b.*:/m.test(log);
  return !hasOdooError;
}

// 從 'No module named X' 類錯誤抽出缺的模組/套件名（供缺件細分：自家 addon import／已宣告／漏宣告）。
// 找不到回 null。
function parseMissingModule(text) {
  const m = String(text == null ? '' : text).match(/No module named ['"]([\w.]+)['"]/i);
  return m ? m[1] : null;
}

// 失敗診斷完整落地：blocker/feedback 只留摘要，exit code 與兩路輸出存檔供事後鑑識
function saveDeployLog(taskId, count, err) {
  try {
    const dir = process.env.DEPLOY_LOG_DIR || path.join(__dirname, '..', '..', '..', 'data', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `deploy-task${taskId}-${count}.log`);
    fs.writeFileSync(file, [
      `exitCode: ${err.exitCode ?? '?'}｜killed: ${err.killed ? 'yes' : 'no'}`,
      '--- stderr ---', err.stderr || err.message || '(空)',
      '--- stdout ---', err.stdout || '(空)'
    ].join('\n'));
    return file;
  } catch { return null; }
}

// 把 deploy 失敗的 env/code 判定寫進執行歷程，讓「為什麼停／為什麼回開發」可稽核（不再是黑箱：
// 舊行為只在 stop 時透過 blocker_content 留痕，code→coding 那條靜默，看起來像「沒分 env/code」）。
function emitDeployVerdict(userId, taskId, verdict) {
  const msg = `\n\x1b[93m⚖ 部署失敗判定：${verdict}\x1b[0m\n`;
  notify.emitToUser(userId, 'terminal:output', { taskId, data: msg });
  return query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)', [taskId, msg]).catch(() => {});
}

// 升級逾時被中止：重試無益（只會再 hang 一次），一律當環境／資源問題停等人工（健檢 F8）。
async function stopEnvTimeout(taskId, userId, err) {
  await emitDeployVerdict(userId, taskId, '升級逾時被中止 → 停等人工（重試無益），視為環境／資源問題');
  const logFile = saveDeployLog(taskId, `timeout-${Date.now()}`, err);
  const logRef = logFile ? `\n完整 log：${logFile}` : '';
  await query(
    "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
    [taskId, `測試區升級逾時（超過 10 分鐘被中止），多為環境／資源問題（DB lock、資源不足或啟動卡住），請檢查後重試。${logRef}`]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

// 升級進程異常死亡（非我方逾時、log 無 Odoo 錯誤＝infra／資源層被中止）：停等人工，不退 coding（比照 stopEnvTimeout）。
async function stopEnvDeath(taskId, userId, err) {
  await emitDeployVerdict(userId, taskId, '升級進程異常結束但 log 無 Odoo 錯誤（infra／資源層）→ 停等人工，不退開發');
  const logFile = saveDeployLog(taskId, `envdeath-${Date.now()}`, err);
  const logRef = logFile ? `\n完整 log：${logFile}` : '';
  await query(
    "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
    [taskId, `測試區升級進程異常結束（退出碼 ${err.exitCode ?? '?'}）但 log 無任何 Odoo 錯誤，多為核心模組升級被 OS／資源中止（未達本模組），視為環境／資源問題，請檢查後重試。${logRef}`]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

// 部署測試區（純程式）：確保 env 運行 → odoo-bin -u 升級。
// 升級成功→playwright_running；升級失敗（程式錯）→退 coding 計數（滿 DEPLOY_LIMIT→stopped）；env 起不來→stopped（infra）。
async function runDeployTesting(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, analysis_yaml, deploy_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;
  return withProjectLock(task.project_id, () => doDeploy(task, taskId, userId, signal));
}

async function doDeploy(task, taskId, userId, signal) {
  let running = false;
  try { running = await ensureEnvRunning(task.project_id); } catch { running = false; }
  if (!running) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='測試環境無法啟動，請至專案環境頁檢查', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  // 升級前確保各主 clone 檢出 testing：別任務的 analysis（ensureMainBranch）或 approve（mergeToMain）
  // 會把主 clone 留在 main——addons-path 指向主 clone 工作樹，不歸位就會對錯的分支升級／測試（假綠燈）。
  // 先丟 tracked pyc 的髒改動，避免 checkout 被 build 產物擋住（比照 mergeInto）。
  const { discardPyc, ensureTestingBranch } = require('./git');
  const { rows: repos } = await query(
    "SELECT local_path, label FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [task.project_id]
  );
  for (const repo of repos) {
    try {
      await discardPyc(repo.local_path);
      await ensureTestingBranch(repo.local_path);
    } catch (e) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, `部署前切換 ${repo.label} 到 testing 分支失敗：${e.message}`]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      return;
    }
  }

  let moduleName = '';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; }
  catch { /* SD 解析失敗則升級全部 */ }

  const mods = moduleName ? [moduleName] : [];
  const clsCtx = { taskId: task.task_id, projectId: task.project_id, userId };

  // 升級前自動補裝各自訂模組宣告的 Python 相依（env 建置只裝 Odoo 核心 requirements，模組自帶的漏裝）。
  // best-effort：裝不動不硬擋，真正缺的相依會讓下方升級以清楚錯誤停下。
  // reqLog（含逐套件 OK/FAIL）保留下來：終端顯示＋失敗時帶進 blocker，不再收下即丟（健檢 F5）。
  let reqLog = '';
  try {
    reqLog = (await installModuleRequirements(task.project_id, signal)) || '';
    if (reqLog) notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 補裝模組 Python 相依...\n${reqLog}` });
  } catch { /* best-effort */ }
  if (signal?.aborted) return;

  let err = null;
  try {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 測試區升級模組 ${moduleName || 'all'}...\n` });
    await upgradeModules(task.project_id, mods, signal);
  } catch (e) { err = e; }

  // 手動暫停中止子行程：非失敗，狀態原地不動、不分類不計數，解除暫停後從這一關重跑
  if (err && signal?.aborted) return;

  // 升級逾時被殺（execCmd 600s timeout kill）：重試只會再 hang 一次 10 分鐘，直接當環境/資源問題
  // 停等人工（健檢 F8）。必須在 transient 之前攔——否則 err.message 帶 "killed" 會落 transient 而重跑再 hang。
  if (err && err.killed) {
    await stopEnvTimeout(taskId, userId, err);
    return;
  }
  // 進程異常死亡（非我方 kill）但 log 無任何 Odoo 錯誤＝infra／資源層死亡，退 coding 無用，歸 env（見 looksLikeInfraDeath）。
  // 必須在 classifyFailureWithAgent 之前攔——否則 haiku 會把「沒有錯誤行的異常退出」瞎猜成 code 而誤退 coding（107 事故）。
  if (err && looksLikeInfraDeath(err)) {
    await stopEnvDeath(taskId, userId, err);
    return;
  }

  // 依失敗類別歸因，只算一次（健檢 F3：舊版同一 err 逐字問 haiku 兩次、token 雙倍且判定漂移）
  let cls = err ? await classifyFailureWithAgent(err.message, clsCtx) : null;

  // transient（網路抖動/被砍）→ 自動重試一次，不佔計數
  if (err && cls === 'transient') {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 暫時性失敗，自動重試一次...\n` });
    err = null;
    try { await upgradeModules(task.project_id, mods, signal); } catch (e) { err = e; }
    if (err && signal?.aborted) return;
    if (err && err.killed) { await stopEnvTimeout(taskId, userId, err); return; }
    // 重試仍敗：不重新問 haiku（避免判定漂移把網路抖動退成 code 燒 opus），直接當環境問題停等人工
    if (err) cls = 'env';
  }

  if (err) {
    // 缺套件細分（健檢 F4/F6/F7）：'No module named X' 有三種真相，別一律當 env 停等人工——
    //   - X 以 odoo.addons.<module> 起頭＝coding 自家 import 打錯路徑（指到不存在的 model/檔）＝程式問題
    //   - X 是第三方套件且模組已宣告＝真環境缺件，自動 pip 補裝＋重試升級一次
    //   - X 是第三方套件但沒宣告＝該退 coding 補 __manifest__ 宣告（否則環境重建必復發）
    let codeHint = '';
    const missing = cls === 'env' ? parseMissingModule(err.message) : null;
    if (missing) {
      if (/^odoo\.addons\./i.test(missing)) {
        cls = 'code';
        codeHint = `\n（缺的是自家模組路徑 ${missing}，多為 import 打錯 model/檔名，請修正 import）`;
      } else {
        const topPkg = missing.split('.')[0].toLowerCase();
        const declared = await getDeclaredPythonDeps(task.project_id);
        if (declared.has(topPkg)) {
          notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 缺套件 ${topPkg} 已宣告，自動 pip 補裝後重試升級一次...\n` });
          const fix = await installPythonPackage(task.project_id, topPkg, signal);
          reqLog += fix.log;
          notify.emitToUser(userId, 'terminal:output', { taskId, data: fix.log });
          if (fix.ok) {
            err = null;
            try { await upgradeModules(task.project_id, mods, signal); } catch (e) { err = e; }
            if (err && signal?.aborted) return;
            if (err && err.killed) { await stopEnvTimeout(taskId, userId, err); return; }
            if (err) cls = await classifyFailureWithAgent(err.message, clsCtx); // 補裝後仍敗，重新分類
          }
          // fix.ok=false（pip 裝不動）：維持 env，pipLog 已納入 reqLog 帶進下方 blocker
        } else {
          cls = 'code';
          codeHint = `\n請在模組 __manifest__.py 的 external_dependencies['python'] 補上宣告：${topPkg}（缺套件但未宣告，人工手動 pip 後環境一重建就再次缺件）`;
        }
      }
    }

    if (err) {
      const odooErr = extractOdooError(err.message);
      const pipRef = /FAIL/.test(reqLog) ? `\npip 補裝紀錄：\n${reqLog.slice(-400)}` : '';

      if (cls !== 'code') {
        // 環境/仍暫時性問題：停下等人工修環境，不動 coding 計數。
        await emitDeployVerdict(userId, taskId, '環境問題（非程式碼）→ 停等人工，不退開發');
        // env 路徑不累加 deploy_retry_count，log 檔名用時間戳避免重複覆蓋、丟失前次診斷
        const logFile = saveDeployLog(taskId, `env-${Date.now()}`, err);
        const logRef = logFile ? `\n完整 log：${logFile}` : '';
        await query(
          "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
          [taskId, `環境問題（非程式碼），請檢查測試環境後重試。最後錯誤：${odooErr.slice(0, 500)}${logRef}${pipRef}`]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
        return;
      }

      // 程式碼問題：退回 coding 修正並計數（滿上限 stopped）
      const nextCount = (task.deploy_retry_count || 0) + 1;
      const logFile = saveDeployLog(taskId, nextCount, err);
      const logRef = logFile ? `\n完整 log：${logFile}` : '';
      await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', '[部署測試區升級失敗]')", [taskId]);
      const feedback = `[部署測試區升級失敗]\n${odooErr}${codeHint}${logRef}`;
      if (nextCount >= DEPLOY_LIMIT) {
        await emitDeployVerdict(userId, taskId, `程式問題 → 連續 ${DEPLOY_LIMIT} 次失敗、停等人工`);
        await query(
          "UPDATE tasks SET status='stopped', blocker_type='code', deploy_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
          [taskId, nextCount, `測試區升級連續 ${DEPLOY_LIMIT} 次失敗，需人工介入。最後錯誤：${odooErr.slice(0, 500)}${codeHint}${logRef}`]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      } else {
        // 總循環達上限 → 停下，但保留本次真診斷（健檢 F10：舊版被通用「循環 N 次」訊息整包覆寫）。
        // emitDeployVerdict 移到確定會退開發之後才發，避免觸頂時仍留下「退開發第 1/3 次」的誤導事件。
        const { bumpReentryOrStop } = require('./reentry');
        if (await bumpReentryOrStop(taskId, userId, { blockerType: 'code',
            blockerContent: `最後錯誤：${odooErr.slice(0, 500)}${logRef}` })) return;
        await emitDeployVerdict(userId, taskId, `程式問題 → 退開發修正（第 ${nextCount}/${DEPLOY_LIMIT} 次）`);
        await query(
          "UPDATE tasks SET status='coding_running', deploy_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
          [taskId, nextCount, feedback]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
      }
      return;
    }
    // err 被自動補裝清掉 → 落到下方成功流程
  }

  // 部署成功：歸零 deploy_retry_count（健檢 F9：舊版成功不歸零，新 bug 首次部署失敗即被前輪累計推爆、
  // 一次自動重試額度都沒有）。
  // 專案停用 E2E（如串接外部系統無法在測試區實測）：純程式跳過 tour，直接進最終人工審核。
  // 留一行痕跡，審核者才知是刻意跳過而非流程壞掉。
  const { rows: [proj] } = await query('SELECT e2e_disabled FROM projects WHERE id=$1', [task.project_id]);
  if (proj && proj.e2e_disabled) {
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', 'E2E 已依專案設定停用，跳過')", [taskId]);
    await query("UPDATE tasks SET status='review_pending', deploy_retry_count=0, updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'review_pending' });
    return;
  }

  await query("UPDATE tasks SET status='playwright_running', deploy_retry_count=0, updated_at=NOW() WHERE id=$1", [taskId]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'playwright_running' });
}

module.exports = { runDeployTesting, extractOdooError, looksLikeInfraDeath };
