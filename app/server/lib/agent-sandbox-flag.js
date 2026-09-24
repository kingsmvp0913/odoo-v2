// app/server/lib/agent-sandbox-flag.js
/**
 * agent-sandbox-flag.js — AI 容器的資源上限（teams_settings.agent_sandbox_* / agent_gateway_*）
 *
 * **2026-09-24 起這裡沒有「要不要進容器」的開關了**（使用者裁決拿掉舊的非容器路徑）。
 * 本檔原本還管一個 mode（off／internal／projects／all）與專案白名單；那個開關自 09-18 起
 * 就固定在 all，而 all 是無條件全部進容器，所以舊路徑早已跑不到。留著開關的代價不是效能，
 * 是它讓「撥回 off 就能繞過隔離」一直是可能的——而那條路用平台訂閱跑客戶的 AI，不會報錯，
 * 只會出現在月底帳單上。
 *
 * ⚠ DB 欄位 `agent_sandbox_mode`／`agent_sandbox_project_ids` 刻意留著不刪（刪欄位要 migration
 * 而換不到任何行為），但**程式已經完全不讀它們**。有人手動改那兩欄不會有任何效果——
 * 這正是要的：沒有後門。
 *
 * 讀取端同步；非同步只發生在啟動載入與管理員存檔，比照 lib/claude-auth.js。
 */
const { query } = require('../db');

const EMPTY_LIMITS = Object.freeze({ memory: null, cpus: null, pids: null });

let _state = { limits: EMPTY_LIMITS, gatewayLimits: EMPTY_LIMITS, changedAt: null };

async function loadAgentSandboxFlag() {
  try {
    const { rows: [r] } = await query(
      `SELECT agent_sandbox_memory, agent_sandbox_cpus, agent_sandbox_pids,
              agent_gateway_memory, agent_gateway_cpus, agent_gateway_pids, agent_sandbox_changed_at
         FROM teams_settings WHERE id = 1`);
    _state = {
      limits: { memory: (r && r.agent_sandbox_memory) ?? null, cpus: (r && r.agent_sandbox_cpus) ?? null, pids: (r && r.agent_sandbox_pids) ?? null },
      gatewayLimits: { memory: (r && r.agent_gateway_memory) ?? null, cpus: (r && r.agent_gateway_cpus) ?? null, pids: (r && r.agent_gateway_pids) ?? null },
      changedAt: (r && r.agent_sandbox_changed_at) ?? null,
    };
  } catch (err) {
    // 讀不到就維持上一份（啟動時即為空）。上限缺值由 lib/agent-sandbox.js 自己硬擋——
    // 那裡規定資源上限必填，不會因為這裡讀失敗就開出一個沒有上限的容器。
    console.error('[AGENT-SANDBOX] 讀取資源上限失敗，沿用上一份：', err.message);
  }
}

function getSandboxLimits() { return { ..._state.limits }; }
function getGatewayLimits() { return { ..._state.gatewayLimits }; }
function getFlagState() { return { limits: getSandboxLimits(), gatewayLimits: getGatewayLimits(), changedAt: _state.changedAt }; }

function bad(msg) { return Object.assign(new Error(msg), { statusCode: 400 }); }

function validateFlagInput(body = {}) {
  const mem = v => { if (v == null || v === '') return null; if (!/^[1-9]\d*[mg]$/.test(String(v))) throw bad('記憶體上限格式為數字＋m 或 g（例：4g）'); return String(v); };
  const cpu = v => { if (v == null || v === '') return null; if (!/^\d+(\.\d+)?$/.test(String(v)) || Number(v) <= 0) throw bad('cpus 必須是正數'); return String(v); };
  const pid = v => { if (v == null || v === '') return null; if (!Number.isInteger(v) || v < 32 || v > 65536) throw bad('pids 必須是 32–65536 的整數'); return v; };
  return {
    memory: mem(body.memory), cpus: cpu(body.cpus), pids: pid(body.pids),
    gwMemory: mem(body.gateway_memory), gwCpus: cpu(body.gateway_cpus), gwPids: pid(body.gateway_pids),
  };
}

function _setFlagStateForTesting(partial) {
  _state = { limits: EMPTY_LIMITS, gatewayLimits: EMPTY_LIMITS, changedAt: null, ...partial };
}

module.exports = {
  loadAgentSandboxFlag, getSandboxLimits, getGatewayLimits,
  getFlagState, validateFlagInput, _setFlagStateForTesting,
};
