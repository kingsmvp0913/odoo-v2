/**
 * sandbox-signature.js — 「Codex 沙箱起不來」的字面特徵（單一真相）
 *
 * 背景：codex exec 以 `--sandbox read-only` 執行模型產生的 shell 指令，該沙箱需要建立
 * user namespace（Linux 走 bwrap）。平台自身跑在帶 AppArmor 與 seccomp 的 docker 容器內，
 * namespace 建不起來 → agent 的每一次工具呼叫都在啟動沙箱時就失敗、讀不到任何檔案，
 * 只能回覆「查不到」；但 CLI 行程仍以 exit 0 結束，runner 於是無條件 resolve、
 * token-logger 記成 status=completed，整條路徑沒有任何失敗訊號。
 *
 * 比照 auth-signature.js：從輸出文字辨識失敗種類，讓它大聲失敗。沙箱模式本身不在此處理
 * （放寬唯讀保護屬安全決策，須由人裁決），本檔只負責讓「起不來」被看見。
 *
 * 只收沙箱啟動器自己印的字面，刻意不收 /sandbox/、/permission denied/ 等籠統詞——
 * 那些在 agent 正常執行的指令輸出裡也會出現，收了會把成功的執行誤判成失敗。
 */
const SANDBOX_FAIL = [
  /bwrap:[^\n]*namespace/i,
  /kernel does not allow non-privileged user namespaces/i,
  /unprivileged_userns_clone/i,
  /failed to (?:create|start|set up) sandbox/i,
  /sandbox-exec: /,
];

// 回傳命中的那一行（截短供錯誤訊息使用），沒命中回 null。
function sandboxFailureReason(text) {
  const s = String(text == null ? '' : text);
  for (const line of s.split('\n')) {
    if (SANDBOX_FAIL.some(re => re.test(line))) return line.trim().slice(0, 300);
  }
  return null;
}

function looksLikeSandboxFailure(text) {
  return sandboxFailureReason(text) !== null;
}

module.exports = { SANDBOX_FAIL, sandboxFailureReason, looksLikeSandboxFailure };
