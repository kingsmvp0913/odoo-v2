// app/server/lib/agent-home.js
/**
 * agent-home.js — AI 容器家目錄的路徑推導：一個「公司 × scope」一個桶子（租戶隔離）
 *
 * 為什麼需要公司這一層：家目錄是宿主的實體目錄掛進容器的（pipeline/sandbox-run.js），
 * 容器是 --rm、每次砍掉重建，但這個目錄留在宿主上不會消失。舊路徑 data/agent-home/<scope>
 * 只帶了專案、沒帶公司，而一個專案可以同時綁給不只一家公司（project_companies）——
 * 後進來的那家公司的 AI 一開工 ls 自己的家目錄，就讀得到前一家留下的完整逐字稿
 * （指令、輸出、程式碼、內部推理）。這支就是把公司補進路徑、把那條路堵起來。
 *
 * 路徑形狀：
 *   內部公司（廠商自己）  data/agent-home/<scope>                 ← 與改動前逐字相同
 *   其他每一家公司        data/agent-home/company-<公司id>/<scope>
 *
 * ⚠ 內部公司沿用舊路徑是刻意的裁決，不是還沒做完：那些目錄裡有正在續接中的 claude
 * session 檔（--resume 靠它續前一輪對話，見 pipeline/claude-runner.js）。替內部另開一個
 * 空目錄，等於讓內部所有續接關卡當場從零重讀、極可能再逾時一次。客戶公司本來就沒有歷史，
 * 從空桶子開始不損失任何東西。要改這個對應之前先想清楚：改了就是把內部既有的 session
 * 全部丟掉。（對應的驗收點：內部算出來的路徑必須與改動前逐字相同，見 tests/agent-home.test.js）
 */
const path = require('path');
const { scopeKind } = require('./agent-profiles');

// 桶子目錄名只允許 company-<正整數>：值雖然來自 DB 的 SERIAL，仍在組路徑前擋一次，
// 免得日後有人把別的來源接進來就變成路徑穿越。
const BUCKET_RE = /^company-[1-9]\d*$/;

/**
 * 這次執行該落在誰的桶子。回 null＝內部公司（＝沿用舊路徑）。
 *
 * 系統觸發的執行（cron 推進、夜間改善批次、系統觸發的 git push）沒有發起人，actorUserId
 * 是 null／undefined ⇒ 直接回 null，連 DB 都不查。這是刻意的：這條路徑的落點必須是確定的，
 * 不能因為 DB 抖一下就改變，更不能落進任何一家客戶的桶子；而「落在廠商自己的桶子」正是
 * 這些工作本來的歸屬（它們做的是平台自己的維運，不是替某個客戶做事）。
 *
 * 查得到人但查不到公司（平台管理員沒有公司、遷移前建立的舊帳號）同樣算內部——判法與
 * lib/tenant-access.js 的 isUserCompanyInternal 一致（查不到 ⇒ 內部人員）。
 *
 * 刻意不包 try/catch：查詢真的失敗時寧可讓這次 AI 執行整個失敗（fail loud），也不能靜默
 * 把某個客戶的家目錄指到內部桶子——那正是本次要修掉的外洩本身。
 */
async function resolveHomeBucket(actorUserId, deps = {}) {
  if (!actorUserId) return null;
  const q = deps.query || require('../db').query;
  const { rows } = await q(
    'SELECT c.id, c.is_internal FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1',
    [actorUserId]
  );
  if (!rows[0] || rows[0].is_internal === true) return null;
  return `company-${Number(rows[0].id)}`;
}

/**
 * 組出家目錄路徑。純函式，沒有副作用（建目錄仍由呼叫端負責，權限 0o700）。
 * scope 先過 scopeKind 驗一次：它是 lib/agent-profiles.js 對 scope 形狀的唯一真相，
 * 通行證簽發（lib/agent-run-token.js）用的也是同一支，這裡不另立第二套判法。
 */
function agentHomeDir(appDir, scope, bucket) {
  scopeKind(scope);
  const base = path.join(appDir, 'data', 'agent-home');
  if (bucket == null) return path.join(base, scope);
  if (!BUCKET_RE.test(bucket)) throw new Error(`家目錄的公司桶子名稱不合法：${bucket}`);
  return path.join(base, bucket, scope);
}

module.exports = { resolveHomeBucket, agentHomeDir };
