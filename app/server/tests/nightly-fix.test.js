// nightly-fix.js 是意見回饋通道的核心編排器：把「approved 的候選」變成「合併進 master 的碼」。
// 這支釘住每一道守門：候選篩選、統整後才套上限、測試沒過不採用、審查 reject 重跑一次、
// cli_push_user_id 為空停在 adopted、兩道保險絲開跑前檢查、標 done（否則每晚重做同一批）、
// 序號不撞號、逐條失敗不炸整批、drain-timeout／拋錯都清旗標、清旗標排在重啟之前。
//
// ⚠ 時間一律走注入時鐘（`_setClockForTesting`）。這支的保險絲是「跑到台北 02:00 為止」，
// 用真實 Date.now() 寫測試的話，00:00–01:59 那兩小時綠、其餘時段紅——本 repo 的 cron.test.js
// 剛因為同一個病紅過。每一支都自己設時鐘，不依賴跑測試的當下幾點。
jest.mock('../pipeline/runner', () => ({ getInflightInfo: jest.fn(() => []) }));
jest.mock('../pipeline/feedback-triage', () => ({
  triageOne: jest.fn(),
  mergeCandidates: jest.fn(),
}));
jest.mock('../pipeline/fix-review', () => ({ reviewFix: jest.fn() }));
jest.mock('../pipeline/finding-fix', () => ({
  runFix: jest.fn(),
  adoptFix: jest.fn(),
  applyFix: jest.fn(),
  selfContainerName: jest.fn(async () => 'odoo-v2'),
}));
// execFile 的 promisify 版依呼叫方式走 (cmd, args, cb) 或 (cmd, args, opts, cb)：callback 一律是最後一個參數
const mockExecFile = jest.fn((...args) => { const cb = args[args.length - 1]; cb(null, { stdout: '', stderr: '' }); });
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));

const { newDb } = require('pg-mem');
const { getInflightInfo } = require('../pipeline/runner');
const { triageOne, mergeCandidates } = require('../pipeline/feedback-triage');
const { reviewFix } = require('../pipeline/fix-review');
const { runFix, adoptFix, applyFix, selfContainerName } = require('../pipeline/finding-fix');

let dbModule, nightlyFix, maintenance, userId;

// 假時鐘：批次起點固定在台北 23:00（＝健檢跑完接著啟動的真實時機，deadline 是 3 小時後的 02:00）。
// 用 2020 年的固定日期，讓「token_usage 的 recorded_at（真實 NOW()）落在批次起點之後」恆成立。
const BASE_ISO = '2020-01-01T15:00:00Z';       // = 台北 2020-01-01 23:00
let clockMs;
const setClock = (iso) => { clockMs = new Date(iso).getTime(); };
const advanceClock = (ms) => { clockMs += ms; };

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
  nightlyFix = require('../pipeline/nightly-fix');
  maintenance = require('../pipeline/maintenance');
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('nightly','x','夜班') RETURNING id"
  );
  userId = u.id;
});

afterAll(() => {
  nightlyFix._setClockForTesting(null);
  dbModule._setPoolForTesting(null);
});

beforeEach(async () => {
  jest.clearAllMocks();
  getInflightInfo.mockReturnValue([]);
  selfContainerName.mockResolvedValue('odoo-v2');
  mockExecFile.mockImplementation((...args) => { const cb = args[args.length - 1]; cb(null, { stdout: '', stderr: '' }); });
  setClock(BASE_ISO);
  nightlyFix._setClockForTesting(() => new Date(clockMs));
  await maintenance.leaveMaintenance();
  await dbModule.query('DELETE FROM finding_fixes');
  await dbModule.query('DELETE FROM health_check_findings');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query('DELETE FROM feedback');
  await dbModule.query('DELETE FROM token_usage');
  await dbModule.query('UPDATE teams_settings SET cli_push_user_id = $1 WHERE id=1', [userId]);
});

// --- fixtures ---

async function insertFeedback({ status = 'approved', content = '意見內容' } = {}) {
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO feedback (user_id, content, status) VALUES ($1,$2,$3) RETURNING id`,
    [userId, content, status]
  );
  return f.id;
}

async function insertHealthProposal({
  status = 'approved', layer = 'code', severity = 'medium', kind = 'proposal', label = '標題',
} = {}) {
  const { rows: [run] } = await dbModule.query(`INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id`);
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, layer, status)
     VALUES ($1,'health-auditor',$2,'診斷內容',$3,$4,$5,$6) RETURNING id`,
    [run.id, label, severity, kind, layer, status]
  );
  return f.id;
}

// triageOne 預設：把 feedback 的 layer 填成指定值並標可理解
function stubTriage(layer = 'code', understandable = true) {
  triageOne.mockImplementation(async (feedbackId) => {
    if (!understandable) return { ok: true, understandable: false };
    await dbModule.query(
      `UPDATE feedback SET triage_title='翻譯後標題', triage_detail='翻譯後描述',
              triage_layer=$2, triage_action='建議修法', verify_route='#/tasks' WHERE id=$1`,
      [feedbackId, layer]
    );
    return { ok: true, understandable: true };
  });
}

// 一組一筆：把每個候選各自成一組（不合併）
const oneGroupEach = async (items) => items.map(it => ({
  member_ids: [it.id], title: it.title, detail: it.detail,
  action: '修法', layer: 'code', verify_route: '',
}));

// runFix 成功（測試沒有新增紅燈）→ 該筆 finding_fixes 進 ready
const runFixReady = async (fixId) => {
  await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
};

// 一路綠燈的快樂路徑
function stubHappyPath() {
  mergeCandidates.mockImplementation(oneGroupEach);
  runFix.mockImplementation(runFixReady);
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });
  applyFix.mockResolvedValue({ merged: true, restarted: false });
}

const restartCalls = () =>
  mockExecFile.mock.calls.filter(c => c[0] === 'docker' && c[1] && c[1][0] === 'restart');

// --- 候選篩選 ---

test('候選篩選：健檢 low 不入選／medium 入選／layer=env 不入選；意見回饋不受 severity 影響', async () => {
  // fixture 交錯放。⚠ 兩張表各自 SERIAL、id 會撞號，所以斷言用 source+序號的複合資訊，
  // 不能只比對數字（否則證明不了條件真的生效）。
  const low = await insertHealthProposal({ severity: 'low', label: 'low的' });
  await insertHealthProposal({ severity: 'medium', label: 'medium的' });
  const envLayer = await insertHealthProposal({ layer: 'env', severity: 'high', label: 'env的' });
  await insertFeedback();       // 意見沒有 severity 這個概念，要能入選

  stubTriage('code');
  stubHappyPath();
  mergeCandidates.mockImplementation(async (items) => {
    const titles = items.map(it => `${it.source}:${it.title}`);
    expect(titles).toEqual(expect.arrayContaining(['finding:medium的', 'feedback:翻譯後標題']));
    expect(titles).not.toContain('finding:low的');
    expect(titles).not.toContain('finding:env的');
    expect(items.length).toBe(2);            // 只有這兩筆，不多不少
    // 送出去的 id 是批次內序號，不是資料表主鍵
    expect(items.map(it => it.id)).toEqual([1, 2]);
    return oneGroupEach(items);
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(mergeCandidates).toHaveBeenCalled();  // 正向錨：確定真的走到統整這一步
  expect(result.attempted).toBe(2);
  // 被篩掉的兩筆留在原地不動狀態（逐筆查：pg-mem 對 SERIAL 主鍵的 `= ANY($1)` 查不到列，
  // 見 rules/testing.md #12——用它會全部回空、變成恆真的假綠）
  for (const id of [low, envLayer]) {
    const { rows: [r] } = await dbModule.query('SELECT status FROM health_check_findings WHERE id=$1', [id]);
    expect(r.status).toBe('approved');
  }
});

test('候選篩選：status 非 approved／kind 非 proposal 的健檢列不入選', async () => {
  await insertHealthProposal({ status: 'pending', severity: 'high', label: '還沒核准' });
  await insertHealthProposal({ status: 'done', severity: 'high', label: '已處理' });
  await insertHealthProposal({ kind: 'signal', severity: 'high', label: '候選訊號' });
  await insertHealthProposal({ severity: 'high', label: '唯一該入選的' });
  stubHappyPath();
  mergeCandidates.mockImplementation(async (items) => {
    expect(items.map(it => it.title)).toEqual(['唯一該入選的']);
    return oneGroupEach(items);
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });
  expect(mergeCandidates).toHaveBeenCalled();
  expect(result.attempted).toBe(1);
});

test('候選篩選：意見回饋 status 非 approved 不入選（連 triage 都不該跑，那是要花錢的）', async () => {
  await insertFeedback({ status: 'new' });
  await insertFeedback({ status: 'rejected' });
  await insertFeedback({ status: 'done' });
  stubTriage('code');
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(triageOne).not.toHaveBeenCalled();
  expect(result.attempted).toBe(0);
});

test('triage 回 understandable:false → 剔除，不進統整', async () => {
  await insertFeedback();
  stubTriage('code', false);
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(triageOne).toHaveBeenCalled();       // 正向錨：真的跑了 triage
  expect(mergeCandidates).not.toHaveBeenCalled();
  expect(result.attempted).toBe(0);
});

test('triage 之後 layer=env → 立即退場（status=new＋triage_note），不是留在原地不動', async () => {
  const fbId = await insertFeedback();
  stubTriage('env');
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(triageOne).toHaveBeenCalled();
  expect(mergeCandidates).not.toHaveBeenCalled();
  expect(result.attempted).toBe(0);
  // layer=env 是確定性結果（同一份原文不會突然變 code），一次就退場，不佔用重試額度、
  // 不是靜靜留在 approved 不動——那樣使用者端會永遠停在「已核准」卻什麼都不會發生。
  const { rows: [fb] } = await dbModule.query(
    'SELECT status, triage_note, fix_attempts FROM feedback WHERE id=$1', [fbId]);
  expect(fb.status).toBe('new');
  expect(fb.fix_attempts).toBe(0);
  expect(fb.triage_note).toContain('layer=env');
});

test('triage 之後 layer=env → 連跑三晚只付一次 triage 的錢（退場後不再是候選）', async () => {
  await insertFeedback();
  stubTriage('env');
  stubHappyPath();

  await nightlyFix.runNightlyFix({ startedBy: userId });          // 第一晚：立即退場
  jest.clearAllMocks();
  stubTriage('env');
  stubHappyPath();
  await nightlyFix.runNightlyFix({ startedBy: userId });          // 第二晚
  jest.clearAllMocks();
  stubTriage('env');
  stubHappyPath();
  const third = await nightlyFix.runNightlyFix({ startedBy: userId });   // 第三晚

  // 退場後 status='new'，不再是 fetchApprovedFeedback 的候選（該函式只撈 status='approved'）
  expect(triageOne).not.toHaveBeenCalled();
  expect(third.attempted).toBe(0);
});

test('意見回饋撞號不會被誤認成健檢提案：兩張表各自 SERIAL，靠批次序號分辨', async () => {
  // 明確指定同一個 id 造出撞號（正式庫裡兩張表各自 SERIAL，撞號是常態而非邊緣case；
  // 這裡不能靠「剛好都是 1」——前面的測試已經把兩條序列推到不同位置）
  const COLLIDING_ID = 777;
  const { rows: [fbRow] } = await dbModule.query(
    `INSERT INTO feedback (id, user_id, content, status) VALUES ($1,$2,'意見內容','approved') RETURNING id`,
    [COLLIDING_ID, userId]);
  const { rows: [run] } = await dbModule.query(`INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id`);
  const { rows: [hcfRow] } = await dbModule.query(
    `INSERT INTO health_check_findings (id, run_id, agent_name, agent_label, diagnosis, severity, kind, layer, status)
     VALUES ($1,$2,'health-auditor','健檢的','診斷內容','high','proposal','code','approved') RETURNING id`,
    [COLLIDING_ID, run.id]);
  const fbId = fbRow.id;
  const findingId = hcfRow.id;
  expect(fbId).toBe(findingId);              // 撞號前提成立，這支測試才有意義

  stubTriage('code');
  stubHappyPath();
  // 統整成一組，只收「意見」那一筆（序號 1）
  mergeCandidates.mockImplementation(async (items) => {
    const fb = items.find(it => it.source === 'feedback');
    return [{ member_ids: [fb.id], title: '純意見的修改', detail: 'd', action: 'a', layer: 'code', verify_route: '' }];
  });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  // 純意見的組必須新建 finding，不能沿用撞號的那筆健檢提案
  const { rows: [fin] } = await dbModule.query('SELECT agent_label FROM health_check_findings WHERE id=$1', [findingId]);
  expect(fin.agent_label).toBe('健檢的');    // 原本那筆沒有被當成這一組的載體
  const { rows } = await dbModule.query(
    "SELECT agent_label, agent_name FROM health_check_findings WHERE agent_name='feedback'");
  expect(rows).toHaveLength(1);
  expect(rows[0].agent_label).toBe('純意見的修改');
  // 而且被標 done 的是那筆意見，不是健檢提案
  const { rows: [fb] } = await dbModule.query('SELECT status FROM feedback WHERE id=$1', [fbId]);
  expect(fb.status).toBe('done');
  const { rows: [hc] } = await dbModule.query('SELECT status FROM health_check_findings WHERE id=$1', [findingId]);
  expect(hc.status).toBe('approved');        // 沒被連坐標掉
});

// --- 上限與統整 ---

test('統整後才套上限：8 筆進、併成 3 組 → 跑 3 條（不是 5 條）', async () => {
  for (let i = 0; i < 8; i++) await insertHealthProposal({ severity: 'high', label: `第${i}筆` });
  stubHappyPath();
  mergeCandidates.mockImplementation(async (items) => {
    expect(items.length).toBe(8);            // 統整前是 8 筆
    return [
      { member_ids: items.slice(0, 3).map(i => i.id), title: 'g1', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
      { member_ids: items.slice(3, 6).map(i => i.id), title: 'g2', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
      { member_ids: items.slice(6, 8).map(i => i.id), title: 'g3', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
    ];
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });
  expect(result).toMatchObject({ attempted: 3, applied: 3, skipped: 0 });
});

test('統整後超過 NIGHTLY_FIX_MAX（5）→ 只跑 5 組，其餘記在 skipped', async () => {
  for (let i = 0; i < 7; i++) await insertHealthProposal({ severity: 'high', label: `第${i}筆` });
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result).toMatchObject({ attempted: 5, applied: 5, skipped: 2 });
  expect(runFix).toHaveBeenCalledTimes(5);
});

test('統整結果 layer=env 或成員序號對不上 → 該組不執行', async () => {
  await insertHealthProposal({ severity: 'high' });
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  mergeCandidates.mockImplementation(async (items) => [
    { member_ids: [items[0].id], title: 'env的組', detail: 'd', action: 'a', layer: 'env', verify_route: '' },
    { member_ids: [999], title: '序號對不上的組', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
    { member_ids: [items[1].id], title: '正常的組', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
  ]);

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result.attempted).toBe(1);          // 只有「正常的組」跑
  expect(runFix).toHaveBeenCalledTimes(1);
});

test('merge agent 把同一個候選序號放進兩組 → 後出現的組剔掉重複成員，該成員不會被記兩次失敗', async () => {
  const findingId1 = await insertHealthProposal({ severity: 'high', label: '第一條' });
  await insertHealthProposal({ severity: 'high', label: '第二條' });
  stubHappyPath();
  reviewFix.mockResolvedValue({ verdict: 'reject', reason: '都不行' }); // 兩組都失敗，才看得出有沒有記兩次
  mergeCandidates.mockImplementation(async (items) => [
    { member_ids: [items[0].id], title: '第一組（先出現，拿走 items[0]）', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
    // 第二組同時要 items[0]（重複）與 items[1]（正常）：items[0] 要被剔掉，items[1] 照跑
    { member_ids: [items[0].id, items[1].id], title: '第二組（撞號）', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
  ]);

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  // 兩組都還是各自跑一次（第二組剔掉重複成員後剩 items[1]，不是整組被丟掉）
  expect(result.attempted).toBe(2);
  const { rows: [f1] } = await dbModule.query('SELECT fix_attempts FROM health_check_findings WHERE id=$1', [findingId1]);
  expect(f1.fix_attempts).toBe(1);           // 不是 2——沒有被兩組各記一次
});

test('merge agent 把同一組的成員全撞號（去重後剩空組）→ 整組丟掉並留 log，不執行', async () => {
  await insertHealthProposal({ severity: 'high', label: '唯一一條' });
  stubHappyPath();
  mergeCandidates.mockImplementation(async (items) => [
    { member_ids: [items[0].id], title: '先出現的組', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
    { member_ids: [items[0].id], title: '撞號後整組淨空', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
  ]);
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result.attempted).toBe(1);          // 只有先出現的組跑，撞號組被整組丟掉
  expect(runFix).toHaveBeenCalledTimes(1);
  // 去重動作本身要留 log，且不能被誤導成「沒有對得上的成員序號」——它們對得上，
  // 只是被更早的組拿走了，兩句話對應的排查方向完全不同。
  const logLines = logSpy.mock.calls.map(c => c.join(' '));
  expect(logLines.some(l => l.includes('已被更早的組拿走'))).toBe(true);
  expect(logLines.some(l => l.includes('沒有對得上的成員序號'))).toBe(false);
  logSpy.mockRestore();
});

test('統整沒填 verify_route → 沿用組內意見成員的值（否則截圖審查對意見來源永遠不啟動）', async () => {
  await insertFeedback();
  stubTriage('code');                        // triage 會寫入 verify_route='#/tasks'
  stubHappyPath();
  mergeCandidates.mockImplementation(async (items) => [
    { member_ids: [items[0].id], title: 't', detail: 'd', action: 'a', layer: 'code', verify_route: '' },
  ]);

  await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(reviewFix).toHaveBeenCalled();
  expect(reviewFix.mock.calls[0][1].verify_route).toBe('#/tasks');
});

// --- 修正鏈 ---

test('測試沒過（status 非 ready）→ 不呼叫 adoptFix', async () => {
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='failed', reject_reason='跑不動' WHERE id=$1`, [fixId]);
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalled();         // 正向錨：迴圈真的有跑（否則「沒呼叫 adoptFix」恆真）
  expect(reviewFix).not.toHaveBeenCalled();
  expect(adoptFix).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
});

test('修正結果為 no_change（platform-fix 判斷不該做）→ 立即退場，不是「未通過測試」，也不佔重試額度', async () => {
  const fbId = await insertFeedback();
  stubTriage('code');
  stubHappyPath();
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='no_change' WHERE id=$1`, [fixId]);
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalledTimes(1);          // 確定性結果，不重試
  expect(reviewFix).not.toHaveBeenCalled();
  expect(adoptFix).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
  const { rows: [fb] } = await dbModule.query(
    'SELECT status, triage_note, fix_attempts FROM feedback WHERE id=$1', [fbId]);
  expect(fb.status).toBe('new');                    // 一次即退場，不是留在 approved 每晚重跑
  expect(fb.fix_attempts).toBe(0);
  expect(fb.triage_note).not.toContain('未通過測試');  // 事實錯誤的舊文案不可再出現
  expect(fb.triage_note).toContain('no_change');
});

test('reviewFix 第一次 reject → 新開一筆 finding_fixes 重跑（新增而非覆寫），舊列標 rejected', async () => {
  const findingId = await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  const reviewedFixIds = [];
  reviewFix.mockImplementation(async (fixId) => {
    reviewedFixIds.push(fixId);
    return reviewedFixIds.length === 1
      ? { verdict: 'reject', reason: '不夠好' }
      : { verdict: 'approve', reason: 'ok' };
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalledTimes(2);           // 第一次 + 重跑一次
  expect(new Set(reviewedFixIds).size).toBe(2);      // 兩筆不同的 id：新增而非覆寫
  const { rows } = await dbModule.query(
    'SELECT status, reject_reason FROM finding_fixes WHERE finding_id=$1 ORDER BY id', [findingId]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ status: 'rejected', reject_reason: '不夠好' }); // 舊列保留且不再像「可採用」
  expect(result.applied).toBe(1);
});

test('reviewFix 第二次仍 reject → 不再重試，這條結束', async () => {
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  reviewFix.mockResolvedValue({ verdict: 'reject', reason: '一直不行' });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalledTimes(2);   // NIGHTLY_FIX_MAX_RETRY=1 ⇒ 共 2 次嘗試
  expect(reviewFix).toHaveBeenCalledTimes(2);
  expect(adoptFix).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
});

test('兩者都過 → 依序呼叫 adoptFix、applyFix，且 applyFix 收到非空 inflight（只合併不重啟）', async () => {
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(adoptFix).toHaveBeenCalled();
  expect(applyFix).toHaveBeenCalled();
  const inflightArg = applyFix.mock.calls[0][2];
  expect(Array.isArray(inflightArg)).toBe(true);
  expect(inflightArg.length).toBeGreaterThan(0);
  expect(adoptFix.mock.invocationCallOrder[0]).toBeLessThan(applyFix.mock.invocationCallOrder[0]);
  expect(result.applied).toBe(1);
});

test('cli_push_user_id 為 null → 停在 adopted、不呼叫 applyFix、來源不標 done', async () => {
  await dbModule.query('UPDATE teams_settings SET cli_push_user_id = NULL WHERE id=1');
  const findingId = await insertHealthProposal({ severity: 'high' });
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(adoptFix).toHaveBeenCalled();
  expect(applyFix).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
  // 沒合併就不算處置完成，來源要留著下次再試
  const { rows: [f] } = await dbModule.query('SELECT status FROM health_check_findings WHERE id=$1', [findingId]);
  expect(f.status).toBe('approved');
  expect(restartCalls()).toHaveLength(0);
});

// --- 標 done（否則每晚重做同一批）---

test('合併成功 → 意見標 done 並寫回 finding_id；健檢提案標 done 並記 applied_at', async () => {
  const fbId = await insertFeedback();
  stubTriage('code');
  stubHappyPath();

  await nightlyFix.runNightlyFix({ startedBy: userId });

  const { rows: [fb] } = await dbModule.query('SELECT status, finding_id FROM feedback WHERE id=$1', [fbId]);
  expect(fb.status).toBe('done');
  expect(fb.finding_id).not.toBeNull();
  const { rows: [fin] } = await dbModule.query(
    'SELECT status, applied_at FROM health_check_findings WHERE id=$1', [fb.finding_id]);
  expect(fin.status).toBe('done');
  expect(fin.applied_at).not.toBeNull();
});

test('健檢來源沿用既有 finding、不重建；合併後標 done ＋ applied_at', async () => {
  const findingId = await insertHealthProposal({ severity: 'high' });
  stubHappyPath();

  await nightlyFix.runNightlyFix({ startedBy: userId });

  // 沿用：runFix 收到的 findingId 就是原本那筆
  expect(runFix.mock.calls[0][1].findingId).toBe(findingId);
  const { rows: [f] } = await dbModule.query(
    'SELECT status, applied_at FROM health_check_findings WHERE id=$1', [findingId]);
  expect(f).toMatchObject({ status: 'done' });
  expect(f.applied_at).not.toBeNull();
  // 沒有為了這條多生一列
  const { rows } = await dbModule.query('SELECT COUNT(*)::int AS n FROM health_check_findings');
  expect(rows[0].n).toBe(1);
});

test('批次自建的 finding 不會成為隔晚候選（明確帶 status=done，不吃 DEFAULT）', async () => {
  await insertFeedback();
  stubTriage('code');
  stubHappyPath();
  await nightlyFix.runNightlyFix({ startedBy: userId });

  const { rows } = await dbModule.query(
    "SELECT status FROM health_check_findings WHERE agent_name='feedback'");
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('done');       // 不是 pending／approved ⇒ 不會被隔晚重撈
});

test('合併失敗 → 意見不標 done，下一晚還撈得到（不會靜默吃掉使用者的意見）', async () => {
  const fbId = await insertFeedback();
  stubTriage('code');
  stubHappyPath();
  reviewFix.mockResolvedValue({ verdict: 'reject', reason: '不行' });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  const { rows: [fb] } = await dbModule.query('SELECT status FROM feedback WHERE id=$1', [fbId]);
  expect(fb.status).toBe('approved');
});

// --- 保險絲（全部走注入時鐘）---

test('跑到台北 02:00 → 不再開新的一條（開跑前檢查，不是跑到一半砍掉）', async () => {
  await insertHealthProposal({ severity: 'high', label: '第一條' });
  await insertHealthProposal({ severity: 'high', label: '第二條' });
  stubHappyPath();
  // 第一條跑完就跨過截止時刻。推進 25 小時而不是「3 小時」：deadline 是「起點之後的下一個
  // NIGHTLY_FIX_DEADLINE_HOUR 點」，其與起點的距離最多 24 小時，25 小時必定跨過——這樣這支
  // 測試就不會綁死在該常數當下的值上（改設定不該讓測試靜默換掉它測的東西）。
  runFix.mockImplementation(async (fixId) => {
    advanceClock(25 * 60 * 60 * 1000);
    await runFixReady(fixId);
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result.attempted).toBe(1);          // 第一條照跑完，第二條不開
  expect(runFix).toHaveBeenCalledTimes(1);
  expect(applyFix).toHaveBeenCalledTimes(1); // 已開跑的那條沒有被半途砍掉
});

test('23:00 起跑不會被誤擋——deadline 是「起點之後的下一個 02:00」，不是拿當下小時比大小', async () => {
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  setClock(BASE_ISO);                        // 台北 23:00：23 >= 2，裸比大小的寫法會在這裡整批 no-op

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalled();
  expect(result.attempted).toBe(1);
});

test('token 超預算 → 不再開新的一條（開跑前、連 triage 都不跑）', async () => {
  await insertFeedback();
  await insertHealthProposal({ severity: 'high' });
  stubTriage('code');
  stubHappyPath();
  // 批次起點固定在 2020，token_usage 的 recorded_at 走真實 NOW() ⇒ 恆落在起點之後，不靠毫秒競賽
  await dbModule.query(
    `INSERT INTO token_usage (agent_type, input_tokens, output_tokens) VALUES ('platform_fix', 13000000, 0)`);

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result).toMatchObject({ attempted: 0, applied: 0, reason: 'token-budget' });
  expect(triageOne).not.toHaveBeenCalled();  // triage 也要花錢，保險絲要擋在它前面
  expect(mergeCandidates).not.toHaveBeenCalled();
  expect(runFix).not.toHaveBeenCalled();
});

test('預算未超 → 照常跑（對照組，證明上一支是預算擋的而不是別的原因）', async () => {
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  await dbModule.query(
    `INSERT INTO token_usage (agent_type, input_tokens, output_tokens) VALUES ('platform_fix', 100, 0)`);

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });
  expect(result.attempted).toBe(1);
});

// --- 韌性：不要靜默 no-op、不要一顆炸掉整批 ---

test('某一條拋錯（applyFix 撞到髒的主 clone）→ 只有那條中止，後面照跑', async () => {
  await insertHealthProposal({ severity: 'high', label: '會炸的' });
  await insertHealthProposal({ severity: 'high', label: '正常的' });
  stubHappyPath();
  applyFix.mockImplementationOnce(async () => { throw new Error('主 clone 有未提交的變更'); });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalledTimes(2);   // 第二條沒有被第一條帶走
  expect(result).toMatchObject({ attempted: 2, applied: 1 });
  // health_check_runs 有收尾（第一條拋錯時若沒接住，這裡會停在 running）
  const { rows } = await dbModule.query(
    "SELECT status FROM health_check_runs WHERE window_days=0 ORDER BY id DESC LIMIT 1");
  expect(rows[0].status).toBe('done');
});

test('在飛任務排不空 → 放棄本批次、清維護旗標、回 drain-timeout', async () => {
  // 每輪詢一次就讓時間過 40 分鐘（> 30 分鐘上限）⇒ 第一次檢查就逾時、不會真的睡 60 秒。
  // 綁在「輪詢在飛任務」這個行為上，不綁死時鐘被呼叫幾次（程式多一次 now() 也不會換掉測的東西）。
  getInflightInfo.mockImplementation(() => { advanceClock(40 * 60 * 1000); return [{ taskId: 1, userId }]; });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result).toEqual({ attempted: 0, applied: 0, skipped: 0, reason: 'drain-timeout' });
  expect(await maintenance.isMaintenance()).toBe(false);
  expect(runFix).not.toHaveBeenCalled();
});

test('批次拋錯 → finally 有清維護旗標（旗標卡住＝派工從此安靜停擺）', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async () => { throw new Error('merge 掛了'); });

  await expect(nightlyFix.runNightlyFix({ startedBy: userId })).rejects.toThrow('merge 掛了');
  expect(await maintenance.isMaintenance()).toBe(false);
});

test('維護旗標已亮（上一批還在跑）→ 不重複啟動', async () => {
  await maintenance.enterMaintenance(60000);
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result).toMatchObject({ reason: 'already-running' });
  expect(runFix).not.toHaveBeenCalled();
  expect(await maintenance.isMaintenance()).toBe(true);  // 沒把別人的旗標清掉
});

// --- 重啟 ---

test('一條都沒合併成功 → 不重啟', async () => {
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='failed' WHERE id=$1`, [fixId]);
  });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalled();         // 正向錨：迴圈有跑，只是沒有一條成功
  expect(restartCalls()).toHaveLength(0);
});

test('有合併成功 → 重啟一次，且清維護旗標排在重啟指令之前', async () => {
  await insertHealthProposal({ severity: 'high', label: 'a' });
  await insertHealthProposal({ severity: 'high', label: 'b' });
  stubHappyPath();

  // 重啟那道指令會把整個行程帶走，排在它後面的清旗標不保證跑得到。
  // 在 docker restart 當下去問旗標狀態：已清＝順序正確。
  let maintenanceAtRestart = null;
  mockExecFile.mockImplementation((cmd, args, ...rest) => {
    const cb = rest[rest.length - 1];
    if (cmd === 'docker' && args[0] === 'restart') maintenanceAtRestart = maintenance.isMaintenance();
    return cb(null, { stdout: '', stderr: '' });
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result.applied).toBe(2);
  expect(restartCalls()).toHaveLength(1);              // 兩條都合併，但只重啟一次
  expect(restartCalls()[0][1]).toEqual(['restart', 'odoo-v2']);
  expect(await maintenanceAtRestart).toBe(false);      // 重啟當下旗標已清
  expect(await maintenance.isMaintenance()).toBe(false);
});

test('查不到容器名 → 不重啟也不拋錯（碼已合併，留 log 讓人工重啟）', async () => {
  await insertHealthProposal({ severity: 'high' });
  stubHappyPath();
  selfContainerName.mockRejectedValue(new Error('無法唯一辨識平台容器'));

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result.applied).toBe(1);
  expect(restartCalls()).toHaveLength(0);
  expect(await maintenance.isMaintenance()).toBe(false);
});

// --- 失敗退場（否則一條永遠修不好的意見會每晚重跑、並永久佔住 5 格中的一格）---

test('失敗一次 → 只累加次數，狀態不動（下一晚還會再試）', async () => {
  const fbId = await insertFeedback();
  stubTriage('code');
  stubHappyPath();
  reviewFix.mockResolvedValue({ verdict: 'reject', reason: '還是不行' });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  const { rows: [fb] } = await dbModule.query('SELECT status, fix_attempts FROM feedback WHERE id=$1', [fbId]);
  expect(fb).toMatchObject({ status: 'approved', fix_attempts: 1 });
});

test('連續失敗達門檻 → 意見退回人工（status=new＋triage_note 寫原因），並歸零讓人再核准時有完整額度；且清掉 decided_by／decided_at', async () => {
  const fbId = await insertFeedback();
  await dbModule.query('UPDATE feedback SET fix_attempts=2 WHERE id=$1', [fbId]);  // 前兩晚已失敗
  // fixture 補上人工核准會寫的欄位（feedback-routes.js:85 的 UPDATE 會寫 decided_by/decided_at/
  // verdict_note）。不補的話這支測試永遠是空心的：兩欄本來就預設 NULL，不管退場邏輯清不清都會通過。
  await dbModule.query('UPDATE feedback SET decided_by=$2, decided_at=NOW(), verdict_note=$3 WHERE id=$1',
    [fbId, userId, '管理員說：這個要做']);
  stubTriage('code');
  stubHappyPath();
  reviewFix.mockResolvedValue({ verdict: 'reject', reason: '改法會弄壞別的東西' });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  const { rows: [fb] } = await dbModule.query(
    'SELECT status, triage_note, fix_attempts, decided_by, decided_at FROM feedback WHERE id=$1', [fbId]);
  expect(fb.status).toBe('new');                      // 回到管理員那一格，不是靜靜消失
  expect(fb.fix_attempts).toBe(0);                    // 人再核准一次就再給一輪完整額度
  expect(fb.triage_note).toMatch(/^自動退場：/);      // 機器標記前綴，供前端 pill 判斷
  expect(fb.triage_note).toContain('連續失敗 3 次');
  expect(fb.triage_note).toContain('改法會弄壞別的東西'); // 附上最後一次失敗原因
  // 人工核准過的欄位不能留著——不清掉的話會讓機器退場看起來像使用者自己核准後又反悔
  expect(fb.decided_by).toBeNull();
  expect(fb.decided_at).toBeNull();
});

test('連續失敗達門檻 → 健檢提案退回 pending，且清掉 decided_by／decided_at（分得出是機器退場不是人的裁決）', async () => {
  const findingId = await insertHealthProposal({ severity: 'high' });
  await dbModule.query('UPDATE health_check_findings SET fix_attempts=2 WHERE id=$1', [findingId]);
  // fixture 補上人工核准會寫的欄位（admin-routes.js:602 的 UPDATE 會寫 decided_by/decided_at）。
  // 不補的話這支測試永遠是空心的：兩欄本來就預設 NULL，不管退場邏輯清不清都會通過。
  await dbModule.query('UPDATE health_check_findings SET decided_by=$2, decided_at=NOW() WHERE id=$1',
    [findingId, userId]);
  stubHappyPath();
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='failed' WHERE id=$1`, [fixId]);
  });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  const { rows: [f] } = await dbModule.query(
    'SELECT status, verdict_note, decided_by, decided_at, fix_attempts FROM health_check_findings WHERE id=$1', [findingId]);
  expect(f.status).toBe('pending');
  expect(f.fix_attempts).toBe(0);
  expect(f.verdict_note).toContain('連續失敗 3 次');
  expect(f.verdict_note).toMatch(/^自動退場：/);   // 機器標記前綴，供前端 pill 判斷
  expect(f.decided_by).toBeNull();
  expect(f.decided_at).toBeNull();
});

test('退場後不再是候選：下一晚連 triage 都不會為它花錢', async () => {
  const fbId = await insertFeedback();
  await dbModule.query('UPDATE feedback SET fix_attempts=2 WHERE id=$1', [fbId]);
  stubTriage('code');
  stubHappyPath();
  reviewFix.mockResolvedValue({ verdict: 'reject', reason: '不行' });
  await nightlyFix.runNightlyFix({ startedBy: userId });   // 第一晚：退場

  jest.clearAllMocks();
  stubTriage('code');
  stubHappyPath();
  const second = await nightlyFix.runNightlyFix({ startedBy: userId });  // 第二晚

  expect(triageOne).not.toHaveBeenCalled();
  expect(second.attempted).toBe(0);
});

test('停在 adopted（沒設推送身分）不算失敗額度：一次設定疏漏不該燒掉每一條的退場額度', async () => {
  await dbModule.query('UPDATE teams_settings SET cli_push_user_id = NULL WHERE id=1');
  const fbId = await insertFeedback();
  stubTriage('code');
  stubHappyPath();

  await nightlyFix.runNightlyFix({ startedBy: userId });

  const { rows: [fb] } = await dbModule.query('SELECT status, fix_attempts FROM feedback WHERE id=$1', [fbId]);
  expect(fb).toMatchObject({ status: 'approved', fix_attempts: 0 });
});

// --- 收尾與計數的韌性 ---

test('保險絲檢查自己拋錯 → 例外逃出迴圈，但 health_check_runs 仍被收成 done（不會停在 running）', async () => {
  await insertHealthProposal({ severity: 'high', label: '第一條' });
  await insertHealthProposal({ severity: 'high', label: '第二條' });
  stubHappyPath();
  // 保險絲檢查（讀時鐘＋查 token 用量）在 per-candidate try 之外，它一拋就直接離開迴圈。
  // 這裡讓時鐘在第一條跑完後開始拋，模擬那一類例外——綁在「第一條跑完」這個行為上，
  // 不綁死時鐘被呼叫第幾次。
  let clockBroken = false;
  nightlyFix._setClockForTesting(() => {
    if (clockBroken) throw new Error('保險絲檢查失敗');
    return new Date(clockMs);
  });
  runFix.mockImplementationOnce(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
    clockBroken = true;
  });

  await expect(nightlyFix.runNightlyFix({ startedBy: userId })).rejects.toThrow('保險絲檢查失敗');

  const { rows } = await dbModule.query(
    'SELECT status FROM health_check_runs WHERE window_days=0 ORDER BY id DESC LIMIT 1');
  expect(rows[0].status).toBe('done');                 // 收尾在 finally，任何離開路徑都收得到
  expect(await maintenance.isMaintenance()).toBe(false);
});

test('markGroupDone 持續拋錯 → 不計入 applied、不誤記失敗次數，且立即退場（不是永遠停在 approved 每晚重跑）', async () => {
  const fbId = await insertFeedback();
  stubTriage('code');
  stubHappyPath();
  // 合併成功之後、標記之前，把 finding 抽掉 ⇒ markGroupDone 寫 feedback.finding_id 會撞 FK。
  // 用 mockImplementation（非 Once）模擬「持續拋錯」——這是 F1 症狀換了條路徑長回來的重點：
  // 上一輪的 I2 把「誤記失敗」換成「完全不記」，若只驗一晚看不出「這一條永遠不退場」這個洞。
  applyFix.mockImplementation(async () => {
    await dbModule.query('DELETE FROM health_check_findings');
    return { merged: true, restarted: false };
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result).toMatchObject({ attempted: 1, applied: 0 });   // 不高報
  const { rows: [fb] } = await dbModule.query(
    'SELECT status, fix_attempts, triage_note FROM feedback WHERE id=$1', [fbId]);
  // 碼此刻已經合併成功了，只是收尾（markGroupDone）失敗——不是這一條真的沒改好，不該算進
  // 失敗額度；也不是「什麼都不記」，那樣這條意見的 status 會永遠停在 approved、永久佔住
  // NIGHTLY_FIX_MAX 一格。第三種結局：立即退場給人工，文案明講「碼已合併進 master」。
  expect(fb.fix_attempts).toBe(0);
  expect(fb.status).toBe('new');
  expect(fb.triage_note).toContain('碼已合併進 master');
  // 碼此刻已經在 master 上了，不重啟的話平台會一直跑舊碼
  expect(restartCalls()).toHaveLength(1);
});

test('markGroupDone 持續拋錯 → 連跑三晚只合併一次，這一條不會每晚重付 triage、重跑兩次全套測試、重新 merge、重啟', async () => {
  await insertFeedback();
  stubTriage('code');
  stubHappyPath();
  applyFix.mockImplementation(async () => {
    await dbModule.query('DELETE FROM health_check_findings');
    return { merged: true, restarted: false };
  });

  const first = await nightlyFix.runNightlyFix({ startedBy: userId });     // 第一晚：合併成功但收尾失敗，立即退場
  expect(first).toMatchObject({ attempted: 1, applied: 0 });
  expect(restartCalls()).toHaveLength(1);

  jest.clearAllMocks();
  stubTriage('code');
  stubHappyPath();
  applyFix.mockImplementation(async () => {
    await dbModule.query('DELETE FROM health_check_findings');
    return { merged: true, restarted: false };
  });
  const second = await nightlyFix.runNightlyFix({ startedBy: userId });    // 第二晚：已退場，不再是候選
  expect(triageOne).not.toHaveBeenCalled();
  expect(second.attempted).toBe(0);
  expect(restartCalls()).toHaveLength(0);   // 這一晚沒有新碼要合併，不該重啟

  jest.clearAllMocks();
  stubTriage('code');
  stubHappyPath();
  applyFix.mockImplementation(async () => {
    await dbModule.query('DELETE FROM health_check_findings');
    return { merged: true, restarted: false };
  });
  const third = await nightlyFix.runNightlyFix({ startedBy: userId });     // 第三晚：同上
  expect(triageOne).not.toHaveBeenCalled();
  expect(third.attempted).toBe(0);
  expect(restartCalls()).toHaveLength(0);
});

test('materializeGroup 本身拋錯 → 仍計入 attempted（否則摘要行低報），來源成員仍要記失敗次數', async () => {
  const fbId1 = await insertFeedback({ content: '第一筆' });
  const fbId2 = await insertFeedback({ content: '第二筆' });
  stubTriage('code');
  stubHappyPath();
  // 兩筆各自成組。第一組完整跑完（含 markGroupDone）之後，才把批次共用的 health_check_runs
  // 那一列砍掉；第二組進 materializeGroup 時 INSERT health_check_findings 會因為 run_id
  // 對不到列而撞 FK——這是「materializeGroup 自己拋錯」在這條編排邏輯裡唯一自然會發生的方式
  // （runId 是整批次共用的單一值，開跑前建好，不是逐組重建）。
  //
  // ⚠ 掛勾點刻意留在 now() 呼叫次數上，這是 fix round 4 evaluate 過語意掛勾（改在 applyFix／
  // reviewFix mock 裡觸發）之後**主動放棄**的結果，不是沒試過：markGroupDone 本身不是 mock、
  // 沒有可注入的縫，而 applyFix／reviewFix 都在 markGroupDone 執行**之前**就返回——把刪除動作
  // 塞進第一組的 applyFix mock，砍表的時間點會早於第一組自己的 markGroupDone，讓第一組也連帶
  // 撞到 FK、掉進 fix round 4 新增的「碼已合併但標記來源失敗」退場分支，扭曲了這支測試要驗的
  // 「只有第二組的 materializeGroup 拋錯」前提。markGroupDone 之後、下一組 materializeGroup
  // 之前沒有其他可 mock 的斷點，只剩 now()。
  //
  // 這個掛勾綁的是 now() 呼叫次數：依序 1=startedAt 2=waitForDrain 3=開跑前 preFuse
  // 4=第一組的 fuseTripped 5=第二組的 fuseTripped。第 5 次呼叫的當下，第一組（含
  // materializeGroup／runOneCandidate／markGroupDone）已經完整跑完，第二組的 materializeGroup
  // 則還沒開始。**動生產碼裡 fuseTripped／markGroupDone／批次前置流程任一處的 now() 呼叫次數，
  // 這支測試會變紅，回來改這裡的次數，不代表這支測試本身測錯了東西。**
  const realClock = () => new Date(clockMs);
  let clockCalls = 0;
  let deleteQueued = null;
  nightlyFix._setClockForTesting(() => {
    clockCalls += 1;
    if (clockCalls === 5 && !deleteQueued) {
      deleteQueued = dbModule.query('DELETE FROM health_check_runs');
    }
    return realClock();
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(clockCalls).toBeGreaterThanOrEqual(5);      // 正向錨：確定真的卡到第二組的檢查點
  await deleteQueued;                                 // 確保刪除真的落地過，斷言才有意義
  // 第一組建出 cand 並成功跑完 runOneCandidate（合併成功）；第二組 materializeGroup 拋錯，
  // 但仍要算進 attempted（否則摘要行「嘗試 N 條」低報）
  expect(result.attempted).toBe(2);
  expect(result.applied).toBe(1);
  const { rows: [fb1] } = await dbModule.query('SELECT status FROM feedback WHERE id=$1', [fbId1]);
  const { rows: [fb2] } = await dbModule.query('SELECT status, fix_attempts FROM feedback WHERE id=$1', [fbId2]);
  expect(fb1.status).toBe('done');
  expect(fb2.status).toBe('approved');
  expect(fb2.fix_attempts).toBe(1);                   // 來源成員仍要記一次失敗，不能悄悄放過
});

test('手動在白天觸發 → 跑道被上限截斷，不是「到明天凌晨兩點」的 16 小時', async () => {
  await insertHealthProposal({ severity: 'high', label: '第一條' });
  await insertHealthProposal({ severity: 'high', label: '第二條' });
  stubHappyPath();
  setClock('2020-01-01T02:00:00Z');           // 台北 10:00：下一個 02:00 在 16 小時後
  // 第一條花掉 5 小時：超過 4 小時的跑道上限，但遠不到 16 小時。
  // 沒有上限的話第二條會照跑——這就是這支測試的鑑別力所在。
  runFix.mockImplementation(async (fixId) => {
    advanceClock(5 * 60 * 60 * 1000);
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result.attempted).toBe(1);
  expect(runFix).toHaveBeenCalledTimes(1);
});
