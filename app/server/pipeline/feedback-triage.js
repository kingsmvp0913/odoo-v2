const { query } = require('../db');
const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');

/**
 * feedback-triage.js — 跑 feedback-triage／feedback-merge 兩支 agent。
 *
 * 跟 finding-fix.js 同一套組合（loadAgent → render → runClaude → extractTaggedBlock →
 * parseAgentResult），差別是這裡不改程式碼、只產出判讀結果寫回 DB 或回傳給呼叫端。
 *
 * ⚠ triageOne 判不出來（understandable:false）或解析失敗，一律把 feedback.status 退回 'new'
 * 並在 triage_note 寫原因——不可卡在中間狀態，否則那筆意見會消失在畫面看不到、也進不了
 * 下一輪批次的候選清單。
 */

async function triageOne(feedbackId) {
  const { rows: [fb] } = await query('SELECT id, content FROM feedback WHERE id=$1', [feedbackId]);
  if (!fb) return { ok: false, understandable: false };

  const { rows: attRows } = await query(
    'SELECT file_path FROM feedback_attachments WHERE feedback_id=$1', [feedbackId]);
  const attachmentPaths = attRows.map(r => r.file_path).join('\n');

  const agent = loadAgent('feedback-triage');
  const prompt = agent.render({
    content: fb.content || '',
    attachment_paths: attachmentPaths
  });

  let text = '';
  try {
    const r = await runClaude(prompt, { model: agent.model, agentType: 'feedback_triage' });
    text = r.text;
    await logTokenUsage({ taskId: null, projectId: null }, null, 'feedback_triage', r.usage, r.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, null, 'feedback_triage', err);
    await query(
      `UPDATE feedback SET status='new', triage_note=$2 WHERE id=$1`,
      [feedbackId, `執行失敗：${err.message}`]);
    return { ok: false, understandable: false };
  }

  const { cleaned } = extractTaggedBlock(text, 'notes');
  const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {} });

  if (!parsed) {
    await query(
      `UPDATE feedback SET status='new', triage_note=$2 WHERE id=$1`,
      [feedbackId, '無法解析 triage 結果']);
    return { ok: false, understandable: false };
  }

  if (!parsed.understandable) {
    await query(
      `UPDATE feedback SET status='new', triage_note=$2 WHERE id=$1`,
      [feedbackId, parsed.note || '看不出具體修改需求']);
    return { ok: true, understandable: false };
  }

  await query(
    `UPDATE feedback
        SET triage_title=$2, triage_detail=$3, triage_layer=$4, triage_action=$5,
            triage_note=$6, verify_route=$7
      WHERE id=$1`,
    [feedbackId, parsed.title || '', parsed.detail || '', parsed.layer || 'unclear',
     parsed.action || '', parsed.note || '', parsed.verify_route || '']);

  return { ok: true, understandable: true };
}

async function mergeCandidates(items) {
  if (!items || !items.length) return [];

  const candidates = items
    .map(it => `[${it.id}] (${it.source}) ${it.title}：${it.detail}`)
    .join('\n');

  const agent = loadAgent('feedback-merge');
  const prompt = agent.render({ candidates });

  let text = '';
  try {
    const r = await runClaude(prompt, { model: agent.model, agentType: 'feedback_merge' });
    text = r.text;
    await logTokenUsage({ taskId: null, projectId: null }, null, 'feedback_merge', r.usage, r.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: null, projectId: null }, null, 'feedback_merge', err);
    return [];
  }

  const { cleaned } = extractTaggedBlock(text, 'notes');
  const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, ref: {} });
  return (parsed && Array.isArray(parsed.groups)) ? parsed.groups : [];
}

module.exports = { triageOne, mergeCandidates };
