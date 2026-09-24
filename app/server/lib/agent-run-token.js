// app/server/lib/agent-run-token.js
/**
 * agent-run-token.js — 容器內 AI 打 /ai 用的「每次執行通行證」（子專案 0 §4.4）
 *
 * 格式：v1.<runId>.<scope>.<projectId|0>.<exp>.<hmac>
 * 金鑰：HMAC(APP_SECRET, RUN_TOKEN_LABEL)——比照 ai-token.js 不直接拿 APP_SECRET 簽，外洩賠不到它。
 * 執行中清單在記憶體：執行結束立刻作廢；平台重啟＝全部失效（容器也會在啟動時被清掉，見 agent-orphans）。
 */
const crypto = require('crypto');
const { endpointsFor, scopeKind } = require('./agent-profiles');

const RUN_TOKEN_LABEL = 'aidev:agent-run:v1';
const _runs = new Map(); // runId → { scope, projectId, exp }

function runKey() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET 未設定，無法簽發 AI 執行通行證');
  return crypto.createHmac('sha256', secret).update(RUN_TOKEN_LABEL).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', runKey()).update(payload).digest('hex');
}

function checkScopeProject(scope, projectId) {
  const kind = scopeKind(scope);
  if (kind === 'project') {
    if (Number(projectId) !== Number(scope.slice('project-'.length))) throw new Error(`scope ${scope} 與 projectId ${projectId} 不一致`);
  } else if (projectId != null) {
    throw new Error(`scope ${scope} 不可帶 projectId`);
  }
}

function issueRunToken({ scope, projectId, ttlMs, now = Date.now() }) {
  checkScopeProject(scope, projectId);
  const runId = crypto.randomBytes(8).toString('hex');
  const exp = now + ttlMs;
  const payload = `v1.${runId}.${scope}.${projectId == null ? 0 : Number(projectId)}.${exp}`;
  const token = `${payload}.${sign(payload)}`;
  _runs.set(runId, { scope, projectId: projectId == null ? null : Number(projectId), exp });
  return { runId, token, exp };
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyRunToken(token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') return { ok: false, reason: '通行證格式不正確' };
  const [, runId, scope, pid, expStr, mac] = parts;
  let expected;
  try { expected = sign(parts.slice(0, 5).join('.')); } catch (e) { return { ok: false, reason: e.message }; }
  if (!timingSafeEqualHex(mac, expected)) return { ok: false, reason: '通行證簽章不符' };
  const run = _runs.get(runId);
  if (!run) return { ok: false, reason: '通行證已作廢或不在執行中（執行結束／平台重啟）' };
  const projectId = Number(pid) === 0 ? null : Number(pid);
  if (run.scope !== scope || run.projectId !== projectId || String(run.exp) !== expStr) {
    return { ok: false, reason: '通行證內容與執行中紀錄不符' };
  }
  if (now > run.exp) return { ok: false, reason: '通行證已過期' };
  return { ok: true, run: { runId, scope, projectId, endpoints: endpointsFor(scope) } };
}

function revokeRun(runId) { _runs.delete(runId); }
function activeRunCount() { return _runs.size; }

// 檢查點（§4.4）：公司停用或不在使用期間就不發通行證、不開容器。
// 子專案 2 之後會在同一個地方再接「公司已設 key、未超花費上限」。
// 內部工作（健檢、夜間改善）沒有發起人，actorUserId 是 null ⇒ 照跑。
// ⚠ require 寫在函式內是刻意的——tenant-access 會 require('../db')，模組層互相引用容易在測試環境形成載入順序問題。
// ✅ 2026-09-24：這裡原本記著一個結構性缺口——canRun 只有一個呼叫端（sandbox-run.js 的
// prepareSandboxRun），所以任何跳過它的路徑，這道「公司還能不能用」的檢查就完全不會跑。
// 當時有兩條這樣的路：agent_sandbox_mode='off' 會直接同步 spawn('claude')，連
// resolveSandboxPlan 都不呼叫；mode='projects'／'internal' 不涵蓋時 resolveSandboxPlan 回
// null，同樣繞過去。註解當時寫「正式環境剛好開 all 所以擋得到，但那是運氣不是結構」。
//
// 舊的非容器路徑已經整個拿掉（使用者裁決 3.11），mode 也不存在了：prepareSandboxRun
// **是唯一的執行路徑**，這道檢查因此從「剛好會跑到」變成「一定會跑到」。缺口結案。
async function canRun(_scope, actorUserId) {
  return require('./tenant-access').isUserCompanyUsable(actorUserId);
}

function _resetRunsForTesting() { _runs.clear(); }

module.exports = { RUN_TOKEN_LABEL, issueRunToken, verifyRunToken, revokeRun, activeRunCount, canRun, _resetRunsForTesting };
