const path = require('path');
const { query } = require('../db');
const { uploadRoot } = require('../lib/attachments');
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
 * ⚠ triageOne 判不出來（understandable 非明確 true）或解析失敗，一律把 feedback.status 退回
 * 'new'、清掉上一輪的 triage 欄位、並在 triage_note 寫原因——不可卡在中間狀態，否則那筆意見
 * 會消失在畫面看不到、也進不了下一輪批次的候選清單；殘留的舊欄位則會讓管理頁看起來像
 * 「這條已經翻譯好了」。
 */

// triage 只認這五種根因層（與 feedback-triage.md 的判準同字面）。
// 不在清單內就當 unclear：原樣寫進 DB 會讓下游拿一個沒人處理得了的值去分流。
const LAYERS = new Set(['code', 'prompt', 'observability', 'env', 'unclear']);
const normLayer = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return LAYERS.has(s) ? s : 'unclear';
};

// 給補救 agent 的目標結構（同 feedback-triage.md 的輸出契約）：raw 整段沒有 <result> 時，
// 它沒有鍵名可依循就只能亂猜，等於白跑一次 haiku（見 task-agent.js 的同一個決定）。
const TRIAGE_SCHEMA = '{"title":"一句話標題","detail":"具體問題描述","layer":"code｜prompt｜observability｜env｜unclear",'
  + '"action":"建議修法","understandable":"true｜false（判不出來填 false）","note":"看不懂時寫原因","verify_route":"#/tasks 這種 hash 路由，推不出來留空"}';
const MERGE_SCHEMA = '{"groups":[{"member_ids":[1,2],"title":"標題","detail":"合併後描述",'
  + '"action":"建議修法","layer":"code","verify_route":"","risk_if_wrong":"這組若修錯了最壞會怎樣，推不出來留空"}]}';

// 附件（使用者截圖）往往是這則意見唯一講得清楚的部分，agent 有 Read 工具可直接檢視。
// ⚠ file_path 存的是「相對 uploadRoot()」的路徑，一定要 resolve 成絕對路徑；而且要明確授權唯讀，
// 否則 agent 會因「不得存取工作目錄外路徑」規則跳過不讀。措辭與 sync.js 的 taskAttachmentNote 同源。
// 少了這兩件事的症狀完全無訊號：agent 打不開圖 → 依 prompt 規則回 understandable:false →
// 意見退回 new，外面看起來只是「AI 老是說看不懂」。
async function attachmentNote(feedbackId) {
  const { rows: atts } = await query(
    'SELECT filename, mimetype, file_path FROM feedback_attachments WHERE feedback_id = $1 ORDER BY id',
    [feedbackId]
  );
  if (!atts.length) return '（無：這則意見沒有附圖）';
  return '以下檔案可用 Read 工具讀取（圖片可直接檢視）。明確授權：讀取這些附件屬唯讀，'
    + '不受「不得存取工作目錄外路徑」限制；僅可讀取，不得修改。\n'
    + atts.map(a => `- ${a.filename}${a.mimetype ? `（${a.mimetype}）` : ''}：${path.resolve(uploadRoot(), a.file_path)}`).join('\n');
}

// 退回 new：連同上一輪殘留的 triage 欄位一起清掉，只留原因供管理頁顯示。
function rejectBack(feedbackId, note) {
  return query(
    `UPDATE feedback
        SET status='new', triage_note=$2,
            triage_title=NULL, triage_detail=NULL, triage_layer=NULL,
            triage_action=NULL, verify_route=NULL
      WHERE id=$1`,
    [feedbackId, note]);
}

// <notes> 是夜間無人監督時，人事後唯一讀得到的推理過程——成功路徑也要落地。
const composeNote = (...parts) => parts.filter(s => s && String(s).trim()).join('\n\n');

async function triageOne(feedbackId) {
  const { rows: [fb] } = await query('SELECT id, content FROM feedback WHERE id=$1', [feedbackId]);
  if (!fb) return { ok: false, understandable: false };

  const agent = loadAgent('feedback-triage');
  const prompt = agent.render({
    content: fb.content || '',
    attachments: await attachmentNote(feedbackId)
  });

  let text = '';
  try {
    const r = await runClaude(prompt, { model: agent.model, agentType: 'feedback_triage' });
    text = r.text;
    await logTokenUsage({ taskId: null, projectId: null }, null, 'feedback_triage', r.usage, r.durationMs);
  } catch (err) {
    // ⚠ 執行失敗（CLI 掛掉／逾時／額度）與「看不懂」是兩件事，處置不能共用 rejectBack：
    // 看不懂是確定性結果，同一份原文重跑一百次還是看不懂，退回 new 交給人是對的；執行失敗
    // 多半是暫時的，退回 new 等於「一次暫時失敗＝永久卡死」——下一輪的 fetchApprovedFeedback
    // 只撈 status='approved'，退回去的再也不會被重試（實測 2026-09-04：5 筆候選連 5 次
    // `claude exited with code 1`，全被退回 new，整條改善通道從此停擺，畫面上毫無訊號）。
    // 這裡只留痕、不動 status，由呼叫端走既有的 fix_attempts 飢餓防線：連續失敗達門檻才退場。
    await logFailedUsage({ taskId: null, projectId: null }, null, 'feedback_triage', err);
    await query('UPDATE feedback SET triage_note=$2 WHERE id=$1', [feedbackId, `執行失敗：${err.message}`]);
    return { ok: false, understandable: false, transient: true };
  }

  const { inner: notesBlock, cleaned } = extractTaggedBlock(text, 'notes');
  const notes = (notesBlock || '').trim();
  const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, schemaHint: TRIAGE_SCHEMA, ref: {} });

  if (!parsed) {
    await rejectBack(feedbackId, composeNote('無法解析 triage 結果', notes));
    return { ok: false, understandable: false };
  }

  // 安全閘門只認明確的 true。LLM 回字串 "false" 時 `!parsed.understandable` 會是 false
  // （非空字串為真）＝判成看得懂，直接送進夜間改 production；缺欄位方向是 fail-safe，唯獨字串反向。
  if (parsed.understandable !== true) {
    await rejectBack(feedbackId, composeNote(parsed.note || '看不出具體修改需求', notes));
    return { ok: true, understandable: false };
  }

  await query(
    `UPDATE feedback
        SET triage_title=$2, triage_detail=$3, triage_layer=$4, triage_action=$5,
            triage_note=$6, verify_route=$7
      WHERE id=$1`,
    [feedbackId, parsed.title || '', parsed.detail || '', normLayer(parsed.layer),
     parsed.action || '', composeNote(notes, parsed.note), parsed.verify_route || '']);

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
    console.error('[FEEDBACK-MERGE] 執行失敗，本輪 %d 筆候選全數落空：%s', items.length, err.message);
    return [];
  }

  // feedback-merge.md 的輸出契約只有 <result>，沒有 <notes>（4-M1：落地需要單元 2 的
  // materializeGroup／DB 才能接住批次級稽核材料，這輪先拿掉宣告、不留沒人讀的欄位）。
  // 這裡仍剝一次 <notes> 只是防禦：就算 agent 習慣性夾帶說明文字，parseAgentResult 本來就會
  // 用 lastIndexOf 找最後一組 <result>，剝不剝都不影響解析，純粹清理雜訊。
  const { cleaned } = extractTaggedBlock(text, 'notes');
  const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, schemaHint: MERGE_SCHEMA, ref: {} });
  if (!parsed || !Array.isArray(parsed.groups)) {
    // 回 [] 與「今晚本來就沒候選」長得一模一樣：不出聲的話，整晚候選集體蒸發沒有任何訊號。
    console.error('[FEEDBACK-MERGE] 解析不出 groups，本輪 %d 筆候選全數落空', items.length);
    return [];
  }
  return parsed.groups;
}

module.exports = { triageOne, mergeCandidates };
