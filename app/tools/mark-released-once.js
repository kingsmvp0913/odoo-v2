// 一次性腳本（2026-09-22）：把歷史遺留的 finding_fixes 從 merged 改成 released。
//
// 為什麼需要它：更版機制上線前，流程是「合併完就立刻重啟」，所以 merged 與「已經在跑」
// 是同一刻的事，沒有第二個狀態可標。今天把合併與重啟拆開之後才有 released。
// 結果是 28 筆歷史資料卡在 merged——它們的程式碼早就在跑了（最新一筆 9/20，平台 9/22 重啟過），
// 但畫面會顯示「已合併，待更版」，而新的更版機制也會以為有東西在等，第一個維護時段白重啟一次。
//
// 跑法（在 app/ 底下）：node tools/mark-released-once.js
// 只改 status='merged' 的列；跑第二次會回報 0 筆，重複執行無害。

const { Client } = require('pg');
// 路徑相對本檔（app/tools/），不是相對執行目錄——設定檔在 repo 根的 data/ 底下。
const cfg = require('../../data/config.json');

(async () => {
  const c = new Client({ connectionString: cfg.DATABASE_URL });
  await c.connect();
  try {
    const before = await c.query("SELECT status, count(*) n FROM finding_fixes GROUP BY 1 ORDER BY 2 DESC");
    console.log('改動前：', JSON.stringify(before.rows));

    const up = await c.query("UPDATE finding_fixes SET status='released' WHERE status='merged'");
    console.log('實際改了：', up.rowCount, '筆');

    const after = await c.query("SELECT status, count(*) n FROM finding_fixes GROUP BY 1 ORDER BY 2 DESC");
    console.log('改動後：', JSON.stringify(after.rows));

    const pend = await c.query("SELECT count(*) n FROM finding_fixes WHERE status='merged'");
    console.log('待更版剩：', pend.rows[0].n, '筆（預期 0）');
  } finally {
    await c.end();
  }
})().catch(e => { console.error('失敗：', e.message); process.exit(1); });
