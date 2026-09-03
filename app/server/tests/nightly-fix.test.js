// nightly-fix.js 是意見回饋通道的核心編排器：意見回饋通道全靠它把「approved 的候選」變成
// 「合併進 master 的碼」。這支釘住每一道守門：候選篩選（layer／severity／意見不套嚴重度）、
// 統整後才套上限、測試沒過不採用、審查 reject 重跑一次、cli_push_user_id 為空停在 adopted、
// 兩道保險絲（deadline／token 預算）開跑前檢查、drain-timeout 清旗標、批次拋錯 finally 清旗標、
// 一條都沒合併就不重啟。
//
// 依 pipeline.md #23：新增會被讀取的全域閘門／外部依賴，real-runner 系列要補 mock；這裡整個
// runner 都是 mock（只需要 getInflightInfo），避免真的拉起 dispatch。
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
  pickSelfContainer: jest.fn(() => 'odoo-v2'),
}));
// execFile 的 promisify 版依呼叫方式走 (cmd, args, cb) 或 (cmd, args, opts, cb)——照 finding-fix-apply.test.js
// 的慣例，callback 一律是最後一個參數。
const mockExecFile = jest.fn((...args) => { const cb = args[args.length - 1]; cb(null, { stdout: '', stderr: '' }); });
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));

const { newDb } = require('pg-mem');
const { getInflightInfo } = require('../pipeline/runner');
const { triageOne, mergeCandidates } = require('../pipeline/feedback-triage');
const { reviewFix } = require('../pipeline/fix-review');
const { runFix, adoptFix, applyFix } = require('../pipeline/finding-fix');

let dbModule, nightlyFix, maintenance, userId;

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
    "INSERT INTO users (username, password_hash, display_name) VALUES ('nightly','x','N') RETURNING id"
  );
  userId = u.id;
});

afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  jest.clearAllMocks();
  getInflightInfo.mockReturnValue([]);
  mockExecFile.mockImplementation((...args) => { const cb = args[args.length - 1]; cb(null, { stdout: '', stderr: '' }); });
  await maintenance.leaveMaintenance();
  nightlyFix._setClockForTesting(null);
  await dbModule.query('DELETE FROM finding_fixes');
  await dbModule.query('DELETE FROM health_check_findings');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query('DELETE FROM feedback_attachments');
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

async function insertHealthProposal({ status = 'approved', layer = 'code', severity = 'medium' } = {}) {
  const { rows: [run] } = await dbModule.query(`INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id`);
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, layer, status)
     VALUES ($1,'health-auditor','標題','診斷內容',$2,'proposal',$3,$4) RETURNING id`,
    [run.id, severity, layer, status]
  );
  return f.id;
}

// triageOne 預設：把 feedback 的 layer 填成 code 並標可理解；測試各自覆寫。
function stubTriageOk(layer = 'code') {
  triageOne.mockImplementation(async (feedbackId) => {
    await dbModule.query(
      `UPDATE feedback SET triage_title='t', triage_detail='d', triage_layer=$2, triage_action='a' WHERE id=$1`,
      [feedbackId, layer]
    );
    return { ok: true, understandable: true };
  });
}

function groupFor(items) {
  return items.map((it, i) => ({
    member_ids: [it.id],
    title: it.title, detail: it.detail, action: '修法', layer: 'code', verify_route: ''
  }));
}

test('候選篩選：健檢 severity=low 不入選、medium 入選；layer=env 不入選；意見回饋不受 severity 影響', async () => {
  // fixture 交錯放：health_check_findings 與 feedback 各自獨立的 SERIAL，id 會撞號，
  // 所以斷言一律用 source+id 的複合鍵，不能只比對數字 id（否則證明不了條件真的生效）。
  const low = await insertHealthProposal({ severity: 'low' });
  const medium = await insertHealthProposal({ severity: 'medium' });
  const envLayer = await insertHealthProposal({ layer: 'env', severity: 'high' });
  const fbId = await insertFeedback();

  stubTriageOk('code');
  mergeCandidates.mockImplementation(async (items) => {
    const keys = items.map(it => `${it.source}:${it.id}`);
    expect(keys).not.toContain(`finding:${low}`);
    expect(keys).not.toContain(`finding:${envLayer}`);
    expect(keys).toContain(`finding:${medium}`);
    expect(keys).toContain(`feedback:${fbId}`);
    expect(keys.length).toBe(2); // 只有這兩筆入選，不多不少
    return groupFor(items);
  });

  // runFix 是 mock，實際不會把 finding_fixes.status 改成 ready；讓它在呼叫後自己補上 ready，
  // 模擬「測試沒有新增紅燈」的成功路徑。
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });
  applyFix.mockResolvedValue({ merged: true, restarted: false });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });
  expect(result.attempted).toBe(2); // medium 健檢提案 + 意見回饋，各自成一組
});

test('統整後才套上限：8 筆進、併成 3 組 → 跑 3 條（不是 5 條）', async () => {
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await insertHealthProposal({ severity: 'high' }));

  mergeCandidates.mockImplementation(async (items) => {
    expect(items.length).toBe(8); // 統整前是 8 筆
    // 併成 3 組
    return [
      { member_ids: items.slice(0, 3).map(i => i.id), title: 'g1', detail: 'd1', action: 'a', layer: 'code', verify_route: '' },
      { member_ids: items.slice(3, 6).map(i => i.id), title: 'g2', detail: 'd2', action: 'a', layer: 'code', verify_route: '' },
      { member_ids: items.slice(6, 8).map(i => i.id), title: 'g3', detail: 'd3', action: 'a', layer: 'code', verify_route: '' },
    ];
  });
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });
  applyFix.mockResolvedValue({ merged: true, restarted: false });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });
  expect(result.attempted).toBe(3);
  expect(result.applied).toBe(3);
});

test('測試沒過（status 非 ready）→ 不呼叫 adoptFix', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='failed', reject_reason='跑不動' WHERE id=$1`, [fixId]);
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });
  expect(adoptFix).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
});

test('reviewFix 第一次 reject → 新開一筆 finding_fixes 重跑（新增而非覆寫）', async () => {
  const findingProposalId = await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));

  let runFixCallCount = 0;
  const createdFixIds = [];
  runFix.mockImplementation(async (fixId) => {
    runFixCallCount += 1;
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });

  let reviewCallCount = 0;
  reviewFix.mockImplementation(async (fixId) => {
    reviewCallCount += 1;
    createdFixIds.push(fixId);
    if (reviewCallCount === 1) return { verdict: 'reject', reason: '不夠好' };
    return { verdict: 'approve', reason: 'ok' };
  });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });
  applyFix.mockResolvedValue({ merged: true, restarted: false });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFixCallCount).toBe(2); // 第一次 + 重跑一次
  expect(new Set(createdFixIds).size).toBe(2); // 兩筆不同的 finding_fixes id：新增而非覆寫
  const { rows } = await dbModule.query(
    'SELECT id, status, reject_reason FROM finding_fixes WHERE finding_id=$1 ORDER BY id', [findingProposalId]
  );
  expect(rows.length).toBe(2);
  expect(rows[0].reject_reason).toBe('不夠好'); // 舊列保留 reject 記錄，沒被覆寫
});

test('reviewFix 第二次仍 reject → 不再重試，這條結束', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'reject', reason: '一直不行' });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).toHaveBeenCalledTimes(2); // 第一次 + 重試一次（NIGHTLY_FIX_MAX_RETRY=1）＝共 2 次嘗試
  expect(adoptFix).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
});

test('兩者都過 → 依序呼叫 adoptFix、applyFix，且 applyFix 收到非空 inflight', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });
  applyFix.mockResolvedValue({ merged: true, restarted: false });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(adoptFix).toHaveBeenCalled();
  expect(applyFix).toHaveBeenCalled();
  const inflightArg = applyFix.mock.calls[0][2];
  expect(inflightArg).toBeTruthy();
  expect(inflightArg.length).toBeGreaterThan(0);
  // 呼叫順序：adopt 在 apply 之前
  const adoptOrder = adoptFix.mock.invocationCallOrder[0];
  const applyOrder = applyFix.mock.invocationCallOrder[0];
  expect(adoptOrder).toBeLessThan(applyOrder);
  expect(result.applied).toBe(1);
});

test('cli_push_user_id 為 null → 停在 adopted，不呼叫 applyFix', async () => {
  await dbModule.query('UPDATE teams_settings SET cli_push_user_id = NULL WHERE id=1');
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(adoptFix).toHaveBeenCalled();
  expect(applyFix).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
});

test('到 deadline hour → 不再開新的一條（開跑前檢查）', async () => {
  await insertHealthProposal({ severity: 'high' });
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });
  applyFix.mockResolvedValue({ merged: true, restarted: false });

  // 固定在台北時間 02:30（超過 deadline hour=2）
  nightlyFix._setClockForTesting(() => new Date('2026-09-04T18:30:00Z')); // UTC+8 = 02:30

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).not.toHaveBeenCalled();
  expect(result.attempted).toBe(0);
});

test('token 超預算 → 不再開新的一條', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });

  // 先塞一筆遠超預算的 token 用量（NIGHTLY_FIX_TOKEN_BUDGET 預設 12,000,000）
  await dbModule.query(
    `INSERT INTO token_usage (agent_type, input_tokens, output_tokens) VALUES ('platform_fix', 13000000, 0)`
  );

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(runFix).not.toHaveBeenCalled();
  expect(result.attempted).toBe(0);
});

test('在飛任務 30 分鐘排不空 → 放棄本批次、清維護旗標、回 drain-timeout', async () => {
  getInflightInfo.mockReturnValue([{ taskId: 1, userId, startedAt: Date.now() }]);
  // 用假時鐘快轉：第一次呼叫回批次起點，後續每次輪詢都推進超過 DRAIN_MAX_MS
  let calls = 0;
  const base = Date.now();
  nightlyFix._setClockForTesting(() => {
    calls += 1;
    // 第一次（batchStartedAt／deadline 計算）之後，drain 迴圈每次檢查都直接跳到超過期限
    return new Date(base + (calls <= 2 ? 0 : 40 * 60 * 1000));
  });

  const result = await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(result).toEqual({ attempted: 0, applied: 0, skipped: 0, reason: 'drain-timeout' });
  expect(await maintenance.isMaintenance()).toBe(false);
}, 20000);

test('批次拋錯 → finally 有清維護旗標', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async () => { throw new Error('merge 掛了'); });

  await expect(nightlyFix.runNightlyFix({ startedBy: userId })).rejects.toThrow('merge 掛了');
  expect(await maintenance.isMaintenance()).toBe(false);
});

test('一條都沒合併成功 → 不重啟', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='failed' WHERE id=$1`, [fixId]);
  });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(mockExecFile).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['restart']), expect.anything());
});

test('有合併成功 → 重啟（docker restart 有被呼叫）', async () => {
  await insertHealthProposal({ severity: 'high' });
  mergeCandidates.mockImplementation(async (items) => groupFor(items));
  runFix.mockImplementation(async (fixId) => {
    await dbModule.query(`UPDATE finding_fixes SET status='ready' WHERE id=$1`, [fixId]);
  });
  reviewFix.mockResolvedValue({ verdict: 'approve', reason: 'ok' });
  adoptFix.mockResolvedValue({ branch: 'fix/x', commit: 'abc' });
  applyFix.mockResolvedValue({ merged: true, restarted: false });
  mockExecFile.mockImplementation((cmd, args, ...rest) => {
    const cb = rest[rest.length - 1];
    if (cmd === 'docker' && args[0] === 'ps') return cb(null, { stdout: 'odoo-v2\n', stderr: '' });
    if (cmd === 'docker' && args[0] === 'inspect') {
      return cb(null, { stdout: `/odoo-v2\t${require('os').hostname()}\n`, stderr: '' });
    }
    return cb(null, { stdout: '', stderr: '' });
  });

  await nightlyFix.runNightlyFix({ startedBy: userId });

  expect(mockExecFile).toHaveBeenCalledWith('docker', ['restart', 'odoo-v2'], expect.any(Function));
});
