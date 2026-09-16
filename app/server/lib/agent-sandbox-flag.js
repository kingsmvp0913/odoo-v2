// app/server/lib/agent-sandbox-flag.js
/**
 * agent-sandbox-flag.js — AI 容器隔離的開關（teams_settings.agent_sandbox_*）
 *
 * 讀取端同步（runClaude 在 off 時必須同步 spawn，rules/testing 26）；非同步只發生在啟動載入與管理員存檔，
 * 比照 lib/claude-auth.js。模組預設 off 只為了測試不經載入時維持舊行為；正式啟動一定會 load。
 * 讀 DB 失敗 → all（最嚴格）：寧可 AI 全部因容器不可用而停下，也不要靜默跑回沒有隔離的路徑。
 */
const { query } = require('../db');
const { isInternalProfile } = require('./agent-profiles');

const MODES = new Set(['off', 'internal', 'projects', 'all']);
const EMPTY_LIMITS = Object.freeze({ memory: null, cpus: null, pids: null });

let _state = { mode: 'off', projectIds: new Set(), limits: EMPTY_LIMITS, gatewayLimits: EMPTY_LIMITS, changedAt: null };

function normalizeMode(v) { return MODES.has(v) ? v : 'all'; }

function parseProjectIds(text) {
  const out = new Set();
  for (const s of String(text || '').split(',')) {
    const t = s.trim();
    if (/^[1-9]\d*$/.test(t)) out.add(Number(t));
  }
  return out;
}

async function loadAgentSandboxFlag() {
  try {
    const { rows: [r] } = await query(
      `SELECT agent_sandbox_mode, agent_sandbox_project_ids, agent_sandbox_memory, agent_sandbox_cpus, agent_sandbox_pids,
              agent_gateway_memory, agent_gateway_cpus, agent_gateway_pids, agent_sandbox_changed_at
         FROM teams_settings WHERE id = 1`);
    _state = {
      mode: normalizeMode(r ? (r.agent_sandbox_mode ?? 'off') : 'off'),
      projectIds: parseProjectIds(r && r.agent_sandbox_project_ids),
      limits: { memory: (r && r.agent_sandbox_memory) ?? null, cpus: (r && r.agent_sandbox_cpus) ?? null, pids: (r && r.agent_sandbox_pids) ?? null },
      gatewayLimits: { memory: (r && r.agent_gateway_memory) ?? null, cpus: (r && r.agent_gateway_cpus) ?? null, pids: (r && r.agent_gateway_pids) ?? null },
      changedAt: (r && r.agent_sandbox_changed_at) ?? null,
    };
  } catch (err) {
    console.error('[AGENT-SANDBOX] 讀取開關失敗，改為最嚴格（all）：', err.message);
    _state = { ..._state, mode: 'all' };
  }
}

function getSandboxMode() { return _state.mode; }
function getSandboxLimits() { return { ..._state.limits }; }
function getGatewayLimits() { return { ..._state.gatewayLimits }; }
function getFlagState() { return { mode: _state.mode, projectIds: [..._state.projectIds], limits: getSandboxLimits(), gatewayLimits: getGatewayLimits(), changedAt: _state.changedAt }; }

function sandboxAppliesTo(profile, projectId) {
  const m = _state.mode;
  if (m === 'off') return false;
  if (m === 'all') return true;
  if (isInternalProfile(profile)) return true;
  if (m === 'projects') return projectId != null && _state.projectIds.has(Number(projectId));
  return false;
}

function bad(msg) { return Object.assign(new Error(msg), { statusCode: 400 }); }

function validateFlagInput(body = {}) {
  if (!MODES.has(body.mode)) throw bad(`mode 必須是 ${[...MODES].join(' / ')}`);
  const ids = body.project_ids == null ? [] : body.project_ids;
  if (!Array.isArray(ids) || ids.some(x => !Number.isInteger(x) || x <= 0)) throw bad('project_ids 必須是正整數陣列');
  const mem = v => { if (v == null || v === '') return null; if (!/^[1-9]\d*[mg]$/.test(String(v))) throw bad('記憶體上限格式為數字＋m 或 g（例：4g）'); return String(v); };
  const cpu = v => { if (v == null || v === '') return null; if (!/^\d+(\.\d+)?$/.test(String(v)) || Number(v) <= 0) throw bad('cpus 必須是正數'); return String(v); };
  const pid = v => { if (v == null || v === '') return null; if (!Number.isInteger(v) || v < 32 || v > 65536) throw bad('pids 必須是 32–65536 的整數'); return v; };
  return {
    mode: body.mode, projectIds: ids,
    memory: mem(body.memory), cpus: cpu(body.cpus), pids: pid(body.pids),
    gwMemory: mem(body.gateway_memory), gwCpus: cpu(body.gateway_cpus), gwPids: pid(body.gateway_pids),
  };
}

function _setFlagStateForTesting(partial) {
  _state = { mode: 'off', projectIds: new Set(), limits: EMPTY_LIMITS, gatewayLimits: EMPTY_LIMITS, changedAt: null, ...partial };
}

module.exports = {
  MODES, normalizeMode, parseProjectIds, loadAgentSandboxFlag, getSandboxMode, getSandboxLimits, getGatewayLimits,
  getFlagState, sandboxAppliesTo, validateFlagInput, _setFlagStateForTesting,
};
