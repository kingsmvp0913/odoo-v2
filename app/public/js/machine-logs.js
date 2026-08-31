// 全站唯一的「機器輸入型 log」registry：哪幾種 task_logs 的內容其實是寫給下一關 agent 讀的機器輸入
// （前綴同時是後端的查詢鍵與剝除目標），不能為了好讀而改寫內容；但它們一樣會出現在使用者眼前
// （實測 QA 那則平均 725 字、最長 1060 字的純技術文）。折衷：內容原封不動，顯示端預設收合成一句人話。
//
// 前綴字面值原本散在六處（qa-agent 的 LIKE 查詢／剝除正則／寫 log／寫 retry_feedback、verdict-router、
// TaskDetail 的收合表），改一處另幾處靜默失效。後端改壞了還有 qa-agent.test.js 會紅，前端收合卻是
// 完全靜默：CI 全綠，使用者直接吃回整段技術文。比照 status-labels.js 收成本檔單一來源
// （前端 index.html 載入、後端 require 同一份）。
//
// role 是收合的必要條件而不是註記：task_logs 一律被前端映成 kind:'log'（不分 role），而使用者的逐字
// 原文（澄清回答／澄清提問／規格審核意見／cs 追問）也以 role='user' 寫進同一張表。只比前綴的話，
// 使用者把 [QA 未通過] 那則整段複製、貼進提問框問「這是什麼意思」，他自己的發言會被折成 AI 的那句
// 人話，看起來像 AI 又講了一遍。
const MACHINE_LOGS = {
  // 內容同時是下一輪 QA 的「未解清單」來源：qa-agent.js 直接 LIKE 查這則 log 撈回去逐項重驗
  qa_fail: { prefix: '[QA 未通過]', role: 'ai', hint: '程式碼審查發現問題' },
  // 以 role='user' 寫入（reject-triage.js），偽裝成使用者澄清餵給重跑的 analysis
  respec_handoff: { prefix: '[分診—需調整規格]', role: 'user', hint: '判定為規格需要調整，已轉回分析階段重寫規格' },
  // cs 的 reason_plain 是白話短句、本來就是寫給人讀的，收合它等於藏掉唯一看得懂的說明；
  // 只有模型漏吐 reason_plain、退回貼技術版 reason（實測平均 906 字）那條 fallback 才需要收合。
  cs_code_change: { prefix: '[客服判定：需改程式]', role: 'ai', hint: '客服判定需要修改程式', collapseWhenLong: true },
  // 分診結論寫給開發／審核看（實測是「`search()` 未帶 `active_test=False`」這種純技術文，平均 247~433 字），
  // 卻與客服回覆並排在同一條時間軸上。不設 collapseWhenLong：它幾乎都在 400 字以下，但短不代表看得懂。
  // 去向（fix／advance／…）由寫入端帶進標頭列，收合後那句人話才講得出「所以接下來會怎樣」。
  triage_summary: { prefix: '[審核分診]', role: 'ai', hint: '已判斷這次退回要怎麼處理' }
};

// 標頭列格式：`<prefix>（<去向>）\n<本體>`。去向是給人看的一句話（顯示端接在 hint 後面），可省略。
// 用全形括號界定而不是「吃到行尾」：既有資料有寫成單行 `<prefix> <本體>` 的，吃到行尾會把本體整段吞掉。
const OUTCOME_SRC = '(?:（[^）\\n]*）)?';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 寫入端：組標頭列。outcome 省略＝維持原格式（只有前綴）。
const machineLogHeader = (key, outcome) => MACHINE_LOGS[key].prefix + (outcome ? `（${outcome}）` : '');

// 讀取端：剝掉整個標頭列（含去向後綴）只留本體。去向沒剝乾淨會混進下一輪 QA 的未解清單被當成待驗項。
const stripMachineHeader = (key, content) =>
  String(content || '').replace(new RegExp(`^${escapeRe(MACHINE_LOGS[key].prefix)}${OUTCOME_SRC}\\s*`), '').trim();

// 顯示端：命中 registry（前綴與 role 都要對）→ 回傳該收合成的那句人話，否則 null（照常整段顯示）
function machineLogHint(role, content) {
  const c = String(content || '');
  const hit = Object.values(MACHINE_LOGS).find(m => m.role === role && c.startsWith(m.prefix));
  if (!hit) return null;
  // 夠短就別收：門檻比照 isErrorLog（>400 字或 >8 行）
  if (hit.collapseWhenLong && c.length <= 400 && (c.match(/\n/g) || []).length + 1 <= 8) return null;
  const m = c.slice(hit.prefix.length).match(/^（([^）\n]*)）/);
  const outcome = m ? m[1].trim() : '';
  return outcome ? `${hit.hint}，${outcome}` : hit.hint;
}

if (typeof window !== 'undefined') {
  window.MACHINE_LOGS = MACHINE_LOGS;
  window.machineLogHint = machineLogHint;
}
if (typeof module !== 'undefined') module.exports = { MACHINE_LOGS, machineLogHeader, stripMachineHeader, machineLogHint };
