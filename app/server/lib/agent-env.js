// app/server/lib/agent-env.js
/**
 * agent-env.js — 不進容器的 AI 子行程（考試系統、Codex）的 env 白名單（子專案 0 §4.6、計畫 X2）
 * 只留執行 CLI 需要的系統變數；GIT_CONFIG_* 保留，因為那是第 1 部 Task 1.12 的 hook 加固。
 * 同 uid 讀 data/config.json 的風險仍在（規格 §10），這裡只保證 env 裡沒有三把鑰匙。
 */
const LEGACY_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'CODEX_HOME', 'XDG_CONFIG_HOME'];
const GIT_CONFIG_RE = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

function pickLegacyEnv(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) {
    if (v == null) continue;
    if (LEGACY_ENV_KEYS.includes(k) || GIT_CONFIG_RE.test(k)) out[k] = v;
  }
  return out;
}

module.exports = { LEGACY_ENV_KEYS, pickLegacyEnv };
