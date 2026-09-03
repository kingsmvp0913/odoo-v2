const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../db');
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
const RESTART_DELAY_MS = parseInt(process.env.PLATFORM_RESTART_DELAY_MS || '1500', 10);
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
  { re: /^\.claude\/agents\/feedback-triage\.md$/,   why: '入口的翻譯與 understandable 門檻' },
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
    return { ok: true, summary, ...parseJestCounts(summary) };
  } catch (err) {
    // 有紅燈時 jest exit≠0 也走這裡，跟「測試根本沒跑起來」要分得開——靠解不解析得到總結行判定
    const summary = jestSummary(err.stdout, err.stderr);
    return summary
      ? { ok: false, summary, ...parseJestCounts(summary) }
      : { ok: false, summary: '', failed: null, passed: null, error: String(err.message || '').split('\n')[0] };
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
  const regressed = unknown || after.failed > base.failed;
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
async function runFix(fixId, { findingId, startedBy = null } = {}) {
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

    const agent = loadAgent('platform-fix');
    const prompt = agent.render({
      title: f.agent_label || '(無標題)',
      layer: f.layer || '未分類',
      detail: f.diagnosis || '',
      evidence: f.evidence || '（無）',
      action: f.rationale || '（未提供）',
      target_metric: f.target_metric || '（未填）',
      metric_baseline: f.metric_baseline || '—'
    });

    let text = '';
    try {
      const r = await runClaude(prompt, {
        model: agent.model, agentType: 'platform_fix', cwd: worktree, timeoutMs: FIX_TIMEOUT_MS
      });
      text = r.text;
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
    await setStatus(fixId, 'ready', { notes, test_result: testResult, diff });
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
 * 一鍵套用：合併進主分支 → 推 origin → 重啟平台。
 *
 * 重啟走 `docker restart`（交給 host 的 daemon）而不是自殺讓 policy 撿回來：容器內 kill node 會
 * 連 entrypoint 帶 postgres 一起收掉，能不能回來得看容器外的 restart policy——那是這裡看不見的設定。
 *
 * 先查得到容器名才動手合併：名字查不到就重啟不了，此時合併完等於把碼推上去卻停在「跑著舊碼」，
 * 而人剛按的按鈕上寫著「會重啟」。
 */
async function applyFix(fixId, userId, inflight = []) {
  const { rows: [fix] } = await query('SELECT * FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) throw new Error('修正紀錄不存在');
  if (!['adopted', 'pushed', 'merged'].includes(fix.status)) {
    throw new Error(`此狀態不能套用：${fix.status}`);
  }
  const container = await selfContainerName();

  // status='merged'＝上一次按下時碼已經進 master、只差重啟（被在飛任務擋掉）。這裡不重複合併。
  if (fix.status !== 'merged') {
    const { stdout: br } = await git(REPO_ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (br.trim() !== MAIN_BRANCH) {
      throw new Error(`主 clone 目前在 ${br.trim()} 分支（預期 ${MAIN_BRANCH}），不代為切換`);
    }
    // 此 repo 常態是多股平行工作：在別人未提交的變更上合併，會把他們的東西一起帶進 commit
    const { stdout: dirty } = await git(REPO_ROOT, ['status', '--porcelain', '-uno']);
    if (dirty.trim()) {
      throw new Error(`主 clone 有未提交的變更，先處理再套用：\n${dirty.trim()}`);
    }
    const gitEnv = await buildGitEnv(userId);
    const env = { ...process.env, ...gitEnv };
    // 先跟遠端對齊再合併：此 repo 常態多股平行工作，遠端隨時可能已被別人推進（實測 2026-08-21：
    // 按下前 13 分鐘有人推了一顆）。少了這步就會停在「本地多了合併節點、push 被拒」——碼進了主
    // 分支卻沒上遠端、狀態也沒記，而再按一次 merge 只會回 Already up to date、push 依然被拒。
    await git(REPO_ROOT, ['fetch', 'origin', MAIN_BRANCH], { env });
    try {
      await git(REPO_ROOT, ['merge', '--ff-only', `origin/${MAIN_BRANCH}`], { env });
    } catch (err) {
      // 分岔＝本地有還沒推上去的東西。那是誰放的、要不要留只有人知道，不代為裁決。
      throw new Error(`主 clone 與 origin/${MAIN_BRANCH} 已分岔，不代為裁決：${err.message}`);
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

  // 重啟會當場砍掉在飛的 agent，任務留在 *_running 的孤兒狀態。碼已經在 master 上，晚點再按即可。
  if (inflight.length) {
    return { branch: fix.branch, merged: true, restarted: false, inflight };
  }
  // 提案標 done 只在真的要重啟這條路上做——「合併了但還在等在飛任務」不算處置完成：畫面靠這個
  // 狀態決定還要不要給按鈕，提早標會把「還差重啟」那顆按鈕一起藏掉，人就再也按不到了。
  // 下一輪健檢的 previousProposals() 讀的也是這裡，applied_at 則是回頭驗成效的起算點。
  await query(
    `UPDATE health_check_findings
        SET status='done', decided_by=$2, decided_at=NOW(), applied_at=COALESCE(applied_at, NOW())
      WHERE id=$1 AND status<>'done'`, [fix.finding_id, userId]);
  // 延遲讓 HTTP 回應先送出去——這道指令會把自己這個行程一起帶走
  setTimeout(() => {
    execFile('docker', ['restart', container], err => {
      if (err) console.error('[FIX] restart:', err.message);
    });
  }, RESTART_DELAY_MS);
  return { branch: fix.branch, merged: true, restarted: true, container };
}

module.exports = {
  runFix, adoptFix, pushFix, discardFix, applyFix, classifyChanges, pickSelfContainer,
  compareToBaseline, parseJestCounts, measureTests,
};
