// app/server/lib/ref-guard.js
/**
 * ref-guard.js — AI 容器執行前後比對任務主 clone 的 refs（子專案 0 Q4，09-15 裁決必做）
 * 容器寫得到 .git（commit 必要），也就寫得到 testing／main 指標；除本任務分支外任何變動都還原並判該輪失敗。
 */
const { execFile: realExecFile } = require('child_process');

function git(execFile, cwd, args) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60000 }, (err, out) => (err ? reject(err) : resolve(String(out || '')))));
}

async function snapshotRefs(repoPath, deps = {}) {
  const out = await git(deps.execFile || realExecFile, repoPath, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const m = new Map();
  for (const line of out.split('\n')) { const [ref, sha] = line.trim().split(' '); if (ref && sha) m.set(ref, sha); }
  return m;
}

function diffRefs(before, after, allowed) {
  const out = [];
  for (const ref of new Set([...before.keys(), ...after.keys()])) {
    if (allowed.has(ref)) continue;
    const b = before.get(ref) || null; const a = after.get(ref) || null;
    if (b !== a) out.push({ ref, before: b, after: a });
  }
  return out;
}

async function restoreRefs(repoPath, violations, deps = {}) {
  const execFile = deps.execFile || realExecFile;
  for (const v of violations) {
    if (v.before) await git(execFile, repoPath, ['update-ref', v.ref, v.before]);
    else await git(execFile, repoPath, ['update-ref', '-d', v.ref]);
  }
}

module.exports = { snapshotRefs, diffRefs, restoreRefs };
