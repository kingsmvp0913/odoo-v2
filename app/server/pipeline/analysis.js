const { query } = require('../db');

const REQUIRED_FIELDS = ['case_id', 'module', 'odoo_version', 'execution_mode', 'summary'];

// 把「分析結果 → 下一個閘門」寫成一筆時間軸訊息（role='ai'）：讓使用者在對話時間軸看到分析里程碑
// 與「需要回答的問題／待審的規格」，而非只在動作面板一閃而過（答完換面板就消失＝時間軸看不到問過什麼）。
// analysis-project（task-agent）路徑呼叫；集中「YAML → 閘門訊息」邏輯避免雙寫漂移。
async function logAnalysisGate(taskId, parsed, nextStatus) {
  const head = `模組：${parsed?.module || ''}｜重點：${parsed?.summary || ''}`;
  let content;
  if (nextStatus === 'confirm_pending') {
    const qs = (parsed?.clarification_channel?.questions || [])
      .map((q, i) => `${i + 1}. ${String(q).trim()}`).filter(Boolean).join('\n');
    content = `[需要你回答]\n${head}${qs ? `\n\n${qs}` : ''}`;
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
  // MODE_B＝先確認再實作 → 進規格審核閘門 spec_review，讓使用者看過完整規格再決定開工。
  // （問題/low_confidence 分支已在上方優先攔截：MODE_B 有待答問題時先走 confirm_pending 答題。）
  if (parsed?.execution_mode === 'MODE_B') return 'spec_review';
  return 'branch_pending';
}

// determineNextStatus / REQUIRED_FIELDS / logAnalysisGate 供 task-agent（analysis-project 路徑）共用：
// 單一份「YAML → 下一狀態」推導、必要欄位驗證與閘門訊息，避免雙契約漂移。
module.exports = { determineNextStatus, REQUIRED_FIELDS, logAnalysisGate };
