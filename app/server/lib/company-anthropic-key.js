/**
 * company-anthropic-key.js — 設定／清除一家公司的 Anthropic API key（子專案 2）
 *
 * 為什麼抽出來：這件事有**兩個入口**（2026-09-24 使用者裁決「兩邊都要能填」）——
 * 平台管理員在公司管理頁代填（開通時用），公司管理員在自己的公司帳號頁換
 * （key 過期或旋轉時不用找平台）。兩邊的規則必須一模一樣，而下面那段錯誤政策
 * 是刻意設計過的（見 setCompanyAnthropicKey 的註解），複製第二份一定會分岔——
 * 分岔的症狀是「同一把壞 key，從這個入口被擋、從那個入口存進去了」。
 *
 * 呼叫端只要把丟出來的 CompanyKeyError 的 status／message 原樣回給前端即可，
 * 兩個入口的錯誤訊息因此逐字相同。
 */
const { encrypt } = require('./crypto');

// 帶 HTTP 狀態碼的錯誤。呼叫端不必各自判斷該回 400 還是 404。
class CompanyKeyError extends Error {
  constructor(status, message) { super(message); this.status = status; this.code = 'COMPANY_KEY'; }
}

/**
 * 設定一家公司的 key。回 `{ warning }`——warning 非 null 代表「存進去了，但沒驗成功」。
 *
 * **錯誤政策（照抄 saveClaudeToken，理由一字不差地適用）**：
 * 認證失敗＝貼錯或已撤銷 ⇒ 擋下不存；非認證失敗（API 過載、網路抖動）⇒ 仍然存，
 * 但據實回報沒驗成功。換 key 的時機往往正是服務不穩的時候，一次 529 就把人鎖在
 * 外面是更糟的失敗模式。
 */
async function setCompanyAnthropicKey({ companyId, apiKey, actorUserId }, deps = {}) {
  const query = deps.query || require('../db').query;
  const key = typeof apiKey === 'string' ? apiKey.trim() : apiKey;
  if (!key) throw new CompanyKeyError(400, '請貼上 Claude 認證憑證');
  // 沒有 APP_SECRET 就加密不了。存明文比不存更糟，所以這裡是硬擋。
  if (!process.env.APP_SECRET) throw new CompanyKeyError(500, '伺服器未設定 APP_SECRET，無法安全存放憑證');

  const { rows: co } = await query('SELECT id, is_internal FROM companies WHERE id = $1', [companyId]);
  if (!co.length) throw new CompanyKeyError(404, '找不到這家公司');
  // 內部公司用平台的訂閱付錢（companies.is_internal 的欄位註解），不該有自己的 key。
  // 擋下來而不是照存：存了也永遠不會被用到，只會讓人以為設定生效了。
  if (co[0].is_internal === true) {
    throw new CompanyKeyError(400, '內部公司用平台的訂閱執行 AI，不需要也不會使用自己的憑證');
  }

  let warning = null;
  try {
    const { runClaude } = deps.runClaude ? { runClaude: deps.runClaude } : require('../pipeline/claude-runner');
    const { looksLikeAuthFailure } = deps.looksLikeAuthFailure
      ? { looksLikeAuthFailure: deps.looksLikeAuthFailure }
      : require('../pipeline/auth-signature');
    try {
      // userId 帶發起者：那是 AI 執行授權（canRun）的依據，全樹守衛 runagent-userid-guard
      // 會擋下漏帶的呼叫。憑證本身由這裡的 env 覆寫決定，與 userId 解析出來的那把無關——
      // 所以這裡不會驗到平台那把。
      await runClaude('回覆 ok', {
        // 客戶存的是訂閱 token，不是 API key（2026-09-24 裁決）。變數名寫錯的話
        // 這裡會驗到平台那把而不是候選這把——等於沒驗，而且一定「通過」。
        env: { CLAUDE_CODE_OAUTH_TOKEN: key }, timeoutMs: 60000, agentType: 'auth_probe', userId: actorUserId,
      });
    } catch (err) {
      if (err.claudeStatus === 'auth' || looksLikeAuthFailure(err.message)) {
        throw new CompanyKeyError(400, '憑證無效或已撤銷，未儲存');
      }
      warning = `已儲存，但驗證未能完成：${err.message}`;
    }
  } catch (err) {
    // 上面那個 CompanyKeyError 是「驗出 key 是壞的」，必須原樣往外丟；
    // 這一層 catch 只負責「連驗都跑不起來」（模組載入失敗等）。
    if (err instanceof CompanyKeyError) throw err;
    warning = `已儲存，但驗證未能執行：${err.message}`;
  }

  await query('UPDATE companies SET anthropic_key_enc=$2, updated_at=NOW() WHERE id=$1',
    [companyId, encrypt(key)]);
  return { warning };
}

/**
 * 清掉之後這家公司的 AI 會直接跑不起來（buildClaudeAuthEnv 丟 NO_ANTHROPIC_KEY），
 * 不會悄悄改用平台的訂閱——那是刻意的，見 lib/claude-auth.js。
 * 回 false 代表找不到這家公司。
 */
async function clearCompanyAnthropicKey(companyId, deps = {}) {
  const query = deps.query || require('../db').query;
  const { rows } = await query(
    'UPDATE companies SET anthropic_key_enc=NULL, updated_at=NOW() WHERE id=$1 RETURNING id',
    [companyId]
  );
  return rows.length > 0;
}

// 給畫面用：**只回「有沒有設」**，永遠不回 key 也不回密文（與 has_git_pat 同一個理由）。
async function companyKeyConfigured(companyId, deps = {}) {
  const query = deps.query || require('../db').query;
  const { rows } = await query(
    'SELECT (anthropic_key_enc IS NOT NULL AND anthropic_key_enc <> $2) AS configured, is_internal FROM companies WHERE id = $1',
    [companyId, '']
  );
  if (!rows.length) throw new CompanyKeyError(404, '找不到這家公司');
  return { configured: rows[0].configured === true, is_internal: rows[0].is_internal === true };
}

module.exports = { CompanyKeyError, setCompanyAnthropicKey, clearCompanyAnthropicKey, companyKeyConfigured };
