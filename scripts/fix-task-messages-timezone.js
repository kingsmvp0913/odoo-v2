#!/usr/bin/env node
// 一次性資料校正：task_messages.occurred_at（source='sync'）因寫入時未明確標示 UTC，
// 曾被連線 session 的 timezone 設定誤判，實際環境差了 8 小時（見 pipeline/sync.js 的
// parseOdooUtcDate 修正）。這支腳本只校正「已經寫錯」的舊資料，往後新同步進來的訊息
// 已經在程式碼修正，不需要這支腳本處理。
//
// 只動 source='sync' 的列（manual 留言用 NOW() 產生，未受影響，不動）。
//
// 用法：
//   cd app && DATABASE_URL=<production connection string> node ../scripts/fix-task-messages-timezone.js
//   （不加 --confirm 是 dry-run，只顯示會影響幾筆；加 --confirm 才真的執行 UPDATE）
//
// ⚠ 只能執行一次。重複執行會把已經校正過的時間再加 8 小時，造成新的錯誤。

const path = require('path');
const { query, getPool } = require(path.join(__dirname, '..', 'app', 'server', 'db'));

async function main() {
  const confirm = process.argv.includes('--confirm');

  const { rows: countRows } = await query(
    "SELECT COUNT(*) AS n FROM task_messages WHERE source = 'sync'"
  );
  const affected = parseInt(countRows[0].n, 10);
  console.log(`受影響筆數（source='sync'）：${affected}`);

  if (affected === 0) {
    console.log('沒有需要校正的資料，結束。');
    return;
  }

  const { rows: sample } = await query(
    "SELECT id, task_id, occurred_at FROM task_messages WHERE source = 'sync' ORDER BY occurred_at DESC LIMIT 5"
  );
  console.log('校正前範例（前 5 筆，時間會 +8 小時）：');
  sample.forEach(r => console.log(`  #${r.id} task_id=${r.task_id} occurred_at=${r.occurred_at.toISOString()}`));

  if (!confirm) {
    console.log('\n這是 dry-run，沒有實際修改資料。確認上面的筆數與範例正確後，加上 --confirm 參數才會真的執行。');
    return;
  }

  const { rowCount } = await query(
    "UPDATE task_messages SET occurred_at = occurred_at + INTERVAL '8 hours' WHERE source = 'sync'"
  );
  console.log(`已校正 ${rowCount} 筆。`);
}

main()
  .catch(err => { console.error('執行失敗：', err); process.exitCode = 1; })
  .finally(() => getPool().end());
