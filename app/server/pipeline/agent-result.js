const { runClaude } = require('./claude-runner');
const { logTokenUsage, logFailedUsage } = require('./token-logger');

// 統一 agent 輸出契約解析（健檢主題 F）：需要結構化結果的 agent 走同一份，取代逐個修的貪婪 regex／裸 YAML。
// 契約：結果資料包在 <result>…</result>（Claude 訓練過的 XML 閉合標籤，比自訂 ---END--- 更可靠）。
// 註：merge（吐裸檔案內容）、deploy-fix（裸 JSON）、playwright／chat（自然語言）刻意不用此契約。
const OPEN = '<result>';
const CLOSE = '</result>';

// 剝除首尾 ``` code fence（含 ```json / ```yaml 等語言標記）——model 對純資料輸出加 fence 是高頻行為
function stripFence(s) {
  const t = String(s).trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

// 取最後一組 <result>…</result> 內容（缺 </result> 閉合＝截斷／不完整，回 null 交上層 repair 重取）；找不到回 null。
// 用 lastIndexOf 取「最後一個」<result>：prompt 內若先給範例 <result> 再給答案，不會誤取範例。
function extractResult(text) {
  if (!text) return null;
  const end = text.lastIndexOf(CLOSE);
  if (end === -1) return null;
  const start = text.lastIndexOf(OPEN, end);
  if (start === -1) return null;
  return stripFence(text.slice(start + OPEN.length, end));
}

// 通用側通道抽取：取最後一組 <tag>…</tag>，回 { inner:<剝 fence 後的內層字串或 null>, cleaned:<移除該區塊後的全文> }。
// 與主要 <result> 契約獨立，供 chat/cs 在自然語言回覆末端夾帶選用的機器讀取區塊（memory／wiki-drift）；
// 呼叫端自行 JSON.parse＋驗證。缺該標籤時 inner=null、cleaned=原文（trim）。
function extractTaggedBlock(text, tag) {
  const raw = String(text || '');
  const open = `<${tag}>`, close = `</${tag}>`;
  const end = raw.lastIndexOf(close);
  if (end === -1) return { inner: null, cleaned: raw.trim() };
  const start = raw.lastIndexOf(open, end);
  if (start === -1) return { inner: null, cleaned: raw.trim() };
  const cleaned = (raw.slice(0, start) + raw.slice(end + close.length)).trim();
  return { inner: stripFence(raw.slice(start + open.length, end)), cleaned };
}

// 一定要把解析器的抱怨原樣轉述給補救 agent：只說「可能有格式錯誤」等於叫它盲修，它會把同一份
// 壞資料原封抄回來（實測 task 110 的 analysis 只是把 `permissions: |` 吐了兩次＝duplicated
// mapping key，其餘完全正確，haiku 卻花了 147 秒／7.8k tokens 產出一模一樣的錯，整輪 opus 報廢）。
// 抽不出 <result> 時沒有錯誤可報，此段整段省略——編一個不存在的錯只會把它導去修錯地方。
// 但「整段沒有 <result>」正是最需要指引的情況：raw 裡連一個 JSON 都沒有時（實測 task 152 的
// coding 只吐了一段中文摘要），補救 agent 沒有目標結構就只能亂猜鍵名，必然再失敗一次。
// schemaHint 由呼叫端給（它才知道自己的 parse 期望什麼），不給則行為與原本完全相同。
const REPAIR_PROMPT = (raw, err, schemaHint) =>
  '以下是某 agent 的輸出，可能夾雜多餘文字或格式錯誤。請只回傳其中的「結果資料」本身，' +
  '完整包在 <result></result> 標籤內，標籤外不要有任何其他文字。' +
  (err ? `\n\n上一次解析失敗的錯誤訊息是「${err}」，請針對這個錯誤修正，其餘內容一字不改。` : '') +
  (schemaHint ? `\n\n結果資料必須是這個結構：\n${schemaHint}\n請依上方輸出的實際內容填值，不要自行增刪語意；` +
    '輸出若沒有明說對應的值，就依它實際做了什麼如實填，不要編造。' : '') +
  '\n\n' + raw;

// 解析 agent 輸出：先直接 extract+parse，失敗才用 haiku 補救一次（只修格式、不改語意），
// 仍失敗回 null（呼叫端 stopped）。agent 已花完數十萬 token，不該因收尾格式抖動整輪報廢（健檢 F）。
// ref/userId：補救那一次 haiku 呼叫的記帳歸屬（不帶則不記帳，僅測試允許）。
// abort（手動暫停）必須 rethrow 而非吞成 null——吞掉會讓呼叫端把「暫停」誤標成 stopped。
async function parseAgentResult(raw, { parse, schemaHint, signal, ref, userId } = {}) {
  let parseErr = null; // 只留第一次（原始輸出）的錯誤：那才是要補救 agent 修的東西
  const doParse = s => {
    if (s == null) return null;
    try { const v = parse(s); return v == null ? null : v; }
    catch (e) { parseErr = String((e && e.message) || '').split('\n')[0] || null; return null; }
  };
  let out = doParse(extractResult(raw));
  if (out != null) return out;
  try {
    const repaired = await runClaude(REPAIR_PROMPT(raw, parseErr, schemaHint), { model: 'haiku', signal, agentType: 'repair' });
    if (ref) await logTokenUsage(ref, userId, 'repair', repaired.usage, repaired.durationMs);
    out = doParse(extractResult(repaired.text));
  } catch (err) {
    if (err && err.aborted) throw err;
    if (ref) await logFailedUsage(ref, userId, 'repair', err);
    /* haiku 補救也失敗 → null */
  }
  return out;
}

module.exports = { extractResult, parseAgentResult, stripFence, extractTaggedBlock };
