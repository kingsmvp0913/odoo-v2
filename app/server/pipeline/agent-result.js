const { runAgent } = require('./agent-runner');
const { query } = require('../db');
const yaml = require('js-yaml');
const { logTokenUsage, logFailedUsage } = require('./token-logger');

// 統一 agent 輸出契約解析（健檢主題 F）：需要結構化結果的 agent 走同一份，取代逐個修的貪婪 regex／裸 YAML。
// 契約：結果資料包在 <result>…</result>（Claude 訓練過的 XML 閉合標籤，比自訂 ---END--- 更可靠）。
// 註：merge（吐裸檔案內容）、deploy-fix（裸 JSON）、playwright／chat（自然語言）刻意不用此契約。
//
// 解析來源一律取 runner 的 `raw`（整段 assistant transcript），不是 `text`（CLI 末輪的 ev.result）：
// agent 吐完 <result> 之後只要再講一句話——自己補收尾散文、派子任務，或被外部 hook 叫醒（實例：
// 使用者層的 security-guidance plugin，Stop hook 帶 asyncRewake，task 248 的分析關整輪因此報廢）
// ——ev.result 就換成那句話、契約標籤整個蒸發，連補救 haiku 都只拿得到那句話而必然失敗。
// 呼叫端統一寫 `x.raw ?? x.text`：runner 一定給 raw，`?? text` 是未提供該欄位時（替身、舊 provider）的保底。
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

// 格式補救也是同一張任務的 AI 花費；先把對外 task_id 換成 DB id，才能走容器的剩餘額度檢查。
async function repairTaskDbId(ref) {
  if (!ref?.taskId) return null;
  const { rows: [task] } = await query('SELECT id FROM tasks WHERE task_id=$1', [ref.taskId]);
  if (!task) throw new Error('找不到格式補救所屬任務，停止 AI 呼叫以免繞過花費上限');
  return task.id;
}

// 解析 agent 輸出。順序刻意排成「先免費、再便宜、最後才貴」：
//   1. 嚴格解析
//   2. lenientParse（呼叫端提供，零成本）——契約若是「散文回覆 ＋ 分隔線 ＋ 結構化附載」，
//      壞的幾乎一定是附載那半邊。先把回覆撈出來，附載交給呼叫端用 repairYamlPayload 單獨修。
//   3. 整段丟 haiku 重整（只有連 DECISION／REPLY 都讀不出來時才走到這）
// 步驟 2 排在 3 前面不只是省錢：實測 task 254 的整段補救花了 92 秒卻照抄同一份壞資料回來，
// 因為那段有 3.7k 字（大半是中文散文），要它改一個縮排等於要它逐字重抄一遍。
// ref/userId：補救那次 haiku 呼叫的記帳歸屬（不帶則不記帳，僅測試允許）。
// abort（手動暫停）必須 rethrow 而非吞成 null——吞掉會讓呼叫端把「暫停」誤標成 stopped。
async function parseAgentResult(raw, { parse, lenientParse, schemaHint, signal, ref, userId } = {}) {
  let parseErr = null; // 只留第一次（原始輸出）的錯誤：那才是要補救 agent 修的東西
  const doParse = (fn, s) => {
    if (s == null) return null;
    try { const v = fn(s); return v == null ? null : v; }
    catch (e) { if (parseErr == null) parseErr = String((e && e.message) || '').split('\n')[0] || null; return null; }
  };
  const inner = extractResult(raw);
  let out = doParse(parse, inner);
  if (out != null) return out;
  if (lenientParse) {
    out = doParse(lenientParse, inner);
    if (out != null) return out;   // 部分結果：缺的那半邊由呼叫端負責補回來
  }
  const taskId = await repairTaskDbId(ref);
  try {
    // 契約補救固定 Claude/haiku：只做文字整形，不隨原 agent 改 provider 以免多一個變數。
    // userId 一併帶入（本函式的參數本來就有）：這通 runAgent 一樣會經過 canRun 的公司可用性
    // 檢查（規格 §7），漏帶會讓公司已停用的客戶還能透過「輸出格式壞掉觸發補救」繼續燒 AI 的錢。
    const repaired = await runAgent(REPAIR_PROMPT(raw, parseErr, schemaHint), { provider: 'claude', model: 'haiku', signal, agentType: 'repair', userId, taskId });
    if (ref) await logTokenUsage(ref, userId, 'repair', repaired.usage, repaired.durationMs);
    out = doParse(parse, extractResult(repaired.raw ?? repaired.text));
  } catch (err) {
    if (err && err.aborted) throw err;
    if (ref) await logFailedUsage(ref, userId, 'repair', err);
    /* haiku 補救也失敗 → null */
  }
  return out;
}

// 只把壞掉的 YAML 附載送去修，回覆那半邊完全不進 prompt。回傳修好且能 yaml.load 的字串，否則 null。
// 這是「格式錯了也要自己走下去」的關鍵一步：修回來之後呼叫端照常套用，使用者不必重講一次。
// 刻意不做任何本地的縮排猜測——猜錯就是靜默寫壞規格（Rule 70），寧可交給 model 再讓 yaml.load 把關。
async function repairYamlPayload(yamlStr, parseErr, { schemaHint, signal, ref, userId } = {}) {
  if (!yamlStr || !String(yamlStr).trim()) return null;
  const prompt = '以下是一段 YAML，解析失敗了。請只回傳修正後的 YAML 本身，完整包在 <result></result> 標籤內，' +
    '標籤外不要有任何其他文字。**只修格式**（縮排、引號、跳脫、標點）——內容一個字都不要改，' +
    '不要增加或刪除任何欄位、任何一題、任何一個選項。' +
    (parseErr ? `\n\n解析器的錯誤訊息是「${parseErr}」，請針對它修正。` : '') +
    (schemaHint ? `\n\n這份 YAML 應有的結構：\n${schemaHint}` : '') +
    '\n\n' + yamlStr;
  const taskId = await repairTaskDbId(ref);
  let fixed = null;
  try {
    // userId 理由同 parseAgentResult 那通 repair 呼叫：canRun 的公司可用性檢查靠它才擋得住。
    const r = await runAgent(prompt, { provider: 'claude', model: 'haiku', signal, agentType: 'repair', userId, taskId });
    if (ref) await logTokenUsage(ref, userId, 'repair', r.usage, r.durationMs);
    fixed = extractResult(r.raw ?? r.text);
  } catch (err) {
    if (err && err.aborted) throw err;
    if (ref) await logFailedUsage(ref, userId, 'repair', err);
    return null;
  }
  if (!fixed) return null;
  try {
    const v = yaml.load(fixed, { schema: yaml.CORE_SCHEMA });
    return v && typeof v === 'object' && !Array.isArray(v) ? fixed : null;
  } catch { return null; }
}

module.exports = { extractResult, parseAgentResult, repairYamlPayload, stripFence, extractTaggedBlock };
