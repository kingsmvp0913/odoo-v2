const { runClaude } = require('./claude-runner');

// 統一 agent 輸出契約解析（健檢主題 F）：所有 agent 走同一份，取代逐個修的貪婪 regex／裸 YAML。
// 契約：結果資料包在 <result>…</result>（Claude 訓練過的 XML 閉合標籤，比自訂 ---END--- 更可靠）。
const OPEN = '<result>';
const CLOSE = '</result>';

// 剝除首尾 ``` code fence（含 ```json / ```yaml 等語言標記）——model 對純資料輸出加 fence 是高頻行為
function stripFence(s) {
  const t = String(s).trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

// 取最後一組 <result>…</result> 內容（無閉合標籤則取 <result> 之後到結尾）；找不到回 null。
// 用 lastIndexOf 取「最後一個」<result>：prompt 內若先給範例 <result> 再給答案，不會誤取範例。
function extractResult(text) {
  if (!text) return null;
  const start = text.lastIndexOf(OPEN);
  if (start === -1) return null;
  const afterOpen = start + OPEN.length;
  const end = text.indexOf(CLOSE, afterOpen);
  const inner = end !== -1 ? text.slice(afterOpen, end) : text.slice(afterOpen);
  return stripFence(inner);
}

const REPAIR_PROMPT = raw =>
  '以下是某 agent 的輸出，可能夾雜多餘文字或格式錯誤。請只回傳其中的「結果資料」本身，' +
  '完整包在 <result></result> 標籤內，標籤外不要有任何其他文字：\n\n' + raw;

// 解析 agent 輸出：先直接 extract+parse，失敗才用 haiku 補救一次（只修格式、不改語意），
// 仍失敗回 null（呼叫端 stopped）。agent 已花完數十萬 token，不該因收尾格式抖動整輪報廢（健檢 F）。
async function parseAgentResult(raw, { parse, signal } = {}) {
  const doParse = s => {
    if (s == null) return null;
    try { const v = parse(s); return v == null ? null : v; } catch { return null; }
  };
  let out = doParse(extractResult(raw));
  if (out != null) return out;
  try {
    const repaired = await runClaude(REPAIR_PROMPT(raw), { model: 'haiku', signal, agentType: 'repair' });
    out = doParse(extractResult(repaired.text));
  } catch { /* haiku 補救也失敗 → null */ }
  return out;
}

module.exports = { extractResult, parseAgentResult };
