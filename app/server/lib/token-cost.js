// token_usage 的成本估算公式，單一來源。
//
// 原本 token-report-routes 與 health-data 各存一份逐字相同的 WEIGHTED／RATE，兩邊都是「改一處
// 另一處不會跟著動」的狀態。這不只是重複——健檢 agent 正是拿 health-data 算出來的成本判斷
// 「這個 agent 值不值得檢討」，而人看的是 token 報表那一份；兩份定義一旦漂開，同一段時間同一個
// agent 會在兩個畫面上顯示對不起來的金額，而且沒有任何訊號。
//
// 成本模型（對齊 ccusage）：各 model 內的比例一致（output=5×input、cache_read=0.1×、
// cache_create=1.25×），所以成本 = 該 model 每 1M input 單價 × 加權 input 等效顆數 / 1e6。
// 未知或空白的 model 一律以 sonnet 計（低估比高估安全：不會憑空生出一筆嚇人的支出）。
// LOWER + LIKE 而非 ILIKE：pg-mem（測試用）不保證支援 ILIKE。
//
// prefix 是資料表別名（含點），例如 'tu.'；沒有別名時傳空字串。
// 相對單價倍率。數字是「相對於基準的倍數」，不是美元——實際金額由 weighted × rate / 1e6 得出。
//
// claude 這幾支是本檔既有的值，沿用未動。
// ⚠ **codex 的倍率是尚未查證的暫定值**：本次改動要解決的是結構性問題——原本的 CASE 只看 model
// 字串，codex 的 model 名（gpt-5.6-*）會全數落到 ELSE 3.0 被當 sonnet 計，而且**不會報錯**。
// 結構修好了，但填什麼數字需要 OpenAI 的實際計價，還沒有人查。在查證之前，codex 的成本數字
// 只能當「量級參考」，不可拿來做成本比較或寫進健檢結論。
// 查證後請直接改這裡——這是單一來源，health-data.js 兩處都經由 costSql() 取用。
const RATES = {
  claude: { haiku: 1.0, opus: 5.0, fable: 10.0, _default: 3.0 },
  codex:  { _default: 3.0, _verified: false }   // TODO(未查證)：填入實際倍率後把 _verified 改 true
};

function costSql(prefix = '') {
  const p = prefix;
  const weighted = `(${p}input_tokens + ${p}output_tokens * 5 + ${p}cache_read_tokens * 0.1 + ${p}cache_create_tokens * 1.25)`;
  // 先分 provider 再分 model：不先分的話 codex 的 model 名會落到 claude 的 ELSE 分支。
  // provider 為 NULL＝本欄上線前的既有列，一律當 claude。
  const isCodex = `LOWER(COALESCE(${p}provider,'claude')) = 'codex'`;
  const rate = `(CASE
         WHEN ${isCodex} THEN ${RATES.codex._default}
         WHEN LOWER(COALESCE(${p}model,'')) LIKE '%haiku%' THEN ${RATES.claude.haiku}
         WHEN LOWER(COALESCE(${p}model,'')) LIKE '%opus%'  THEN ${RATES.claude.opus}
         WHEN LOWER(COALESCE(${p}model,'')) LIKE '%fable%' THEN ${RATES.claude.fable}
         ELSE ${RATES.claude._default}
       END)`;
  return { weighted, rate, cost: `(${rate} * ${weighted} / 1000000.0)` };
}

module.exports = { costSql, RATES };
