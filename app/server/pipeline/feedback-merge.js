const { loadAgent } = require('./agent-loader');
const { runClaude } = require('./claude-runner');
const { parseAgentResult, extractTaggedBlock } = require('./agent-result');
const { logTokenUsage, logFailedUsage } = require('./token-logger');

/**
 * feedback-merge.js — 跑 feedback-merge agent：把當晚的候選合併成不重複的修改組。
 *
 * 跟 finding-fix.js 同一套組合（loadAgent → render → runClaude → extractTaggedBlock →
 * parseAgentResult），差別是這裡不改程式碼、只把判讀結果回傳給呼叫端。
 *
 * 這個檔原本還有一支 triageOne（先把使用者原文翻成規格再交給修正 agent）。2026-09-09 拿掉：
 * 翻譯與改碼都是 opus，同一段原文付兩次錢；而它宣稱要擋的兩件事（layer 不在範圍、看不懂）
 * 在 17 筆意見的完整歷史裡一次都沒發生過。那兩個判斷改由 platform-fix 在讀完程式碼之後做。
 */

// 給補救 agent 的目標結構（同 feedback-merge.md 的輸出契約）：raw 整段沒有 <result> 時，
// 它沒有鍵名可依循就只能亂猜，等於白跑一次 haiku（見 task-agent.js 的同一個決定）。
const MERGE_SCHEMA = '{"groups":[{"member_ids":[1,2],"title":"標題","detail":"合併後描述",'
  + '"action":"建議修法","layer":"code","risk_if_wrong":"這組若修錯了最壞會怎樣，推不出來留空"}]}';

// 解析失敗時重跑整支 merge 的次數（總共最多跑 MERGE_MAX_ATTEMPTS 次）。
// ⚠ 這裡要的是「換一次生成」，不是 parseAgentResult 內建的 haiku 補救——兩者治的病不同：
// 補救擅長剝掉多餘文字，但 merge 的 <result> 是一整份夾了長篇中文的 JSON，補救等於要 haiku
// 把數 KB 中文一字不改重抄一遍，抄的過程本身就會再出錯（2026-09-07 實測：opus 在 detail 裡
// 寫了未跳脫的半形雙引號，補救跟著失敗，該晚 4 筆候選全數落空）。重生成則是換一顆骰子，
// 而格式抖動本來就是隨機的。只重試「解析失敗」，不重試「CLI 執行失敗」——後者多半是額度或
// 環境問題，同一分鐘內重跑只是白燒一次。
const MERGE_MAX_ATTEMPTS = 2;

async function mergeCandidates(items) {
  if (!items || !items.length) return [];

  const candidates = items
    .map(it => `[${it.id}] (${it.source}) ${it.title}：${it.detail}`)
    .join('\n');

  const agent = loadAgent('feedback-merge');
  const prompt = agent.render({ candidates });

  for (let attempt = 1; attempt <= MERGE_MAX_ATTEMPTS; attempt++) {
    let text = '';
    try {
      const r = await runClaude(prompt, { model: agent.model, agentType: 'feedback_merge' });
      text = r.raw ?? r.text;
      await logTokenUsage({ taskId: null, projectId: null }, null, 'feedback_merge', r.usage, r.durationMs);
    } catch (err) {
      await logFailedUsage({ taskId: null, projectId: null }, null, 'feedback_merge', err);
      console.error('[FEEDBACK-MERGE] 執行失敗，本輪 %d 筆候選未合併：%s', items.length, err.message);
      return [];
    }

    // feedback-merge.md 的輸出契約只有 <result>，沒有 <notes>（4-M1：落地需要單元 2 的
    // materializeGroup／DB 才能接住批次級稽核材料，這輪先拿掉宣告、不留沒人讀的欄位）。
    // 這裡仍剝一次 <notes> 只是防禦：就算 agent 習慣性夾帶說明文字，parseAgentResult 本來就會
    // 用 lastIndexOf 找最後一組 <result>，剝不剝都不影響解析，純粹清理雜訊。
    const { cleaned } = extractTaggedBlock(text, 'notes');
    const parsed = await parseAgentResult(cleaned, { parse: JSON.parse, schemaHint: MERGE_SCHEMA, ref: {} });
    if (parsed && Array.isArray(parsed.groups)) return parsed.groups;

    // 回 [] 與「今晚本來就沒候選」長得一模一樣：不出聲的話，整晚候選集體蒸發沒有任何訊號。
    // （呼叫端收到 [] 會改走逐條處理，見 nightly-fix.js 的 identityGroups，不再整批歸零。）
    console.error('[FEEDBACK-MERGE] 第 %d 次解析不出 groups（共 %d 次），本輪 %d 筆候選未合併',
      attempt, MERGE_MAX_ATTEMPTS, items.length);
  }
  return [];
}

module.exports = { mergeCandidates };
