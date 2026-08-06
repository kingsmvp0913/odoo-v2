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
function costSql(prefix = '') {
  const p = prefix;
  const weighted = `(${p}input_tokens + ${p}output_tokens * 5 + ${p}cache_read_tokens * 0.1 + ${p}cache_create_tokens * 1.25)`;
  const rate = `(CASE
         WHEN LOWER(COALESCE(${p}model,'')) LIKE '%haiku%' THEN 1.0
         WHEN LOWER(COALESCE(${p}model,'')) LIKE '%opus%'  THEN 5.0
         WHEN LOWER(COALESCE(${p}model,'')) LIKE '%fable%' THEN 10.0
         ELSE 3.0
       END)`;
  return { weighted, rate, cost: `(${rate} * ${weighted} / 1000000.0)` };
}

module.exports = { costSql };
