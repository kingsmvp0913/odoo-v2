const { query } = require('../db');

const REQUIRED_FIELDS = ['case_id', 'module', 'odoo_version', 'execution_mode', 'summary'];

// 把「分析結果 → 下一個閘門」寫成一筆時間軸訊息（role='ai'）：讓使用者在對話時間軸看到分析里程碑
// 與「需要回答的問題／待審的規格」，而非只在動作面板一閃而過（答完換面板就消失＝時間軸看不到問過什麼）。
// analysis-project（task-agent）路徑呼叫；集中「YAML → 閘門訊息」邏輯避免雙寫漂移。
async function logAnalysisGate(taskId, parsed, nextStatus) {
  const head = `模組：${parsed?.module || ''}｜重點：${parsed?.summary || ''}`;
  let content;
  if (nextStatus === 'confirm_pending') {
    // 題目有兩代：新版是物件（取 .text）、舊版是純字串（取自身）——取不到文字的項目略過，不印空白編號。
    const qs = (parsed?.clarification_channel?.questions || [])
      .map(q => (typeof q === 'string' ? q : q?.text))
      .filter(t => typeof t === 'string' && t.trim())
      .map((t, i) => `${i + 1}. ${t.trim()}`).join('\n');
    const intro = typeof parsed?.clarification_channel?.intro === 'string' ? parsed.clarification_channel.intro.trim() : '';
    content = `[需要你回答]\n${head}${intro ? `\n\n${intro}` : ''}${qs ? `\n\n${qs}` : ''}`;
  } else if (nextStatus === 'spec_review') {
    content = `[等待你審核規格]\n${head}`;
  } else {
    content = `分析完成，直接開工\n${head}`;
  }
  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, content]);
}

function determineNextStatus(parsed) {
  const hasQuestions = Array.isArray(parsed?.clarification_channel?.questions) &&
    parsed.clarification_channel.questions.length > 0;
  if (parsed?.low_confidence === true || hasQuestions) return 'confirm_pending';
  // MODE_A＝純新增且不改既有行為 → 直接開工；其餘一律進規格審核閘門 spec_review，讓使用者看過規格再開工。
  // （問題/low_confidence 分支已在上方優先攔截：MODE_B 有待答問題時先走 confirm_pending 答題。）
  //
  // fallback 指向最嚴格：舊版寫成「不等於 'MODE_B' 就 branch_pending」，值只要飄成 `mode_b`、
  // `MODE_B（先確認）` 這類就靜默跳過人工規格閘門——而 MODE_B 正是「會動到既有行為／金額／稅／
  // 庫存」的那一類，最不該被跳過，且跳過完全無聲（無警告、無測試會紅）。改成白名單式：只有明確
  // 認得出 MODE_A 才放行開工。比對前正規化——模型輸出的大小寫與尾隨空白本來就不穩定。
  const mode = String(parsed?.execution_mode ?? '').trim().toUpperCase();
  return mode === 'MODE_A' ? 'branch_pending' : 'spec_review';
}

// determineNextStatus / REQUIRED_FIELDS / logAnalysisGate 供 task-agent（analysis-project 路徑）共用：
// 單一份「YAML → 下一狀態」推導、必要欄位驗證與閘門訊息，避免雙契約漂移。
module.exports = { determineNextStatus, REQUIRED_FIELDS, logAnalysisGate };
