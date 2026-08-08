const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { query } = require('../db');
const notify = require('../notify');
const { upgradeModules, installModuleRequirements, getDeclaredPythonDeps, installPythonPackage, restartEnv, assetSmokeCheck } = require('./env-agent');
const { ensureEnvRunning } = require('./ensure-env');
const { classifyFailureWithAgent } = require('./failure-classifier');
const { withProjectLock } = require('./project-lock');

const DEPLOY_LIMIT = 3;
// asset 失敗時要附多少 log 給 coding 看（QWeb 的 xpath 錯誤 traceback 通常十幾行）
const ASSET_LOG_TAIL_BYTES = parseInt(process.env.ASSET_LOG_TAIL_BYTES || '4000', 10);

// asset bundle 編不出來時，真正的原因（哪個 template、哪個 xpath 對不到什麼）只在 Odoo 的
// runtime log 裡——assetSmokeCheck 只看得到 HTTP 狀態碼，reason 永遠是「bundle URL → HTTP 500」。
// 不附這段，coding 拿到的等於一句「壞了」，只能猜：實測 task 109 猜了三輪都沒中，每輪燒完
// 整條 pipeline。讀檔而已，零 token 成本。
// 讀不到一律回空字串：log 缺檔／權限不足不該讓部署流程本身出錯（本函式永不拋出）。
//
// 一定要走 `docker logs`，不可讀 <envDir>/odoo.log：docker 模式的容器 CMD 沒有 --logfile，
// 宿主上根本不會有那個檔（寫入端隨 venv 模式一起退場），existsSync 因此恆 false ＝整個功能是
// no-op；更糟的是 venv 時代建的專案可能殘留陳年 odoo.log，會把兩週前的 traceback 冠上
// 「真正的錯誤在這裡」餵進 coding 的 prompt。env-routes 的「查看 log」早就是這個寫法。
// header 可換：升級失敗那條路也要附這段（分診 agent 的 stop_context 就是 blocker_content，
// c8287fe 拿掉 {{runtime_log_path}} 後它已無法自己去讀 log），但那裡的「真正的錯誤」在 odoo-bin
// 的輸出而不在常駐 server 的 log，沿用 asset 的措辭會把分診指錯地方。
async function readAssetTraceback(projectId, header = '【測試環境 runtime log 尾端（真正的錯誤在這裡，不要只看上面的通用說明）】') {
  try {
    const { dockerCtxFor } = require('./env-agent');
    const dockerEnv = require('../lib/docker-env');
    const ctx = await dockerCtxFor(projectId);
    if (!ctx || !(await dockerEnv.containerExists(ctx.container))) return '';
    // tail 以行數取，再截尾端位元組：QWeb 的 xpath traceback 通常十幾行，200 行綽綽有餘，
    // 且避免一次把整個容器 log 拉進記憶體。
    const log = await dockerEnv.containerLogs(ctx.container, { tail: 200 }).catch(() => '');
    const tail = String(log || '').slice(-ASSET_LOG_TAIL_BYTES).trim();
    if (!tail) return '';
    return `\n\n${header}\n${tail}`;
  } catch { return ''; }
}

// 從 Odoo 完整 log 抽出「真正的錯誤」給人看：Python traceback 的原因在「結尾的例外行」
// （如 odoo.exceptions.UserError: ...），開頭是無用的呼叫堆疊（server.py→decorator.py…）。
// 舊版從 traceback 開頭切 → blocker 只顯示呼叫堆疊、真正原因被截掉，使用者被迫翻 log。
// 改為：從尾端找最後一個例外行，連同其說明帶到最前，一眼看到原因（如「external dependency ... xlsxtpl」）。
// Python 例外行：以「例外類別名（結尾 Error/Exception/Warning）: 訊息」起頭，且不含日誌時間戳前綴。
const EXC_LINE = /^[\w.]*(Error|Exception|Warning|Interrupt)\b.*:/;
// chained exception 的兩種串接標記（`raise X from Y` 與巢狀 except）——真因在標記「之前」那一段。
const CHAIN_MARK = /^(?:The above exception was the direct cause of the following exception|During handling of the above exception, another exception occurred):\s*$/;

// 從尾往上找例外行的 index（-1＝沒有）
function findExcIdx(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (EXC_LINE.test(lines[i].trim())) return i;
  return -1;
}

const FRAME_LINE = /^\s*File "([^"]+)", line (\d+)(?:, in (.+))?$/;
// Odoo 核心的路徑（docker 內為 dist-packages，本機 venv 亦同結尾）。核心檔一律不是「該改的檔」——
// CLAUDE.md 硬規則禁止修改 core，指過去等於把 coding agent 導向死路。
const CORE_PATH = /(^|\/)(usr\/lib\/python3\/dist-packages|site-packages)\/odoo\//;
// Python 動態產生的偽檔名（<decorator-gen-5>、<string>、<frozen importlib._bootstrap>）——
// 不是真的檔案，改不了也讀不了。Odoo 大量使用 @api.model_create_multi 等裝飾器，這類 frame 極常見。
const PSEUDO_PATH = /^</;
// 這個 frame 指向的檔案，人或 coding agent 真的動得了嗎
function isActionableFrame(p) { return !PSEUDO_PATH.test(p) && !CORE_PATH.test(p); }

// 例外行上方的 traceback frame 中，挑「最可能是該改的那個檔」：
// 優先取最深的**非核心** frame（客戶模組掛在 /mnt/extra-addons，也涵蓋本機路徑），
// 全部都在核心內才退回最內層。Odoo 的例外幾乎都從 core 拋出，直接取最內層會常態指向
// odoo/tools/lru.py、odoo/models.py 這種與問題無關的位置。
function blameFrame(lines, beforeIdx) {
  let fallback = null;
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const m = lines[i].match(FRAME_LINE);
    if (!m) continue;
    const label = `  ↳ ${m[1]}:${m[2]}${m[3] ? ` in ${m[3].trim()}` : ''}`;
    if (isActionableFrame(m[1])) return label;  // 最深的可動檔案＝最可能該改的那個
    if (!fallback) fallback = label;           // 記住最內層，全核心時才用
  }
  return fallback;
}

// Odoo 的 @ormcache（如 _xmlid_lookup）在 cache-miss 時於 `except KeyError:` 區塊內重拋，
// 於是「xmlid 找不到」這個高頻錯誤的鏈，第一段永遠是 lru.py 的 KeyError——零診斷價值，而真正
// 可行動的 `ValueError: External ID not found in the system: xxx` 在後面的段。
// 特徵是 KeyError 的內容為 ormcache 的 key tuple，必含 `<function ...>` 這個 repr。
const ORMCACHE_NOISE = /^KeyError: \(.*<function .+>/;

// 這一段 traceback 是否只是核心內部的中繼例外。**刻意只認明確認得出的雜訊**：
// 起初寫成「整段沒有可動 frame 就算雜訊」，但 xmlid 這類錯誤純粹發生在 core 內
//（客戶的 XML 是資料不是程式碼，traceback 裡本來就沒有客戶的 .py），那樣會把真正的根因
// 一起跳過、最後退回第一段，等於沒修。寧可漏認雜訊，不可誤殺根因。
function isNoiseSegment(seg) {
  const i = findExcIdx(seg);
  return i >= 0 && ORMCACHE_NOISE.test(seg[i].trim());
}

function extractOdooError(log) {
  const s = String(log == null ? '' : log).trim();
  if (!s) return '(log 為空)';
  const lines = s.split(/\r?\n/);

  // chained exception：真因在第一段，結尾那段只是包裝。Odoo 載入 data 檔時會把任何例外都包成
  // ParseError，所以這是 deploy 失敗的高頻形態；只取結尾＝肇事的 .py 檔與行號整個消失，
  // 人與 coding agent 都只剩「某個 XML 有問題」的錯誤印象（task 171：真因在 alnas_xlsx，
  // 卻被報成 idx_hj 的報表 XML 壞掉，coding 被導去改根本沒問題的檔）。
  // 根因放最前是硬需求——blocker_content 只截前 500 字。
  const segs = [];
  let segStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (CHAIN_MARK.test(lines[i].trim())) { segs.push(lines.slice(segStart, i)); segStart = i + 1; }
  }
  if (segs.length) {
    // 「第一段＝根因」對兩段鏈成立，三段以上就不一定：Odoo 最高頻的 xmlid 錯誤（ref 指到不存在的
    // external id）第一段固定是 ormcache cache-miss 的 KeyError，真正可行動的
    // 「ValueError: External ID not found in the system: xxx」在後面的段。
    // 改成取「第一個含有客戶碼 frame 的段」；全部都是核心內部堆疊才退回第一段。
    const rootSeg = segs.find(sg => !isNoiseSegment(sg) && findExcIdx(sg) >= 0) || segs[0];
    const rootIdx = findExcIdx(rootSeg);
    const outerIdx = findExcIdx(lines);
    if (rootIdx >= 0 && outerIdx >= 0) {
      const root = [rootSeg[rootIdx].trim(), blameFrame(rootSeg, rootIdx)].filter(Boolean).join('\n');
      const outer = lines.slice(outerIdx).join('\n').trim().slice(0, 600);
      return `${root}\n↓ 被包裝成：\n${outer}`;
    }
  }

  // 單層：從尾往上找最後一個例外行 → 那是最外層、對人最有意義的原因。
  const idx = findExcIdx(lines);
  if (idx >= 0) return lines.slice(idx).join('\n').trim().slice(0, 800);
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
// 容器內指令被訊號砍死時，shell／docker exec 回的是 128+N：137=128+9（SIGKILL，容器 OOM-kill 的標準長相）、
// 139=128+11（SIGSEGV，原生層崩潰）。deploy 已全面 docker 化，OOM 走的正是這條而非下方 Windows 的形狀。
// 取捨：128+N 這個「形狀」本身不算證據（一般工具也能正常回這區間的值），故不整段收 129–159，只收這兩個
// 明確是資源層猝死的訊號；143（SIGTERM）＝有秩序地被要求停止（docker stop／夜間關機），語意不是資源層死亡，
// 交既有 classifier 即可（落 env，結果一樣安全）。我方 timeout kill 另由 err.killed 攔，不進這裡。
// 誤判成本不對稱是此處放寬的依據：多攔＝停等人工看一眼（安全側）；漏攔＝退 coding 重寫一整輪再 OOM 一次。
const SIGNAL_DEATH_EXITS = new Set([137, 139]);

function looksLikeInfraDeath(err) {
  if (!err) return false;
  // OS-kill／crash／OOM／access violation 在 Windows 以非常規退出碼結束（4294967295=0xFFFFFFFF、0xC000_xxxx
  // 等 >=2^31），POSIX 被信號殺為負值。正常 Odoo 程式錯誤走 SystemExit(1)——exit 1 的清楚錯誤交既有 classifier，
  // 不在此攔（否則會把「Connection refused」這類已能正確歸 env 的搶走、改成不同 verdict）。
  const code = err.exitCode;
  const abnormalExit = typeof code === 'number'
    && (code < 0 || code >= 0x80000000 || SIGNAL_DEATH_EXITS.has(code));
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

// 從 "cannot import name 'X' from 'Y' (載入路徑)" 抽出符號、套件與實際載入路徑。ImportError 有兩種真相：
// 套件根本沒裝（'No module named'，見 parseMissingModule）、與套件裝了但版本太舊沒有該符號。classifier
// 對後者一律判 code（"模組在、名稱不對＝寫錯 import"）——對自家模組成立，對第三方套件則指錯方向。
// 括號內的載入路徑是 Python 自己印的，正是分辨這兩者的唯一線索。找不到回 null（含循環 import 的
// 'from partially initialized module'——那是真程式錯，不該被這裡收走）。
function parseVersionMismatch(text) {
  const m = String(text == null ? '' : text)
    .match(/cannot import name ['"]([\w.]+)['"] from ['"]([\w.]+)['"]\s*\(([^)]+)\)/i);
  return m ? { symbol: m[1], pkg: m[2], loadedFrom: m[3] } : null;
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

  // 升級前確保各主 clone 檢出 testing：別任務的 analysis（ensureMainBranch）會把主 clone 留在 main，
  // 或 approve（mergeToAiBranch）會留在 ai-dev——addons-path 指向主 clone 工作樹，不歸位就會對錯的分支升級／測試（假綠燈）。
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

    // 版本不符（套件在、版本太舊沒有該符號）：cls 已由 classifier 判 code、路由不變，這裡只補事實。
    // 只在載入路徑落在 dist-/site-packages 時出手——那是唯一「釘版本救不了」的形狀：
    // installModuleRequirements 只以套件名安裝（不帶版本、不加 --upgrade），pip 見已安裝即略過，
    // 於是 requirements.txt 的版本限定永遠是 no-op。缺了這個事實，coding 讀完錯誤只會確認「規格三項
    // 都已滿足」然後零變更停擺（實測 task 114：PyPDF2 1.26 無 PdfReader，釘 >=2.0 後仍原地失敗兩輪）。
    // 路徑落在 addons 內＝開發者自己 import 打錯，classifier 原本的判讀就對，不加這段以免指錯方向。
    const verMismatch = (err && !codeHint) ? parseVersionMismatch(err.message) : null;
    if (verMismatch && /dist-packages|site-packages/.test(verMismatch.loadedFrom)) {
      const { symbol, pkg, loadedFrom } = verMismatch;
      codeHint = `\n（缺的不是套件而是版本：${pkg} 已安裝於 ${loadedFrom}，但其中沒有 ${symbol}。`
        + `平台補裝相依時只以套件名安裝、不帶版本也不加 --upgrade，故在 requirements.txt 釘版本對它無效，`
        + `改宣告版本不會有任何效果。可行的修法有二：改用不同名稱的替代套件（同時在 requirements.txt 與`
        + ` __manifest__.py 的 external_dependencies['python'] 宣告），或改寫程式以相容 ${pkg} 現有版本的 API）`;
    }

    if (err) {
      const odooErr = extractOdooError(err.message);
      const pipRef = /FAIL/.test(reqLog) ? `\npip 補裝紀錄：\n${reqLog.slice(-400)}` : '';
      // 分診 agent 讀得到的只有 blocker_content（reject-triage 的 stop_context 就是它），而 c8287fe
      // 已把 {{runtime_log_path}} 從 prompt 拿掉、改成「證據已附在上面」——不附等於告訴它「這次沒有
      // 可用的 runtime log」，它就不再追。升級失敗是最常見的入口，卻從頭到尾沒附過任何 log
      // （readAssetTraceback 原本只在 asset 分支被呼叫）。
      const runtimeTail = await readAssetTraceback(task.project_id,
        '【測試環境 runtime log 尾端（常駐 server 端；升級指令自己的完整輸出見上面的 log 檔）】');

      if (cls !== 'code') {
        // 環境/仍暫時性問題：停下等人工修環境，不動 coding 計數。
        await emitDeployVerdict(userId, taskId, '環境問題（非程式碼）→ 停等人工，不退開發');
        // env 路徑不累加 deploy_retry_count，log 檔名用時間戳避免重複覆蓋、丟失前次診斷
        const logFile = saveDeployLog(taskId, `env-${Date.now()}`, err);
        const logRef = logFile ? `\n完整 log：${logFile}` : '';
        await query(
          "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
          [taskId, `環境問題（非程式碼），請檢查測試環境後重試。最後錯誤：${odooErr.slice(0, 500)}${logRef}${pipRef}${runtimeTail}`]
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
        // retry_feedback 一併寫：blocker_content 是給人看的停下原因，coding 讀的是 retry_feedback。
        // 只寫前者的話，使用者填修正指示 → 分診判 fix → 回 coding 時失敗訊息已遺失（上一輪推進時
        // 消費成 NULL），coding 收到空輸入只能空轉（實測 task 109）。未觸頂的退回分支本來就有寫。
        await query(
          "UPDATE tasks SET status='stopped', blocker_type='code', deploy_retry_count=$2, blocker_content=$3, retry_feedback=$4, updated_at=NOW() WHERE id=$1",
          [taskId, nextCount, `測試區升級連續 ${DEPLOY_LIMIT} 次失敗，需人工介入。最後錯誤：${odooErr.slice(0, 500)}${codeHint}${logRef}${runtimeTail}`, feedback]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      } else {
        // 總循環達上限 → 停下，但保留本次真診斷（健檢 F10：舊版被通用「循環 N 次」訊息整包覆寫）。
        // emitDeployVerdict 移到確定會退開發之後才發，避免觸頂時仍留下「退開發第 1/3 次」的誤導事件。
        const { bumpReentryOrStop } = require('./reentry');
        if (await bumpReentryOrStop(taskId, userId, { blockerType: 'code',
            blockerContent: `最後錯誤：${odooErr.slice(0, 500)}${logRef}${runtimeTail}` })) return;
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

  // 升級成功後重啟常駐容器：docker exec -u 的一次性進程只改了 DB，常駐 server 仍持進程啟動時 import 的
  // registry 與 Python controllers——新增/改動的 controller(HTTP 路由)不重啟不生效、開測試區報錯，使用者
  // 被迫手動重啟。重啟以原 CMD 重跑、重新 import 所有已裝模組 controllers。重啟失敗不阻斷部署（碼已進 DB），
  // 只發一行提示；E2E tour 走自己的 exec http server、不受此重啟影響。
  if (signal?.aborted) return;
  try {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: '[DEPLOY] 升級成功，重啟測試環境套用新碼...\n' });
    await restartEnv(task.project_id);
  } catch (e) {
    notify.emitToUser(userId, 'terminal:output', { taskId, data: `[DEPLOY] 重啟測試環境失敗（不阻斷部署，必要時可手動重建）：${e.message}\n` });
  }

  // 後台 asset bundle 冒煙檢查：排在重啟「之後」才有意義（測的是新 registry）。OWL/QWeb template
  // （static/src/xml）的 xpath 錯誤只在瀏覽器首次請求 bundle 時 lazy 編譯才現形，且失敗是 WARNING＋404
  // 不改 exit code——-u --stop-after-init 與無 tour 的 E2E 都碰不到，會一路綠燈到白屏。只有「後台頁能生成
  // 但 bundle 明確 404/500」才判 code 失敗；連不上／registry 未就緒／拿不到 URL 一律 inconclusive 不阻斷
  // （比照上面重啟失敗不擋部署），避免暫態誤報。
  if (signal?.aborted) return;
  let assetRes = { ok: true };
  try { assetRes = await assetSmokeCheck(task.project_id); } catch { /* 檢查本身出錯不阻斷部署 */ }
  if (assetRes.assetError) {
    const nextCount = (task.deploy_retry_count || 0) + 1;
    const trace = await readAssetTraceback(task.project_id);
    // 升級失敗有 saveDeployLog 落 data/logs，asset 失敗一次都沒呼叫過——於是這段 traceback（實測
    // 1177 字）的三條退路全不成立：blocker_content 只切 500 字且只在觸頂那一輪才寫、retry_feedback
    // 下一輪即被覆寫且前端零渲染、而時間軸指的「📄 查看 log」依 CLAUDE.md §6 是每次啟動清空的檔案。
    // 落檔是唯一留得住的地方，也讓下面那句話有一個真的找得到的位置可指。
    const logFile = saveDeployLog(taskId, `asset-${nextCount}`, {
      exitCode: 'n/a',
      stderr: `asset bundle 檢查失敗：${assetRes.reason || ''}`,
      stdout: trace || '(容器 runtime log 讀不到)',
    });
    const logRef = logFile ? `\n完整 log：${logFile}` : '';
    const detail = `[部署測試區 asset 檢查失敗]\n後台 JS bundle 編不出來（多為 OWL/QWeb template 的 xpath 對不到目標，模組安裝與 --stop-after-init 都驗不到、只在瀏覽器開後台才現形）：${assetRes.reason || ''}${trace}${logRef}`;
    // 時間軸給人看，只寫現象與去哪看；detail 含原始 Python traceback（實測 1177 字），原文貼上去
    // 使用者只會看到一整段 stack。完整內容仍走 retry_feedback 餵 coding、blocker_content 留給人工。
    await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId,
      '[部署測試區 asset 檢查失敗]\n新版程式讓測試區的後台頁面載入不出來（開啟時會空白或一直轉圈）。這是程式問題，不是環境問題。'
      + (logFile ? `\n完整錯誤訊息（含 traceback）已存檔：${logFile}` : '\n（完整錯誤訊息存檔失敗，請看下方停下原因）')]);
    if (nextCount >= DEPLOY_LIMIT) {
      await emitDeployVerdict(userId, taskId, `asset 問題 → 連續 ${DEPLOY_LIMIT} 次失敗、停等人工`);
      // 同升級失敗觸頂：blocker_content 給人看，retry_feedback 給 coding 讀，兩邊都要寫。
      // 截斷後再補一次 logRef：500 字必然切在 traceback 中間，不補就連檔案路徑都留不住。
      await query(
        "UPDATE tasks SET status='stopped', blocker_type='code', deploy_retry_count=$2, blocker_content=$3, retry_feedback=$4, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, `${detail.slice(0, 500)}${logRef}`, detail]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      const { bumpReentryOrStop } = require('./reentry');
      if (await bumpReentryOrStop(taskId, userId, { blockerType: 'code', blockerContent: detail })) return;
      await emitDeployVerdict(userId, taskId, `asset 問題 → 退開發修正（第 ${nextCount}/${DEPLOY_LIMIT} 次）`);
      await query(
        "UPDATE tasks SET status='coding_running', deploy_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
        [taskId, nextCount, detail]
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
    }
    return;
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
