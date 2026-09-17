// app/server/lib/git-hardening.js
/**
 * git-hardening.js — 平台自己跑的 git 一律不執行 hooks、不跑 fsmonitor（子專案 0 §4.2 雙保險）
 * 走 GIT_CONFIG_COUNT/KEY_n/VALUE_n（git 2.31+ 官方機制），啟動時注入 process.env，所有 git 子行程繼承。
 */
const HARDEN_PAIRS = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false']];

function hardenGitEnv(env) {
  const out = { ...env };
  let n = parseInt(out.GIT_CONFIG_COUNT || '0', 10) || 0;
  const has = (k, v) => { for (let i = 0; i < n; i++) if (out[`GIT_CONFIG_KEY_${i}`] === k && out[`GIT_CONFIG_VALUE_${i}`] === v) return true; return false; };
  for (const [k, v] of HARDEN_PAIRS) {
    if (has(k, v)) continue;
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

module.exports = { HARDEN_PAIRS, hardenGitEnv };
