// 意圖：三個「回程狀態」欄位（resume_status／respec_return_status／merge_conflict_data.prior_status）
// 都直接當 tasks.status 寫回，而 runner.js 的派工查表是 `if (!handler) return;`——認不得的 status
// 不報錯、不 log，任務就變成「撈得到卻永遠不被派工」的殭屍：畫面顯示看不懂的狀態，cron 每分鐘掃過
// 又跳過，零訊號。這支釘住「非法值一律收斂成安全預設，不進狀態機」。
const { safeReturnStatus, RETURNABLE_STATUSES } = require('../pipeline/stations');

test('認得的站原樣通過', () => {
  expect(safeReturnStatus('qa_running')).toBe('qa_running');
  expect(safeReturnStatus('deploy_testing')).toBe('deploy_testing');
  expect(safeReturnStatus('review_pending')).toBe('review_pending');
});

// 這些值真的出現得了：resume_status 由 runner 用「當下 status」無條件覆寫，欄位是 TEXT 無約束；
// prior_status 存在 JSON 欄位裡，任何寫入點打錯字都不會有人發現。
test.each([
  ['null', null],
  ['undefined', undefined],
  ['空字串', ''],
  ['純空白', '   '],
  ['打錯字', 'qa_runing'],
  ['大小寫不符', 'QA_RUNNING'],
  ['已被移除的舊狀態', 'deploy_pending'],
  ['非狀態字串', '{"foo":1}'],
  ['數字', 123],
])('%s → 落回安全預設，不進狀態機', (_name, v) => {
  expect(safeReturnStatus(v)).toBe('coding_running');
});

test('呼叫端可指定自己的安全預設（merge 衝突裁決回原關）', () => {
  expect(safeReturnStatus('壞掉的值', 'deploy_testing')).toBe('deploy_testing');
  expect(safeReturnStatus(null, 'analysis_running')).toBe('analysis_running');
});

// 終點與 pipeline 之外的狀態不在值域內：回到 done/stopped 沒有意義，clarify_* 是閘門本身。
test.each(['done', 'stopped', 'clarify_pending', 'clarify_answered'])(
  '%s 不得作為回程目標', (s) => {
    expect(RETURNABLE_STATUSES.has(s)).toBe(false);
    expect(safeReturnStatus(s)).toBe('coding_running');
  }
);

// ⚠️ 這三個是**中繼關**，語意與上面那組完全不同，不要因為「它們也不在白名單裡」就以為行為相同。
// RETURNABLE_STATUSES 的語意是「pipeline 各關的回程」，中繼關不屬於它——但中繼關有自己的回程需求，
// 由**呼叫端豁免**，不是由這裡放行：
//   - reject_triage／resolve_triage：分診判 clarify 時，答完要回分診續判
//     → runner.js handleClarifyAnswered 用 TRIAGE_RESUME 豁免（測試在 runner.test.js）
//   - respec_running：respec 途中失敗後解除阻塞，要回 respec_return_status 記的那一關
//     → reject-triage.js 算 home 時先還原（測試在 reject-triage.test.js）
// 曾經只有這支測試、沒有那兩處豁免，於是「分診 clarify 往返整條斷掉」被這裡的綠燈釘死、
// 沒有任何測試會紅。留這段註解是為了讓下一個人知道要去哪裡找配套。
test.each(['reject_triage', 'resolve_triage', 'respec_running'])(
  '%s 不在 pipeline 回程白名單內（其回程由呼叫端豁免，見上方註解）', (s) => {
    expect(RETURNABLE_STATUSES.has(s)).toBe(false);
    expect(safeReturnStatus(s)).toBe('coding_running');
  }
);

// 防漂移：值域內的每一個站都必須真的有 handler 能跑它，否則收斂後照樣是殭屍。
// review_pending 是唯一例外——它是「等人審核」的站，本來就沒有 handler。
test('值域內的站都跑得動（review_pending 除外）', () => {
  const { RUNNABLE_STATUSES } = require('../pipeline/runner');
  expect(Array.isArray(RUNNABLE_STATUSES)).toBe(true);   // 真的拿到 runner 的那一份，不是抄本
  for (const s of RETURNABLE_STATUSES) {
    if (s === 'review_pending') continue;               // 等人審核的站，本來就沒有 handler
    expect(RUNNABLE_STATUSES).toContain(s);
  }
});
