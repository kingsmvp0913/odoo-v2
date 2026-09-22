const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../db');
const { uploadRoot } = require('../lib/attachments');
const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { buildGitEnv } = require('../lib/git-identity');

const execFileAsync = promisify(execFile);

/**
 * finding-fix.js — 健檢提案的「修這條」
 *
 * 平台自己的修正**不走客戶任務那條 pipeline**：那 15 關有一半是為客戶的 Odoo 設計的（裝模組、
 * 開測試區、跑畫面測試），對 Node 平台碼完全用不上；而且 agent-loader 會把 CLAUDE.md 的 Odoo
 * 開發規則整份注入 analysis／coding，拿去指導改 app/server 是系統性誤導。
 *
 * 這裡是最小可行的替代：獨立工作區改碼 → 自己跑測試 → **逐檔檢查動到哪裡** → diff 給人審 →
 * 人點頭才提交 → 再按一次才推上 GitHub。三段分開，任何一段都可以停在那裡不往前。
 *
 * ⚠ 這是「平台自己改自己」。最陰險的失敗方式是把測試改成永遠通過、或放寬健檢自己的判準——
 * 兩者在指標上都看不出異常。所以範圍檢查寫在**程式裡**（下面的 ALLOW／DENY），不是只寫在提示詞
 * 裡靠 agent 自律：提示詞是請求，程式檢查才是防線。
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const WORKTREE_ROOT = process.env.FIX_WORKTREE_DIR || path.join(REPO_ROOT, '.claude', 'worktrees');
// 光是跑一次全套測試就要數分鐘，改完紅了還要自己修到綠——當年的 600s 預設必然逾時。
// 現在與共用上限同值，旋鈕保留供本關單獨再放寬。
const FIX_TIMEOUT_MS = parseInt(process.env.PLATFORM_FIX_TIMEOUT_MS || '2400000', 10);
// 平台自己的主分支（不是客戶專案的 testing）
const MAIN_BRANCH = process.env.PLATFORM_MAIN_BRANCH || 'master';
// 平台自己複驗一次測試的上限。全套實測 3~4 分鐘，留餘裕但不能沒有上限——卡住會讓修正永遠停在 running。
const FIX_TEST_TIMEOUT_MS = parseInt(process.env.PLATFORM_FIX_TEST_TIMEOUT_MS || '900000', 10);

// 可以動的路徑（POSIX 斜線比對）
const ALLOW = [
  /^app\/server\//,
  /^app\/public\//,
  /^\.claude\/agents\/[^/]+\.md$/,
];
// 一律不准動，優先於 ALLOW
const DENY = [
  { re: /^\.claude\/agents\/health-/, why: '健檢自己的提示詞（放寬自己的判準不會有任何訊號）' },
  { re: /^\.claude\/skills\/healthCheck\//, why: '健檢判準（同上）' },
  // 自動化之後，守門的碼不能在它自己守的範圍裡。人工按按鈕時每一步都有人看，
  // 無人監督時一份修正可以「順手」放寬白名單，而下一晚守門就失效了。
  // 代價：這四支真的有 bug 時只能人工修——那正是人工那條路要留著的理由。
  { re: /^app\/server\/pipeline\/finding-fix\.js$/,  why: '守門碼本體，含這份 ALLOW／DENY 清單' },
  { re: /^app\/server\/pipeline\/nightly-fix\.js$/,  why: '夜間批次與三道保險絲' },
  { re: /^\.claude\/agents\/fix-review\.md$/,        why: '審這份修正的那個 agent 的判準' },
  { re: /^\.claude\/agents\/fix-verify\.md$/,        why: '合併前最後一道複檢的判準' },
  // ⚠ platform-fix.md 自己也在清單內：拿掉 feedback-triage 那一關（2026-09-09）之後，
  // 「這條看不看得懂／該不該自動做」的判準整個搬進了它的提示詞，它已經是入口的守門本身。
  // 讓它改自己的判準，等於讓守門的人自己決定門檻。
  { re: /^\.claude\/agents\/platform-fix\.md$/,      why: '入口的「看不懂就不要硬做」門檻' },
  // 上面幾支擋的是 .md／守門本體，但那些判準有一半在 JS 裡：fix-review.js 的「解析不出來一律
  // reject」與「prompt 不得帶 notes」契約、retire-prefix.js（飢餓防線的前綴）、
  // maintenance.js、ui-preview.js——.md 只是判準的一半，守門碼的程式半邊不能被自動改掉。
  { re: /^app\/server\/pipeline\/(fix-review|fix-verify|feedback-merge|ui-preview|maintenance|retire-prefix)\.js$/,
    why: '守門碼的程式半邊——.md 只是判準的一半' },
];

// git status --porcelain 的一行 → { code, file }。重新命名（R）會有 "old -> new"，取新的那個。
function parseStatusLine(line) {
  const code = line.slice(0, 2);
  let file = line.slice(3).trim();
  const arrow = file.indexOf(' -> ');
  if (arrow !== -1) file = file.slice(arrow + 4);
  return { code, file: file.replace(/^"|"$/g, '') };
}

/**
 * 逐檔裁決。回傳 { files, violations }。
 * 既有測試檔只能新增不能改：`??`（未追蹤）與 `A`（已加入索引）算新增，其餘（M／D／R）算修改。
 */
function classifyChanges(porcelain) {
  const files = [];
  const violations = [];
  for (const raw of String(porcelain || '').split('\n')) {
    if (!raw.trim()) continue;
    const { code, file } = parseStatusLine(raw);
    const denied = DENY.find(d => d.re.test(file));
    if (denied) { violations.push(`${file}：${denied.why}`); continue; }
    if (/^app\/server\/tests\//.test(file)) {
      const isNew = code.trim() === '??' || code[0] === 'A';
      if (!isNew) { violations.push(`${file}：不得修改或刪除既有測試（新增可以）`); continue; }
      files.push(file);
      continue;
    }
    if (!ALLOW.some(re => re.test(file))) { violations.push(`${file}：超出可修改範圍`); continue; }
    files.push(file);
  }
  return { files, violations };
}

const git = (cwd, args, opts = {}) =>
  execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, ...opts });

async function setStatus(fixId, status, extra = {}) {
  const cols = Object.keys(extra);
  const set = ['status=$2', ...cols.map((c, i) => `${c}=$${i + 3}`)].join(', ');
  await query(
    `UPDATE finding_fixes SET ${set}, finished_at = CASE WHEN $2='running' THEN NULL ELSE NOW() END WHERE id=$1`,
    [fixId, status, ...cols.map(c => extra[c])]
  );
}

// 工作區的 node_modules 走 junction 指回主 repo：新開的 worktree 沒有相依，測試根本跑不起來，
// 而重裝一份要好幾分鐘也佔幾百 MB。Windows 的 directory junction 不需要管理員權限。
// 清理時**先手動移除這個連結再刪工作區**——讓 git 去刪一個指向主 repo 的連結太危險。
function linkNodeModules(worktree) {
  const target = path.join(REPO_ROOT, 'app', 'node_modules');
  const link = path.join(worktree, 'app', 'node_modules');
  if (!fs.existsSync(target) || fs.existsSync(link)) return;
  try { fs.symlinkSync(target, link, 'junction'); }
  catch (err) { console.error('[FIX] node_modules link:', err.message); }
}

function unlinkNodeModules(worktree) {
  const link = path.join(worktree, 'app', 'node_modules');
  try {
    if (!fs.existsSync(link)) return;
    // 不用 recursive：對 junction 而言那會是「跟著連結刪到主 repo 的相依」。
    fs.rmSync(link, { recursive: false, force: true });
  } catch {
    try { fs.unlinkSync(link); } catch (err) { console.error('[FIX] unlink node_modules:', err.message); }
  }
}

// jest 的總結行（`Tests: 3 skipped, 3122 passed, 3125 total`）印在 stderr，兩股都收。
function jestSummary(stdout, stderr) {
  const m = /^Tests:\s+(.+)$/m.exec(`${stdout || ''}\n${stderr || ''}`);
  return m ? m[1].trim() : '';
}

// 從 jest 的總結行解出數字。全綠時那行沒有 "N failed" 這一段，要當 0——
// 回 null 會讓 compareToBaseline 判成「解析失敗」，於是全綠的修正反而過不了。
function parseJestCounts(summaryLine) {
  const line = String(summaryLine || '');
  if (!/\btotal\b/.test(line)) return { failed: null, passed: null };
  const f = /(\d+)\s+failed/.exec(line);
  const p = /(\d+)\s+passed/.exec(line);
  if (!p) return { failed: null, passed: null };
  return { failed: f ? Number(f[1]) : 0, passed: Number(p[1]) };
}

// ⚠ `Test Suites:` 那行（例：`Test Suites: 1 failed, 1 passed, 2 total`）跟 `Tests:` 是兩件事：
// 整支測試檔載入失敗（例如改壞的 require、語法錯）時，jest 不會把裡面沒跑到的測試算進
// `Tests:` 的 failed，那一行只會少掉一整批 passed、完全沒有 "failed" 字樣——騙人的 pass。
// suite 級失敗只在這一行留痕，這裡不能刪，否則「suite 載不起來」會被 compareToBaseline 放行。
function parseJestSuiteFailed(stdout, stderr) {
  const m = /^Test Suites:\s+(.+)$/m.exec(`${stdout || ''}\n${stderr || ''}`);
  if (!m) return null;
  const f = /(\d+)\s+failed/.exec(m[1]);
  return f ? Number(f[1]) : 0;
}

/**
 * 平台自己在工作區跑一次測試——**實測結果為準，不採信 agent 自報**。
 *
 * 理由是實測出來的：2026-08-21 那次修正在 `<result>` 裡填 `pass`，同一份 notes 的最後一段卻寫著
 * 「9 failed」，而人在畫面上只看得到那個綠字。自報等於沒有把關。
 */
async function measureTests(worktree) {
  const cwd = path.join(worktree, 'app');
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', 'test:quiet'],
      { cwd, timeout: FIX_TEST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    const summary = jestSummary(stdout, stderr);
    return { ok: true, summary, ...parseJestCounts(summary), suiteFailed: parseJestSuiteFailed(stdout, stderr) };
  } catch (err) {
    // 有紅燈時 jest exit≠0 也走這裡，跟「測試根本沒跑起來」要分得開——靠解不解析得到總結行判定
    const summary = jestSummary(err.stdout, err.stderr);
    return summary
      ? { ok: false, summary, ...parseJestCounts(summary), suiteFailed: parseJestSuiteFailed(err.stdout, err.stderr) }
      : {
        ok: false, summary: '', failed: null, passed: null, suiteFailed: null,
        error: String(err.message || '').split('\n')[0]
      };
  }
}

/**
 * 判準是「有沒有新增紅燈」，不是 exit code = 0。
 *
 * 此 repo 2026-09-03 實測有 4 支既有紅燈。人工審核時人看得到那行字、自己判斷
 * 「那幾支跟這次改動無關」；夜間自動套用沒有人做這個判斷，照 exit code 判的話
 * 一條都不會通過、整條通道天天空轉，而空轉沒有任何訊號。
 *
 * ⚠ 不得改成「允許紅 N 支」這種寫死的數字，也不得在任何地方列出既有紅燈清單——
 * 那種清單會腐爛成「教人把自己改壞的東西當既有問題放過去」（rules/always.md 第 2 條）。
 * 基線每次現場量。
 */
function compareToBaseline(base, after) {
  const unknown = base.failed == null || after.failed == null;
  // suite 整支載不起來時 `Tests:` 那行不含 "failed"，只比 failed 數會被騙成 pass——
  // 補兩道：passed 數掉了也算退步（少掉的測試不會出現在任何一邊的 failed 裡），
  // 以及 suite 級 failed（只在 `Test Suites:` 那行留痕，見 parseJestSuiteFailed 的註解）。
  // ⚠ base.suiteFailed 為 null／undefined＝**不知道基線是多少**，不是 0。當 0 的話，工作區只要
  // 有任何一支 suite 載不起來就恆判退步（複檢關正是這樣整整擋掉每一份修正）。未知時略過這一道，
  // 由 after.failed > base.failed 與 passedDropped 兩道把關——suite 載不起來會讓 passed 數掉下來。
  const suiteBroke = !unknown && base.suiteFailed != null
    && Number(after.suiteFailed || 0) > Number(base.suiteFailed);
  const passedDropped = !unknown && Number(after.passed) < Number(base.passed);
  const regressed = unknown || after.failed > base.failed || passedDropped || suiteBroke;
  const detail = `基線 ${base.failed == null ? '?' : base.failed} failed／${base.passed == null ? '?' : base.passed} passed`
               + ` → 改後 ${after.failed == null ? '?' : after.failed} failed／${after.passed == null ? '?' : after.passed} passed`;
  const head = unknown ? 'unknown' : (regressed ? 'fail' : 'pass');
  return { regressed, line: `${head}（${detail}）` };
}

// 收工作區。Windows 上 `worktree remove` 常在最後刪目錄那一步吃到 Permission denied（有殘留的
// 檔案 handle），實測會留下一個空目錄、git 那邊卻已經移除登記。所以失敗要 prune ＋ 自己刪，
// 否則下次 `worktree add` 到同一路徑會撞牆。
// ⚠ 順序不可調換：一定要先移除 node_modules 的 junction 再刪目錄，否則遞迴刪會沿著連結刪到主 repo。
async function removeWorktree(worktree) {
  if (!worktree) return;
  unlinkNodeModules(worktree);
  try {
    await git(REPO_ROOT, ['worktree', 'remove', '--force', worktree]);
  } catch (err) {
    console.error('[FIX] worktree remove:', err.message);
    await git(REPO_ROOT, ['worktree', 'prune']).catch(() => {});
    try { fs.rmSync(worktree, { recursive: true, force: true }); }
    catch (e) { console.error('[FIX] rm worktree dir:', e.message); }
  }
}

/**
 * 跑一次修正嘗試（fire-and-forget，比照健檢）。
 */
/**
 * 這一組修正裡，使用者當初附的截圖。
 *
 * ⚠ `file_path` 存的是「相對 uploadRoot()」的路徑，一定要 resolve 成絕對路徑；而且要明確授權
 * 唯讀，否則 agent 會因「不得存取工作目錄外路徑」規則跳過不讀。措辭與 sync.js 的
 * taskAttachmentNote 同源。少了這兩件事完全無訊號：agent 打不開圖，只會回報看不懂。
 *
 * 這段原本長在 feedback-triage.js（翻譯關讀圖、翻成文字再往下傳）。那一關拿掉之後若不搬過來，
 * 使用者附的截圖就再也沒有任何 agent 看得到——而截圖往往是一則意見裡講得最清楚的部分。
 */
async function attachmentNote(members) {
  const ids = (members || []).filter(m => m.source === 'feedback').map(m => m.row.id);
  if (!ids.length) return '（無：這一組沒有使用者附圖）';
  const atts = [];
  for (const id of ids) {
    const { rows } = await query(
      'SELECT filename, mimetype, file_path FROM feedback_attachments WHERE feedback_id = $1 ORDER BY id',
      [id]);
    atts.push(...rows);
  }
  if (!atts.length) return '（無：這一組沒有使用者附圖）';
  return '以下檔案可用 Read 工具讀取（圖片可直接檢視）。明確授權：讀取這些附件屬唯讀，'
    + '不受「不得存取工作目錄外路徑」限制；僅可讀取，不得修改。\n'
    + atts.map(a => `- ${a.filename}${a.mimetype ? `（${a.mimetype}）` : ''}：${path.resolve(uploadRoot(), a.file_path)}`).join('\n');
}

// 帶給重改輪的駁回理由上限。再舊的多半是當時平台檢查自己的 bug（例：09-13 的 NUL byte、
// 複檢基線漏 suite 數），早已修掉，塞進來只會讓 agent 去處理一個不存在的問題。
const PREV_REJECTIONS_MAX = 3;

/**
 * 同一個來源之前被駁回的理由 → 給 platform-fix 的一段文字。
 *
 * 沒有這段時，重改輪拿到的提示詞與第一輪逐字相同，再犯同一個錯是結構上必然：2026-09-14
 * 意見 #34 同一晚兩次都因「analysis 降級沒有測試」被駁回；回溯 40 筆修正有 2 個來源同類再犯
 * （健檢提案 147、169 兩度點名，但修法在 DENY 清單內只能人工修，所以一直沒人接）。
 *
 * 兩條斷線都要接：同一晚重改是同一個 finding_id；**隔晚重跑**時意見會被開成新的 finding 列，
 * finding_id 對不上，只能靠 finding_fixes.members 認出同一個來源。
 * members 在 JS 端過濾而不寫 JSONB 運算子：pg-mem 對 `@>` 支援不穩，且這張表一年不過數百列。
 */
async function previousRejections(fixId, findingId, members) {
  const keys = new Set((members || []).map(m => `${m.source}:${m.row && m.row.id}`));
  const { rows } = await query(
    `SELECT id, finding_id, members, reject_reason FROM finding_fixes
      WHERE status='rejected' AND reject_reason IS NOT NULL AND id <> $1
      ORDER BY id DESC LIMIT 200`, [fixId]);
  const hits = rows.filter(r => {
    if (Number(r.finding_id) === Number(findingId)) return true;
    let refs = r.members;
    // 同 nightly-fix.js 的 membersFromRefs：pg-mem 有時把 JSONB 回成原始字串
    if (typeof refs === 'string') { try { refs = JSON.parse(refs); } catch { refs = null; } }
    return Array.isArray(refs) && refs.some(x => keys.has(`${x.source}:${x.id}`));
  }).slice(0, PREV_REJECTIONS_MAX);
  if (!hits.length) return '（無：這條是第一次施工）';
  return hits.map(r => `- 修正 #${r.id}：${String(r.reject_reason).slice(0, 800)}`).join('\n');
}

/**
 * 容器模式下 platform_fix 只掛這一組修正用得到的意見附件目錄（lib/agent-mounts.js 依此組
 * feedback_<id>/）。
 *
 * members 有兩種形狀：runFix 收到的是記憶體物件 `{ source, row: { id, ... } }`（見上面
 * attachmentNote／previousRejections 的 `m.row.id`）；一旦落過 finding_fixes.members 這個
 * JSONB 欄位再讀回來，會被 memberRefs 壓成 `{ source, id }`（見 nightly-fix.js）。兩種都要吃。
 */
function feedbackIdsOf(members) {
  const ids = new Set();
  for (const m of members || []) {
    if (!m || m.source !== 'feedback') continue;
    const rawId = (m.row && m.row.id != null) ? m.row.id : m.id;
    if (/^[1-9]\d*$/.test(String(rawId))) ids.add(Number(rawId));
  }
  return [...ids];
}

async function runFix(fixId, { findingId, startedBy = null, members = null } = {}) {
  let worktree = null;
  try {
    const { rows: [f] } = await query(
      `SELECT id, agent_label, diagnosis, rationale, layer, evidence, target_metric, metric_baseline
         FROM health_check_findings WHERE id=$1`, [findingId]);
    if (!f) return setStatus(fixId, 'failed', { reject_reason: '提案不存在' });

    const branch = `fix/finding-${findingId}-${fixId}`;
    worktree = path.join(WORKTREE_ROOT, `fix-${fixId}`);
    fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
    // 從 HEAD 長出獨立分支：主 checkout 常有別股平行工作的未提交變更，絕不能在那上面動手。
    await git(REPO_ROOT, ['worktree', 'add', '-B', branch, worktree, 'HEAD']);
    await setStatus(fixId, 'running', { branch, worktree });
    linkNodeModules(worktree);
    // 改碼之前先量基線。這一趟多花約 60 秒（2026-09-03 實測全跑 60s），換到的是
    // 「新紅燈」與「既有紅燈」分得開——沒有它，自動套用那條路只能全有或全無。
    const baseline = await measureTests(worktree);
    unlinkNodeModules(worktree);
    // 基線落 DB：複檢那一關（fix-verify）改完碼要用同一個基線再比一次退步，而它拿不到這個
    // 區域變數。量不到（測試沒跑起來）時寫 null——compareToBaseline 看到 null 會判 unknown，
    // 而 unknown 一律當退步，方向是安全的。
    await query(
      'UPDATE finding_fixes SET baseline_failed=$2, baseline_passed=$3, baseline_suite_failed=$4 WHERE id=$1',
      [fixId, baseline.failed, baseline.passed, baseline.suiteFailed]);

    const agent = loadAgent('platform-fix');
    const prompt = agent.render({
      title: f.agent_label || '(無標題)',
      layer: f.layer || '未分類',
      detail: f.diagnosis || '',
      evidence: f.evidence || '（無）',
      action: f.rationale || '（未提供）',
      target_metric: f.target_metric || '（未填）',
      metric_baseline: f.metric_baseline || '—',
      attachments: await attachmentNote(members),
      previous_rejections: await previousRejections(fixId, findingId, members)
    });

    let text = '';
    try {
      const r = await runClaude(prompt, {
        model: agent.model, agentType: 'platform_fix', cwd: worktree, timeoutMs: FIX_TIMEOUT_MS,
        feedbackIds: feedbackIdsOf(members),
      });
      text = r.raw ?? r.text;
      await logTokenUsage({ taskId: null, projectId: null }, startedBy, 'platform_fix', r.usage, r.durationMs);
    } catch (err) {
      await logFailedUsage({ taskId: null, projectId: null }, startedBy, 'platform_fix', err);
      await removeWorktree(worktree);
      return setStatus(fixId, 'failed', { reject_reason: `執行失敗：${err.message}`, worktree: null });
    }

    const { inner: notesBlock, cleaned } = extractTaggedBlock(text, 'notes');
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {}, userId: startedBy });
    const notes = (notesBlock || '').trim() || (parsed && parsed.notes) || '';
    const tests = String((parsed && parsed.tests) || '').trim().toLowerCase();
    // 「這次改動要開哪一頁才看得到」——由改碼的人回報，存在修正列上（見 db.js 的 verify_route）。
    // ⚠ 一律當成不可信的外部輸入過濾：只收 `#/` 開頭的平台 hash 路由。放行任意字串的話，
    // 它會直接被送進 captureBeforeAfter 組成瀏覽器要開的網址（見 ui-preview.js）。
    const route = String((parsed && parsed.verify_route) || '').trim();
    const verifyRoute = /^#\/[\w\-/?=&.#]*$/.test(route) ? route : null;

    // 先拆掉 node_modules 的連結再看變更：`.gitignore` 的 `node_modules/` 帶尾斜線只匹配目錄，
    // 而這裡掛的是 symlink（git 視為檔案）＝不被忽略，會以 `?? app/node_modules` 現身而被判超出
    // 可修改範圍，整份修正無條件作廢。測試此時已跑完，相依不再需要。
    unlinkNodeModules(worktree);
    const { stdout: porcelain } = await git(worktree, ['status', '--porcelain', '-uall']);
    const { files, violations } = classifyChanges(porcelain);

    // 超出範圍：整份作廢。留著 notes 讓人看得到它想幹嘛，但工作區收掉，避免半套改動被誤採用。
    // ⚠ 順序不可調換：先判 violations 再判「什麼都沒改」——DENY／越界的檔不會進 files，
    // 若只動了那些檔，files 會是空陣列，但那是「越界」不是「合法的沒改動」。
    if (violations.length) {
      await removeWorktree(worktree);
      return setStatus(fixId, 'rejected', {
        notes, test_result: tests || 'skip', worktree: null,
        reject_reason: `動到不該動的檔案：\n${violations.join('\n')}`
      });
    }
    // 什麼都沒改是合法結果——提示詞明說「認為不該做就不要硬做」。工作區沒有價值，直接收掉。
    if (!files.length) {
      await removeWorktree(worktree);
      return setStatus(fixId, 'no_change', { notes, test_result: tests || 'skip', worktree: null });
    }

    // 確定這份修正值得看了，才由平台自己複驗測試——沒改東西或超出範圍的那兩條路上，工作區都
    // 要收掉，跑一次全套是白花四分鐘。相依剛才拆掉了，跑之前先接回來，跑完立刻再拆（下面要 add）。
    linkNodeModules(worktree);
    const measured = await measureTests(worktree);
    unlinkNodeModules(worktree);
    const cmp = compareToBaseline(baseline, measured);
    // 自報跟實測對不上，代表這份修正的其他自述也不能信——這句話要跟結果黏在一起
    const testResult = (tests && tests !== (cmp.regressed ? 'fail' : 'pass'))
      ? `${cmp.line} ⚠ agent 自報 ${tests}` : cmp.line;

    // 全部收進索引再取 diff：未追蹤的新檔（新增的測試、新模組）不進索引就不會出現在 diff 裡，
    // 人會以為那些檔案不存在。commit 也用同一批。
    await git(worktree, ['add', '-A']);
    const { stdout: diff } = await git(worktree, ['diff', '--cached']);
    // 1-C1：退步不能只停在 test_result 那行字，要真的擋下「無條件進 ready」——
    // 規格 §150 明寫「ready 且測試全綠？」為否時要「留給人看，不自動套」。這裡的 rejected
    // 是既有狀態值（不新增狀態），nightly-fix.js 的 `status !== 'ready'` 守衛天然會攔住它；
    // diff 照樣寫進去，人工複核仍看得到改了什麼、理由是什麼。
    if (cmp.regressed) {
      // diff 已經存進 DB 了，工作區沒有留的價值；不收的話每次退步都永久多一份完整 checkout。
      await removeWorktree(worktree);
      await setStatus(fixId, 'rejected', {
        notes, test_result: testResult, diff, worktree: null,
        verify_route: verifyRoute, reject_reason: `測試退步：${testResult}`
      });
    } else {
      await setStatus(fixId, 'ready', { notes, test_result: testResult, diff, verify_route: verifyRoute });
    }
  } catch (err) {
    console.error('[FIX]', err.message);
    await removeWorktree(worktree).catch(() => {});
    await setStatus(fixId, 'failed', { reject_reason: err.message, worktree: null }).catch(() => {});
  }
}

// 採用＝在該分支上提交。刻意**不**併回 master：主 checkout 常有別股平行工作，替他們決定要不要
// 合併不是這支功能的職責。提交完工作區就可以收掉，分支留著（推上去或人工合併都行）。
async function adoptFix(fixId, userId) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  if (fix.status !== 'ready') throw new Error(`此狀態不能採用：${fix.status}`);
  const { rows: [f] } = await query('SELECT agent_label FROM health_check_findings WHERE id=$1', [fix.finding_id]);
  const gitEnv = await buildGitEnv(userId).catch(() => ({}));
  const msg = `[Health]: ${(f && f.agent_label) || '健檢提案'}\n\n依系統健檢提案 #${fix.finding_id} 修正。`;
  await git(fix.worktree, ['commit', '-m', msg], { env: { ...process.env, ...gitEnv } });
  const { stdout: sha } = await git(fix.worktree, ['rev-parse', 'HEAD']);
  await removeWorktree(fix.worktree);
  await setStatus(fixId, 'adopted', { commit_sha: sha.trim(), worktree: null });
  return { branch: fix.branch, commit: sha.trim() };
}

// 推上 GitHub 是**另外一顆按鈕**：採用（進本機分支）與公開（進 origin）是兩個不同的決定。
// 推的是分支不是 master——要不要併進 master 由人在 GitHub 上決定。
async function pushFix(fixId, userId) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  if (fix.status !== 'adopted') throw new Error(`此狀態不能推送：${fix.status}`);
  const gitEnv = await buildGitEnv(userId);
  await git(REPO_ROOT, ['push', 'origin', fix.branch], { env: { ...process.env, ...gitEnv } });
  await setStatus(fixId, 'pushed');
  return { branch: fix.branch };
}

async function discardFix(fixId) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  await removeWorktree(fix.worktree);
  if (fix.branch) await git(REPO_ROOT, ['branch', '-D', fix.branch]).catch(() => {});
  await setStatus(fixId, 'failed', { reject_reason: '已由人工捨棄', worktree: null });
}

/**
 * `docker inspect --format '{{.Name}}\t{{.Config.Hostname}}'` 的輸出 → 本機所在容器的名字。
 * 平台跑在容器內，而容器名沒有任何管道傳進來（env 只有 hostname，且 hostname ≠ 容器名）。
 * 唯一可靠的對應是反查：哪個容器的 Config.Hostname 等於本機 hostname。
 * 命中不唯一時寧可失敗——重啟錯的容器會停掉別人的服務。
 */
function pickSelfContainer(inspectStdout, hostname) {
  const hits = String(inspectStdout || '').split('\n')
    .map(l => l.split('\t'))
    .filter(([, h]) => (h || '').trim() === hostname)
    .map(([n]) => n.trim().replace(/^\//, ''));
  if (hits.length !== 1) {
    throw new Error(`無法唯一辨識平台容器（hostname=${hostname}，命中 ${hits.length} 個）；請設 PLATFORM_CONTAINER`);
  }
  return hits[0];
}

async function selfContainerName() {
  if (process.env.PLATFORM_CONTAINER) return process.env.PLATFORM_CONTAINER;
  const { stdout: names } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}']);
  const list = names.split('\n').map(s => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('docker 沒有回報任何容器（socket 不可用？）');
  const { stdout } = await execFileAsync(
    'docker', ['inspect', '--format', '{{.Name}}\t{{.Config.Hostname}}', ...list], { maxBuffer: 8 * 1024 * 1024 });
  return pickSelfContainer(stdout, os.hostname());
}

/**
 * 拆 `git status --porcelain` 的兩欄狀態碼：col 0＝index（已暫存）、col 1＝工作區。
 * 取 col 為指定欄且非空白的路徑；改名列（`R  old -> new`）取箭頭後的新路徑。
 */
function parseStatus(porcelain, col) {
  return String(porcelain || '').split('\n')
    .filter(l => l.length > 3 && l[col] !== ' ' && l[col] !== '?')
    .map(l => l.slice(3).trim())
    .map(f => (f.includes(' -> ') ? f.split(' -> ').pop() : f))
    .map(f => f.replace(/^"|"$/g, ''));
}

/**
 * 暫存區的「殘影」同步回 HEAD -> 回傳真的有人暫存的那些檔（空陣列＝全是殘影、已清掉）。
 *
 * 殘影＝index 跟 HEAD 不同，但工作區內容跟 HEAD 一模一樣。共用 checkout 上用私有 GIT_INDEX_FILE
 * 提交（為了不夾帶別人暫存的檔）而漏了最後同步共用 index 那一步，就會留下這種東西：HEAD 已經往前走，
 * index 還停在提交前那棵樹，git status 看起來像有人 add 了一排檔。2026-09-11 實際卡住兩條已過審的修正。
 * 判準只看內容：HEAD 裡的 blob 與工作區檔案 hash-object 的結果相同（兩邊都沒有這個檔也算相同）。
 *
 * ⚠ 只要有一個是真的就**整個不動**：不往下合併就不該有副作用，暫存區是別人的現場，原樣留給人看。
 * ⚠ reset 一定要限定路徑：光禿禿的 reset 會連別人暫存的東西一起抹掉（git 不留底，救不回來）。
 */
async function resyncGhostStaged(repoRoot, files) {
  const blob = args => git(repoRoot, args).then(r => r.stdout.trim(), () => null);
  const real = [];
  for (const f of files) {
    const head = await blob(['rev-parse', '-q', '--verify', `HEAD:${f}`]);
    const work = await blob(['hash-object', '--', f]);
    if (head !== work) real.push(f);
  }
  if (files.length && !real.length) {
    await git(repoRoot, ['reset', '-q', '--', ...files]);
    console.log('[FIX] 暫存區殘影（內容已等於 HEAD）已同步回 HEAD：%s', files.join(' '));
  }
  return real;
}

/**
 * 一鍵套用：合併進主分支 → 推 origin。**到這裡為止，不重啟。**
 *
 * 更版機制（規格 §4.3 ＋ 09-15 R6）：合併維持自動，重啟改成等平台管理員選的維護時段。合併只動
 * git，客戶無感；重啟會當場砍掉在飛的 agent、讓測試區 Odoo 的 cron 執行緒永久死掉，有付費客戶
 * 之後那是事故不是維護。重啟那半段（容器名查詢、在飛任務檢查、標記提案、docker restart）整段
 * 搬到 `pipeline/release.js`——連同「先查得到容器名才動手」那道前置檢查：不重啟的合併不需要它，
 * 留著只會讓查不到容器時連碼都併不進去。
 */
async function applyFix(fixId, userId) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  if (!['adopted', 'pushed', 'merged'].includes(fix.status)) {
    throw new Error(`此狀態不能套用：${fix.status}`);
  }

  // status='merged'＝上一次按下時碼已經進 master、只差重啟（被在飛任務擋掉）。這裡不重複合併。
  if (fix.status !== 'merged') {
    const { stdout: br } = await git(REPO_ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (br.trim() !== MAIN_BRANCH) {
      throw new Error(`主 clone 目前在 ${br.trim()} 分支（預期 ${MAIN_BRANCH}），不代為切換`);
    }
    // 此 repo 常態是多股平行工作。**已暫存**（git add 過）的東西會被一起包進 merge commit，
    // 這種一定要擋；只改在工作區、還沒 add 的不會進 commit，擋它沒有道理——2026-09-08 就因為
    // 一個不相干的檔改了一行沒提交，當晚五組修正一組都沒併進去。
    // 暫存的也不一定是真的有人在改：內容其實已等於 HEAD 的殘影先清掉（見 resyncGhostStaged）。
    let { stdout: dirty } = await git(REPO_ROOT, ['status', '--porcelain', '-uno']);
    const stagedAll = parseStatus(dirty, 0);
    const staged = stagedAll.length ? await resyncGhostStaged(REPO_ROOT, stagedAll) : [];
    // 清過就重讀：清之前那幾個檔的工作區欄是 'M'，拿舊結果去比下面的「重疊」會把殘影誤擋下來
    if (stagedAll.length && !staged.length) {
      ({ stdout: dirty } = await git(REPO_ROOT, ['status', '--porcelain', '-uno']));
    }
    if (staged.length) {
      throw new Error(`主 clone 有已暫存（git add）的變更，會被一起併進來，先處理再套用：\n${staged.join('\n')}`);
    }
    const gitEnv = await buildGitEnv(userId);
    const env = { ...process.env, ...gitEnv };
    // 先跟遠端對齊再合併：此 repo 常態多股平行工作，遠端隨時可能已被別人推進（實測 2026-08-21：
    // 按下前 13 分鐘有人推了一顆）。少了這步就會停在「本地多了合併節點、push 被拒」——碼進了主
    // 分支卻沒上遠端、狀態也沒記，而再按一次 merge 只會回 Already up to date、push 依然被拒。
    await git(REPO_ROOT, ['fetch', 'origin', MAIN_BRANCH], { env });

    // 「commit 了但忘記 push」與「真的分岔」不是同一件事，舊版把兩者都當分岔擋掉，於是忘記推
    // 一次就等於當晚全部白跑。遠端沒有本地缺的東西時，把本地那幾顆推上去就對齊了，不必人裁決。
    const { stdout: counts } = await git(
      REPO_ROOT, ['rev-list', '--left-right', '--count', `origin/${MAIN_BRANCH}...${MAIN_BRANCH}`], { env });
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);

    if (ahead > 0 && behind > 0) {
      // 雙向都有＝要留誰只有人知道，不代為裁決。
      throw new Error(`主 clone 與 origin/${MAIN_BRANCH} 已分岔（本地多 ${ahead} 顆、遠端多 ${behind} 顆），不代為裁決`);
    }

    // 工作區的未暫存變更只有「跟這次要動到的檔重疊」才有問題（git 自己也會拒絕，但訊息看不出
    // 所以然）。要動到的檔＝追上 origin 會帶進來的 ＋ 這條分支會帶進來的，兩段都要算。
    const worktree = parseStatus(dirty, 1);
    if (worktree.length) {
      const incoming = new Set();
      for (const ref of [`origin/${MAIN_BRANCH}`, fix.branch]) {
        const { stdout } = await git(REPO_ROOT, ['diff', '--name-only', `HEAD...${ref}`], { env });
        stdout.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => incoming.add(f));
      }
      const clash = worktree.filter(f => incoming.has(f));
      if (clash.length) {
        throw new Error(`主 clone 有未提交的變更，剛好也是這次要合併的檔，先處理再套用：\n${clash.join('\n')}`);
      }
    }

    if (ahead > 0) {
      await git(REPO_ROOT, ['push', 'origin', MAIN_BRANCH], { env });
    } else {
      try {
        await git(REPO_ROOT, ['merge', '--ff-only', `origin/${MAIN_BRANCH}`], { env });
      } catch (err) {
        throw new Error(`追上 origin/${MAIN_BRANCH} 失敗，不繼續合併：${err.message}`);
      }
    }
    const { stdout: preSha } = await git(REPO_ROOT, ['rev-parse', 'HEAD']);
    try {
      // 訊息帶提案編號：只寫分支名的話，分支一刪就再也回推不出這個 merge 是為了什麼
      await git(REPO_ROOT, ['merge', '--no-ff', fix.branch, '-m',
        `Merge ${fix.branch}\n\n依系統健檢提案 #${fix.finding_id} 修正。`], { env });
    } catch (err) {
      // 衝突留在工作區會讓主 clone 卡在 MERGING、之後每個 git 動作都失敗
      await git(REPO_ROOT, ['merge', '--abort']).catch(() => {});
      throw new Error(`合併失敗（已回復）：${err.message}`);
    }
    try {
      await git(REPO_ROOT, ['push', 'origin', MAIN_BRANCH], { env });
    } catch (err) {
      // 推不上去就把合併節點收回來。留著等於主分支上有一顆只有本機看得到的 commit，下次按時
      // merge 會回 Already up to date、push 照樣被拒，人得自己進 shell 才解得開。
      await git(REPO_ROOT, ['reset', '--hard', preSha.trim()], { env }).catch(() => {});
      throw new Error(`推送失敗（本地合併已回復）：${err.message}`);
    }
    await setStatus(fixId, 'merged');
  }
  // 更版機制（規格 §4.3 ＋ 09-15 R6）：合併維持自動，重啟改成等維護時段。
  // 這裡刻意不再碰 health_check_findings 的 status——「碼進了 master」與「新碼真的在跑」
  // 是兩件事，提早標 done 會讓更版頁再也看不到這一筆。標記改由 release.js 在真的重啟後做。
  return { branch: fix.branch, merged: true, restarted: false, awaitingRelease: true };
}

module.exports = {
  runFix, feedbackIdsOf, adoptFix, pushFix, discardFix, applyFix, classifyChanges, pickSelfContainer, resyncGhostStaged,
  selfContainerName, compareToBaseline, parseJestCounts, measureTests,
  // 複檢那一關（fix-verify.js）在同一個工作區裡改碼、重跑測試、重取 diff，要用同一套
  // 相依連結與 git 呼叫。不 export 的話它只能自己複製一份，兩份會各自漂移——而其中一份
  // 漏掉「先 unlink 再刪」這種順序性細節時，症狀是遞迴刪沿著 junction 刪到主 repo。
  linkNodeModules, unlinkNodeModules, git,
  // nightly-fix 的「審核未通過」也要收工作區。不 export 的話那條路只能留著不收，而每次被
  // 駁回就多一份完整 checkout、畫面上零徵狀（2026-09-09 清出一個 09-08 留下的）。
  removeWorktree,
};
