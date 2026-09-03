const fs = require('fs');
const os = require('os');
const { query } = require('../db');
const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { captureBeforeAfter } = require('./ui-preview');

/**
 * fix-review.js — 第二道 AI 審核：跑 fix-review agent，判一份 finding_fixes 修正該不該套用。
 *
 * 跟 finding-fix.js／feedback-triage.js 同一套組合（loadAgent → render → runClaude →
 * extractTaggedBlock → parseAgentResult），差別是這裡的輸出只有一個 verdict、不改任何程式碼。
 *
 * ⚠ prompt 不得帶 finding_fixes.notes（platform-fix 自己寫的辯護詞）——已實測的失敗模式是
 * agent 在 <result> 填 pass、notes 卻寫著「9 failed」並自我解釋成環境問題，讀了 notes 的
 * 審查者會直接採信那段解釋。fix-review.md 的 prompt 只收 diff／test_result／截圖，
 * 呼叫端（這支）同樣不得把 notes 塞進任何 render 參數。
 */

const SCHEMA = '{"verdict":"approve｜reject","reason":"一句話"}';

// diff 的 `diff --git a/<path> b/<path>` 行 → 這份修正動到的檔案路徑集合
function touchedFiles(diff) {
  const files = new Set();
  for (const line of String(diff || '').split('\n')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (m) { files.add(m[1]); files.add(m[2]); }
  }
  return [...files];
}

/**
 * 要不要截圖：動到 `app/public/` 且這條提案講得出「要開哪一頁」才截。
 *
 * ⚠ `health_check_findings` **沒有** `verify_route` 欄（只有 `feedback` 有，見 db.js:508）
 * ⇒ **健檢提案來源永遠不截圖**。這是刻意的：健檢提案多半是 prompt／觀測性類的改動，本來就
 * 沒有對應畫面；要截也不知道該開哪一頁。不是漏寫。
 */
function needsScreenshot(diff, finding) {
  const route = finding && finding.verify_route;
  if (!route || !String(route).trim()) return false;
  return touchedFiles(diff).some(f => f.startsWith('app/public/'));
}

/**
 * 這條提案自己宣告的失敗模式（health-auditor 的 `risk_if_wrong`）。
 *
 * 兩條來源都留著：nightly-fix 那股會把整列 finding 傳進來（省一次查詢），但人工／其他呼叫端
 * 只傳得出精簡結構。少了它，health-auditor.md:61 明寫「這是下游 fix-review 審查的基準」那句
 * 就會變成「存了沒人讀」。
 */
async function riskIfWrong(fixId, finding) {
  if (finding && finding.risk_if_wrong) return String(finding.risk_if_wrong);
  const { rows } = await query(
    `SELECT f.risk_if_wrong
       FROM finding_fixes x JOIN health_check_findings f ON f.id = x.finding_id
      WHERE x.id = $1`, [fixId]);
  return (rows[0] && rows[0].risk_if_wrong) || '';
}

/**
 * reviewFix(fixId, finding) -> { verdict: 'approve'|'reject', reason, notes }
 *
 * finding：triage／merge 結果那份結構（至少含 title/detail/action/verify_route；
 * 有整列 health_check_findings 時也吃得下 risk_if_wrong）。
 *
 * `notes` 是 agent 的推理過程——這是無人監督閘門唯一的人類稽核材料，不可丟棄（見下方註解）。
 */
async function reviewFix(fixId, finding = {}) {
  const { rows: [fix] } = await query('SELECT diff, test_result, worktree FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) return { verdict: 'reject', reason: '修正紀錄不存在', notes: '' };

  const diff = fix.diff || '';
  const testResult = fix.test_result || '（無測試結果）';

  let screenshots = null;
  let screenshotNote = '無';
  if (needsScreenshot(diff, finding)) {
    screenshots = fix.worktree ? await captureBeforeAfter(fix.worktree, finding.verify_route) : null;
    if (!screenshots) {
      screenshotNote = '無（截圖失敗：缺中文字型／起不了預覽伺服器／playwright 無法執行，本輪未看到畫面）';
    }
  }

  try {
    const agent = loadAgent('fix-review');
    const prompt = agent.render({
      title: (finding && finding.title) || '(無標題)',
      detail: (finding && finding.detail) || '',
      action: (finding && finding.action) || '（未提供）',
      risk_if_wrong: (await riskIfWrong(fixId, finding)) || '（提案沒有宣告失敗模式）',
      diff,
      test_result: testResult,
      before_screenshot: screenshots ? screenshots.before : screenshotNote,
      after_screenshot: screenshots ? screenshots.after : screenshotNote,
    });

    let text = '';
    try {
      // cwd 指到暫存目錄：這一支是閘門，而 runClaude 帶 --dangerously-skip-permissions。
      // 不指定 cwd 會讓它跑在平台的 live checkout 上，等於給審查者一把可以動被審程式碼的鑰匙。
      const r = await runClaude(prompt, { model: agent.model, agentType: 'fix_review', cwd: os.tmpdir() });
      text = r.text;
      await logTokenUsage({ taskId: null, projectId: null }, null, 'fix_review', r.usage, r.durationMs);
    } catch (err) {
      await logFailedUsage({ taskId: null, projectId: null }, null, 'fix_review', err);
      return { verdict: 'reject', reason: `審核執行失敗：${err.message}`, notes: '' };
    }

    // <notes> 要接出來：fix-review.md 對 agent 說「這段是給人事後複核用的」，而這是無人監督
    // 閘門唯一的人類稽核材料。只留一句 reason 的話，事後想知道「它為什麼這樣判」就再也查不到。
    const { inner: notesBlock, cleaned } = extractTaggedBlock(text, 'notes');
    const notes = (notesBlock || '').trim();
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, schemaHint: SCHEMA, ref: {} });

    // 大小寫與尾隨空白不穩定（rules/pipeline.md#72）：不正規化的話 "Approve" 會變成無辜的 reject。
    const verdict = String((parsed && parsed.verdict) || '').trim().toLowerCase();

    // agent 回不出 JSON → 不確定一律 reject（半夜沒人看，代價不對稱）
    if (!parsed || (verdict !== 'approve' && verdict !== 'reject')) {
      return { verdict: 'reject', reason: '審核結果無法解析（不確定一律 reject）', notes };
    }

    return { verdict, reason: parsed.reason || '', notes };
  } finally {
    // 暫存圖用完就刪。夜間跑幾條疊幾份 PNG，沒有人回收——ui-preview 刻意把 dir 交出來，
    // 就是要在這裡收（成功與失敗兩條路都要收，故放 finally）。
    if (screenshots && screenshots.dir) {
      try { fs.rmSync(screenshots.dir, { recursive: true, force: true }); }
      catch (e) { console.error('[FIX-REVIEW] 清暫存圖失敗：', e.message); }
    }
  }
}

module.exports = { reviewFix, touchedFiles, needsScreenshot };
