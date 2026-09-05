const { query } = require('../db');
const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const {
  classifyChanges, compareToBaseline, measureTests,
  linkNodeModules, unlinkNodeModules, git,
} = require('./finding-fix');

/**
 * fix-verify.js — 合併進 master 之前的最後一道複檢。
 *
 * 為什麼要有這一關（而不是把判準加進 fix-review 就好）：fix-review 只拿得到 diff 的文字，
 * 看不到被改檔案的其餘部分、看不到呼叫端、不能執行任何東西。它抓得到「這份 diff 自己有沒有
 * 毛病」，抓不到「這份 diff 放進整個 repo 之後對不對」——呼叫端沒跟著改、同一個 bug 的第二處
 * 沒改到、前端檔改完根本載不進來（2026-09-05 實際發生：template literal 被註解裡的反引號切斷，
 * 整支 View 消失、任務詳細頁整頁打不開，而 diff 與測試都完全正常）。
 *
 * 這一關的 agent 跑在**修正所在的工作區**裡，讀得到全部檔案、跑得動指令，而且發現問題可以
 * 直接外科式修好——退回重跑一輪要多花二十分鐘，換回來的多半還是同一份 diff。
 *
 * ⚠ 三件事一律不採信 agent 自報，全部由平台自己驗（同 finding-fix.js 的既有精神）：
 *   1. 它到底有沒有改東西 → 比對複檢前後的 `git diff --cached`，不看 `changed` 欄位。
 *   2. 它改的東西在不在可修改範圍 → 重跑 classifyChanges。
 *   3. 它改完測試有沒有退步 → 重跑 measureTests，跟**改碼前**的基線比（不是跟改碼後比：
 *      基線才是「這條提案動手之前」的狀態，兩段改動要一起對它負責）。
 */

const SCHEMA = '{"verdict":"pass｜fail","changed":true,"reason":"一句話"}';

// 跟 platform-fix 同一個上限：這一關同樣要讀碼、grep 呼叫端、動手修，只是範圍小得多。
const VERIFY_TIMEOUT_MS = parseInt(process.env.FIX_VERIFY_TIMEOUT_MS || '1800000', 10);

// 工作區當下的完整改動（已 staged）。複檢前後各取一次，用來判斷 agent 到底有沒有動手——
// 它自報的 `changed` 只是參考：填 false 但實際改了，平台就會合併一份沒重跑過測試的改動。
async function stagedDiff(worktree) {
  await git(worktree, ['add', '-A']);
  const { stdout } = await git(worktree, ['diff', '--cached']);
  return stdout || '';
}

/**
 * verifyFix(fixId, finding) -> { pass, changed, reason, notes, diff, testResult }
 *
 * finding：同 reviewFix 吃的那份結構（title/detail/action，有整列時也吃得下 risk_if_wrong）。
 * 回傳的 diff／testResult 只在 agent 真的改過東西時才有值（呼叫端據此決定要不要寫回 DB）。
 */
async function verifyFix(fixId, finding = {}) {
  const { rows: [fix] } = await query(
    `SELECT diff, test_result, worktree, baseline_failed, baseline_passed
       FROM finding_fixes WHERE id=$1`, [fixId]);
  if (!fix) return { pass: false, changed: false, reason: '修正紀錄不存在', notes: '' };
  // 沒有工作區就複檢不了。這裡不放行——這一關是無人監督下進 master 前的最後一道，
  // 「檢查不了」與「檢查過了」不能是同一個結果（同 fix-review 的「不確定一律 reject」）。
  if (!fix.worktree) return { pass: false, changed: false, reason: '工作區不存在，無法複檢', notes: '' };

  const before = await stagedDiff(fix.worktree).catch(() => null);
  if (before === null) {
    return { pass: false, changed: false, reason: '工作區無法讀取（git 指令失敗），無法複檢', notes: '' };
  }

  const agent = loadAgent('fix-verify');
  const prompt = agent.render({
    title: (finding && finding.title) || '(無標題)',
    detail: (finding && finding.detail) || '',
    action: (finding && finding.action) || '（未提供）',
    risk_if_wrong: (finding && finding.risk_if_wrong) || '（提案沒有宣告失敗模式）',
    diff: fix.diff || '',
    test_result: fix.test_result || '（無測試結果）',
    worktree: fix.worktree,
  });

  let text = '';
  // 相依接回來：agent 要對改到的那支測試跑一次 jest、對前端檔跑 node --check，
  // 沒有 node_modules 兩件事都做不到（新開的 worktree 不帶相依，見 finding-fix.js）。
  linkNodeModules(fix.worktree);
  try {
    const r = await runClaude(prompt, {
      model: agent.model, agentType: 'fix_verify', cwd: fix.worktree, timeoutMs: VERIFY_TIMEOUT_MS,
    });
    text = r.text;
    await logTokenUsage({ taskId: null, projectId: null }, null, 'fix_verify', r.usage, r.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, null, 'fix_verify', err);
    return { pass: false, changed: false, reason: `複檢執行失敗：${err.message}`, notes: '' };
  } finally {
    unlinkNodeModules(fix.worktree);
  }

  const { inner: notesBlock, cleaned } = extractTaggedBlock(text, 'notes');
  const notes = (notesBlock || '').trim();
  const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, schemaHint: SCHEMA, ref: {} });
  // 大小寫與尾隨空白不穩定（rules/pipeline.md#72）
  const verdict = String((parsed && parsed.verdict) || '').trim().toLowerCase();

  // 解析不出來＝不知道它判了什麼。半夜沒人看，不確定一律擋下。
  if (!parsed || (verdict !== 'pass' && verdict !== 'fail')) {
    return { pass: false, changed: false, reason: '複檢結果無法解析（不確定一律擋下）', notes };
  }
  if (verdict === 'fail') {
    return { pass: false, changed: false, reason: parsed.reason || '複檢判定不可合併', notes };
  }

  // ── 以下三道由平台自己驗，不看 agent 怎麼說 ──
  const after = await stagedDiff(fix.worktree).catch(() => null);
  if (after === null) {
    return { pass: false, changed: false, reason: '複檢後讀不到工作區狀態，無法確認它改了什麼', notes };
  }
  if (after === before) {
    // 沒動手＝這份 diff 原封不動，測試結果仍然有效，不必重跑（省一次四分鐘的全套）。
    return { pass: true, changed: false, reason: parsed.reason || '複檢通過，未改動', notes };
  }

  // 1. 範圍：它改的檔案在不在可修改清單內（含「既有測試只能新增」）
  unlinkNodeModules(fix.worktree);
  const { stdout: porcelain } = await git(fix.worktree, ['status', '--porcelain', '-uall']);
  const { violations } = classifyChanges(porcelain);
  if (violations.length) {
    return { pass: false, changed: true, notes,
      reason: `複檢時動到不該動的檔案：${violations.join('；')}` };
  }

  // 2. 測試：跟**改碼前**的基線比。基線量不到時 compareToBaseline 會判 unknown＝退步，
  //    方向是安全的（寧可擋下要人看，不要放行一份沒驗證過的改動）。
  linkNodeModules(fix.worktree);
  const measured = await measureTests(fix.worktree);
  unlinkNodeModules(fix.worktree);
  const cmp = compareToBaseline(
    { failed: fix.baseline_failed, passed: fix.baseline_passed }, measured);
  if (cmp.regressed) {
    return { pass: false, changed: true, notes, testResult: cmp.line,
      reason: `複檢改動後測試退步：${cmp.line}` };
  }

  // 3. diff 重取：合併進 master 的是複檢後的內容，管理頁給人看的也該是這一份。
  const diff = await stagedDiff(fix.worktree).catch(() => after);
  return { pass: true, changed: true, notes, diff, testResult: cmp.line,
    reason: parsed.reason || '複檢通過（已修正後放行）' };
}

module.exports = { verifyFix };
