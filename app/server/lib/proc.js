/**
 * lib/proc.js — 子行程回收共用工具
 *
 * 之前 claude-runner（ChildProcess 版）與 env-agent（raw pid 版）各自實作同一套
 * 「SIGTERM → 寬限期 → SIGKILL」邏輯；合併於此，行為與寬限期單一出處。
 *
 * pid 重用防護：pid 存在 DB，app 重啟後 OS 可能把同一 pid 派給無關行程，
 * 盲目 kill 會殺錯人。Linux 上以 /proc/<pid>/stat 的 starttime（開機後 jiffies）
 * 當行程身分指紋：spawn 時記錄、kill 前核對，不符即拒殺。
 * 非 Linux（Windows/macOS）或讀取失敗回 null → 呼叫端 best-effort 放行（維持原行為）。
 */
const fs = require('fs');
const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';

// Windows 沒有真正的 signal：child.kill()／process.kill() 只 TerminateProcess「單一 pid」，
// 殺不到孫程序。claude 子行程用 Bash 工具再開的 find.exe（曾滾成 `find /` 全碟掃描）會因此
// 變孤兒常駐、狂吃 I/O。taskkill /T 連整棵行程樹一起收；/F 強制。best-effort、不阻塞、吞錯。
function killTreeWindows(pid) {
  if (!pid) return;
  try {
    const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    p.on?.('error', () => {}); // taskkill 不在 PATH／pid 已消失：忽略
    p.unref?.();
  } catch { /* spawn 失敗：best-effort 放行 */ }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Linux：/proc/<pid>/stat 第 22 欄（starttime）。comm 欄可含空白括號，從最後一個 ')' 之後切。
function pidStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const starttime = Number(rest[19]); // 去掉 pid、comm 兩欄後，第 22 欄的 index 為 19
    return Number.isFinite(starttime) ? String(starttime) : null;
  } catch { return null; }
}

// raw pid 版：SIGTERM → 輪詢寬限期 → 仍活著補 SIGKILL。
// expectedStart 非 null 且能讀到現值時，不符即拒殺（pid 已被重用）。
async function killPidGracefully(pid, { graceMs = 5000, expectedStart = null } = {}) {
  if (!pid) return;
  if (expectedStart != null) {
    const cur = pidStartTime(pid);
    if (cur != null && String(cur) !== String(expectedStart)) return;
  }
  // Windows：signal 殺不到子孫，直接 taskkill 整棵樹（含 odoo worker、find.exe 等）
  if (isWindows) { killTreeWindows(pid); return; }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise(r => setTimeout(r, 250));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* 寬限期內剛好退出 */ }
}

// ChildProcess 版：依 exit 事件判斷（不輪詢），SIGTERM 後寬限期未退出補 SIGKILL。
// 同步回傳，供事件回呼（timeout/abort handler）內直接呼叫。
function killChildGracefully(child, graceMs = 5000) {
  // Windows：child.kill 只砍 claude 本身，留下它 Bash 出去的 find.exe 當孤兒。taskkill /T 連根收。
  // （Windows 上 SIGTERM 本就等同 TerminateProcess 立即硬殺，改走 taskkill 對 claude 本身無行為差異，
  //  差別只在多帶走整棵子孫樹，故不需保留寬限期。）
  if (isWindows) { killTreeWindows(child?.pid); return; }
  let exited = false;
  child.once?.('exit', () => { exited = true; });
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  const t = setTimeout(() => {
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  }, graceMs);
  if (t.unref) t.unref();
}

module.exports = { processAlive, pidStartTime, killPidGracefully, killChildGracefully };
