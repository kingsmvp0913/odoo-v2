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

function needsScreenshot(diff, finding) {
  const route = finding && finding.verify_route;
  if (!route || !String(route).trim()) return false;
  return touchedFiles(diff).some(f => f.startsWith('app/public/'));
}

/**
 * reviewFix(fixId, finding) -> { verdict: 'approve'|'reject', reason }
 *
 * finding：triage／merge 結果那份結構（至少含 title/detail/action/verify_route）。
 */
async function reviewFix(fixId, finding = {}) {
  const { rows: [fix] } = await query('SELECT diff, test_result, worktree FROM finding_fixes WHERE id=$1', [fixId]);
  if (!fix) return { verdict: 'reject', reason: '修正紀錄不存在' };

  const diff = fix.diff || '';
  const testResult = fix.test_result || '（無測試結果）';

  let screenshots = null;
  let screenshotNote = '無';
  if (needsScreenshot(diff, finding)) {
    screenshots = fix.worktree ? await captureBeforeAfter(fix.worktree, finding.verify_route) : null;
    if (!screenshots) {
      screenshotNote = '無（截圖失敗：起不了預覽伺服器或 playwright 無法執行，本輪未看到畫面）';
    }
  }

  const agent = loadAgent('fix-review');
  const prompt = agent.render({
    title: (finding && finding.title) || '(無標題)',
    detail: (finding && finding.detail) || '',
    action: (finding && finding.action) || '（未提供）',
    diff,
    test_result: testResult,
    before_screenshot: screenshots ? screenshots.before : screenshotNote,
    after_screenshot: screenshots ? screenshots.after : screenshotNote,
  });

  let text = '';
  try {
    const r = await runClaude(prompt, { model: agent.model, agentType: 'fix_review' });
    text = r.text;
    await logTokenUsage({ taskId: null, projectId: null }, null, 'fix_review', r.usage, r.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, null, 'fix_review', err);
    return { verdict: 'reject', reason: `審核執行失敗：${err.message}` };
  }

  const { cleaned } = extractTaggedBlock(text, 'notes');
  const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, schemaHint: SCHEMA, ref: {} });

  // agent 回不出 JSON → 不確定一律 reject（半夜沒人看，代價不對稱）
  if (!parsed || (parsed.verdict !== 'approve' && parsed.verdict !== 'reject')) {
    return { verdict: 'reject', reason: '審核結果無法解析（不確定一律 reject）' };
  }

  return { verdict: parsed.verdict, reason: parsed.reason || '' };
}

module.exports = { reviewFix, touchedFiles, needsScreenshot };
