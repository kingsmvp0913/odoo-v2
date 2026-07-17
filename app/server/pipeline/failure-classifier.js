/**
 * failure-classifier.js — 把失敗訊息分類，供 pipeline 各關卡正確歸因（健檢根因 B、U5）
 *
 *   classifyFailure(text, opts?)      → 'transient' | 'env' | 'code' | 'unknown'（純函式，零 token）
 *   classifyFailureWithAgent(text)    → 同上，但 unknown 時叫 deploy-fix agent（haiku）分類；
 *                                        agent 出錯或仍判不出 → 'env'（反轉舉證：判不準就丟人工，不退 coding 空轉）
 *
 * 反轉舉證：只有「明確是開發者寫錯」才判 code 退 coding；env/transient 或任何模糊 → 丟人工。
 * timeout 由呼叫端先攔（不進此分類）。
 */
const { runClaude } = require('./claude-runner');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage } = require('./token-logger');

// 快速、可重試的暫時性失敗（網路抖動、行程被砍、連線重置）
const TRANSIENT = [
  /\bECONNRESET\b/i, /\bETIMEDOUT\b/i, /\bENETUNREACH\b/i, /\bEAI_AGAIN\b/i,
  /socket hang up/i, /could not resolve host/i, /\bkilled\b/i,
  /connection reset/i, /temporarily unavailable/i,
  // Claude API 過載/伺服器錯（"API Error: 529 {...overloaded_error...}"、"API Error: 500 ..."）——
  // 等幾秒重試幾乎必過，卻是 agent 關卡實際最常見的失敗字面；不收就落 unknown 直接停等人工（健檢 R1）
  /\boverloaded\b/i, /API Error:? 5\d\d/i
];

// 環境/基礎設施問題（非模組程式碼）——不該退 coding。
// 注意：pattern 要精確，避免誤傷 code traceback。故不用 /ImportError/（開發者錯 import 是 code，
// 缺套件由 ModuleNotFoundError/No module named 覆蓋）、不用 /venv/（Odoo traceback 路徑常含 venv 目錄）。
const ENV = [
  /could not connect to server/i, /connection refused/i, /\bECONNREFUSED\b/i,
  /ModuleNotFoundError/i, /No module named/i,
  // 模組有宣告 external_dependencies 但環境缺該套件時 Odoo 的字面（"an external dependency is not
  // met: Python library not installed: xlsxtpl"）——鐵板釘釘的缺件，別讓它落到 unknown 交 haiku 猜（健檢 F1）
  /external dependency is not met/i, /Python library not installed/i,
  /Permission denied/i, /PermissionError/i,
  /Address already in use/i, /port .* in use/i,
  /database .* does not exist/i, /no space left on device/i,
  /測試環境無法啟動/, /環境尚未建立/,
  // Odoo 安裝時相依模組不在 addons path（"depends on module X. But the latter module is not
  // available in your system."）＝部署環境缺模組，非本任務程式碼可修——鐵板釘釘的 env，
  // 不可交 haiku agent 猜（實測 agent 會因「depends 寫在 manifest」誤判成 code、退 coding 空轉，task 84）。
  /not available in your system/i
];

// 模組程式碼錯誤——退 coding 修。反轉舉證：只收「明確是開發者寫錯」的特徵，
// 刻意不收 /Traceback/、/odoo\.(exceptions|tools)/、/ValidationError/——每個 env 失敗也都會印這些
//（Odoo 一律把錯誤包成 traceback＋exception），留著等於全包網，會把環境問題（如缺依賴的
// UserError「depends on module ... not available」）誤判成 code、退 coding 空轉（task 84 震盪根因）。
const CODE = [
  /ParseError/i, /XMLSyntaxError/i, /SyntaxError/i, /IndentationError/i,
  /Invalid field/i, /Invalid view/i, /does not exist on model/i,
  /Field .* does not exist/i,
  /cannot import name/i // 模組在、名稱不對＝開發者寫錯 import（有別於缺套件的 ModuleNotFoundError）
];

function matchAny(patterns, s) {
  return patterns.some(re => re.test(s));
}

function classifyFailure(text, opts = {}) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return 'unknown';
  // timeout 不在此分類（重試太貴）：呼叫端依 claudeStat 先處理
  if (opts.claudeStatus === 'timeout') return 'unknown';
  // 先 transient（最該優先自動重試）、再 env（別怪 coding）、最後 code
  if (matchAny(TRANSIENT, s)) return 'transient';
  if (matchAny(ENV, s)) return 'env';
  if (matchAny(CODE, s)) return 'code';
  return 'unknown';
}

const VALID = new Set(['transient', 'env', 'code']);

async function classifyFailureWithAgent(text, opts = {}) {
  const first = classifyFailure(text, opts);
  if (first !== 'unknown') return first;
  // 判不出來才叫 haiku agent 分類（不自動修）；agent 出錯或仍判不出 → 丟人工（env），
  // 不預設退 coding——寧可讓人看一眼，也不要把環境／跨模組問題丟回 coding 空轉。
  // 餵 haiku 的是「真因」而非 log 開頭：Odoo traceback 決定性例外行在結尾，slice(0,2000) 會把它砍掉、
  // 只剩無用的 INFO banner，haiku 只能瞎猜（健檢 F2）。改用 extractOdooError 從尾端抽例外行。
  // lazy require 避免與 deploy-testing 的循環相依（呼叫時該模組已完整載入）。
  const { extractOdooError } = require('./deploy-testing');
  const errText = extractOdooError(text);
  // 判定收斂到單一出口：預設 env（安全側，丟人工），只有 haiku 明確判出合法類別才覆寫。
  let verdict = 'env', agentOk = false;
  try {
    const agent = loadAgent('deploy-fix');
    const { text: out, usage, durationMs } = await runClaude(agent.render({ error_text: errText }), { model: agent.model, agentType: 'deploy_fix' });
    // 分類用的 haiku 也要記帳（成本核算無盲區）；有 context 才記
    if (opts.taskId || opts.projectId) {
      await logTokenUsage({ taskId: opts.taskId, projectId: opts.projectId }, opts.userId, 'deploy_fix', usage, durationMs);
    }
    const m = String(out || '').match(/\{[\s\S]*\}/);
    if (m) {
      const type = JSON.parse(m[0]).type;
      if (VALID.has(type)) { verdict = type; agentOk = true; }
    }
  } catch { /* fall through to safe default env */ }
  // regex 沒涵蓋這個 pattern（才會走到 haiku）→ 留樣本供日後升級成零 token regex（回饋迴圈）。
  await recordClassifySample(errText, verdict, agentOk, opts);
  return verdict;
}

// 把「regex 判不出、交 haiku」的案例（真因文字＋最終判定＋haiku 是否真的判出）留成樣本。
// 用途：定期看高頻 error_text，把復發的補進上方 TRANSIENT/ENV/CODE regex，讓 haiku 呼叫量單調下降。
// 全程 best-effort：記樣本失敗絕不影響分類結果（分類是主線，樣本是副產物）。
async function recordClassifySample(errText, verdict, agentOk, opts) {
  try {
    const { query } = require('../db');
    await query(
      'INSERT INTO classify_samples (task_id, project_id, error_text, verdict, agent_ok) VALUES ($1,$2,$3,$4,$5)',
      [opts.taskId != null ? String(opts.taskId) : null, opts.projectId || null, String(errText).slice(0, 2000), verdict, agentOk]
    );
  } catch { /* 記樣本失敗不阻斷分類 */ }
}

module.exports = { classifyFailure, classifyFailureWithAgent };
