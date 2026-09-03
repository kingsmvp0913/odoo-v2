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

test('triage 之後 layer=env → 剔除（layer 只有 triage 完才知道，不能在撈候選時就篩）', async () => {
  await insertFeedback();
  stubTriage('env');
  stubHappyPath();

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(triageOne).toHaveBeenCalled();
  expect(mergeCandidates).not.toHaveBeenCalled();
  expect(result.attempted).toBe(0);
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
