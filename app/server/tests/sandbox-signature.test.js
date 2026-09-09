const { sandboxFailureReason, looksLikeSandboxFailure } = require('../pipeline/sandbox-signature');

// 實測字面（容器內 codex exec --sandbox read-only 的 command_execution aggregated_output）
const REAL_BWRAP = "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. On e.g. debian this can be enabled with 'sysctl kernel.unprivileged_userns_clone=1'.";

test('沙箱啟動失敗：認得實測字面，並回傳可讀的那一行', () => {
  expect(looksLikeSandboxFailure(`some output\n${REAL_BWRAP}\n`)).toBe(true);
  expect(sandboxFailureReason(`some output\n${REAL_BWRAP}\n`)).toContain('No permissions to create a new namespace');
});

test('沙箱啟動失敗：macOS seatbelt 與泛用啟動失敗字面亦認得', () => {
  expect(looksLikeSandboxFailure('sandbox-exec: execvp() of ... failed')).toBe(true);
  expect(looksLikeSandboxFailure('Error: failed to create sandbox')).toBe(true);
});

// 這些字串在 agent 正常執行的指令輸出裡也會出現；收了會把成功的執行誤判成失敗，
// 而「沙箱起不來」的處置是丟人工，誤判的代價是把好的結果丟掉。
test('沙箱啟動失敗：籠統詞不得命中（否則正常執行會被誤判成失敗）', () => {
  for (const s of [
    '', 'sandbox', 'running in a sandbox', 'Permission denied',
    'read-only file system', 'the sandbox is read-only',
    '--sandbox read-only', 'namespace odoo.addons'
  ]) expect(looksLikeSandboxFailure(s)).toBe(false);
  expect(sandboxFailureReason(null)).toBeNull();
});
