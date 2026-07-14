/**
 * project-lock.js — 每專案序列鎖（in-process async mutex）
 *
 * 同一專案的「短的共用變動」（merge 進 testing、deploy 升級、worktree add/remove、
 * analysis 的 checkout+pull、approve 併 main）必須一次一個，避免同時寫壞共用的主 clone
 * 與測試 env／DB。不同專案互不阻擋（併發）。健檢 U7：取代 merge/deploy 各自的私有鎖。
 *
 *   withProjectLock(projectId, fn) → Promise<fn 的結果>
 *
 * 以 Promise 鏈實作：新工作接在該專案鏈尾，前一個不論成功或失敗都接續執行。
 */
const _chains = new Map(); // projectId → 鏈尾 Promise

function withProjectLock(projectId, fn) {
  const prev = _chains.get(projectId) || Promise.resolve();
  const run = prev.then(fn, fn); // 前一個 resolve 或 reject 都接續跑 fn
  // 鏈尾吞掉錯誤，避免一個失敗污染後續排隊者；呼叫端仍從 run 拿到真實結果/錯誤
  const tail = run.then(() => {}, () => {});
  _chains.set(projectId, tail);
  // 鏈尾結清且沒有新工作接上（Map 裡仍是自己）→ 移除，避免 Map 隨專案數緩慢累積
  tail.then(() => { if (_chains.get(projectId) === tail) _chains.delete(projectId); });
  return run;
}

module.exports = { withProjectLock };
