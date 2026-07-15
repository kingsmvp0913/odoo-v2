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
  /connection reset/i, /temporarily unavailable/i
];

// 環境/基礎設施問題（非模組程式碼）——不該退 coding。
// 注意：pattern 要精確，避免誤傷 code traceback。故不用 /ImportError/（開發者錯 import 是 code，
// 缺套件由 ModuleNotFoundError/No module named 覆蓋）、不用 /venv/（Odoo traceback 路徑常含 venv 目錄）。
const ENV = [
  /could not connect to server/i, /connection refused/i,
  /ModuleNotFoundError/i, /No module named/i,
  /Permission denied/i, /PermissionError/i,
  /Address already in use/i, /port .* in use/i,
  /database .* does not exist/i, /no space left on device/i,
  /測試環境無法啟動/, /環境尚未建立/
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
  // 不預設退 coding——寧可讓人看一眼，也不要把環境／跨模組問題丟回 coding 空轉
  try {
    const agent = loadAgent('deploy-fix');
    const { text: out, usage, durationMs } = await runClaude(agent.render({ error_text: String(text || '').slice(0, 2000) }), { model: agent.model, agentType: 'deploy_fix' });
    // 分類用的 haiku 也要記帳（成本核算無盲區）；有 context 才記
    if (opts.taskId || opts.projectId) {
      await logTokenUsage({ taskId: opts.taskId, projectId: opts.projectId }, opts.userId, 'deploy_fix', usage, durationMs);
    }
    const m = String(out || '').match(/\{[\s\S]*\}/);
    if (m) {
      const type = JSON.parse(m[0]).type;
      if (VALID.has(type)) return type;
    }
  } catch { /* fall through to safe default */ }
  return 'env';
}

module.exports = { classifyFailure, classifyFailureWithAgent };
