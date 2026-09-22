// 意圖：重啟從 applyFix 拆出來之後，「碼進了 master」與「新碼真的在跑」變成兩件事。
// 這一支釘住的是那條分界線上四件會靜默出錯的事：
//   (1) 待更版清單就是 status='merged' 那些列——少了它，維護時段不知道有沒有東西要上；
//   (2) 標 done／applied_at 只在真的重啟時發生，而且要在下重啟指令之前寫完（那道指令會把
//       這個行程一起帶走，寫在後面的永遠寫不到）；
//   (3) 重啟過的列要收掉，否則每個維護時段都看到同一批，沒有新碼也照樣重啟客戶一次；
//   (4) 有在飛任務、或查不到容器名時什麼都不做——尤其不能標 done：畫面會顯示「處置完成」
//       而平台其實還跑著舊碼。
// 第五件是重啟前的全跑閘門：每條修正都只在自己的 worktree 上綠過，「全部合起來」從來沒有人跑過。
// 這裡的斷言一律要分清楚「跑了測試」與「測試通過」——只檢查有沒有跑，紅燈照樣會被放上線。
const { newDb } = require('pg-mem');

const mockExecFile = jest.fn((cmd, args, cb) => cb && cb(null, { stdout: '', stderr: '' }));
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
// selfContainerName 會真的去問 docker；這裡只要控制「查得到／查不到」兩種結果
const mockSelfContainer = jest.fn();
// measureTests 會真的 spawn 一次 `npm run test:quiet`（十幾分鐘，而且是在測試裡面再跑一次測試）。
// ⚠ 這個 mock 少了任何一支測試都會變成遞迴全跑——不是紅燈，是跑不完。
const mockMeasure = jest.fn();
jest.mock('../pipeline/finding-fix', () => ({
  selfContainerName: (...a) => mockSelfContainer(...a),
  measureTests: (...a) => mockMeasure(...a),
}));

// measureTests 全綠時的回傳形狀：ok=true（jest exit code 0）＋兩行總結都沒有 failed。
const GREEN = { ok: true, summary: 'Tests: 3 skipped, 5966 passed, 5969 total', failed: 0, passed: 5966, suiteFailed: 0 };

let dbModule, release, runId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  release = require('../pipeline/release');
  const { rows: [run] } = await dbModule.query(
    `INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id`);
  runId = run.id;
});
afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  mockExecFile.mockClear();
  mockSelfContainer.mockReset();
  mockSelfContainer.mockResolvedValue('odoo-v2');
  mockMeasure.mockReset();
  mockMeasure.mockResolvedValue(GREEN);
  await dbModule.query('DELETE FROM finding_fixes');
  await dbModule.query('DELETE FROM health_check_findings');
});

// 建一條提案＋一筆該提案的修正，回傳兩個 id
async function seedFix(status, diagnosis = '某條提案') {
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind, status)
     VALUES ($1,'__audit__',$2,'medium','proposal','approved') RETURNING id`, [runId, diagnosis]);
  const { rows: [fix] } = await dbModule.query(
    `INSERT INTO finding_fixes (finding_id, status, branch) VALUES ($1,$2,$3) RETURNING id`,
    [f.id, status, `fix/finding-${f.id}-1`]);
  return { findingId: f.id, fixId: fix.id };
}

// ⚠ 假時鐘要放過 setImmediate／nextTick：pg-mem 的 Pool 靠它們推進，一起假掉會讓每一句 query
// 永遠不 resolve，整支測試變成逾時而不是紅在斷言上。
const useFakeTimers = () =>
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

const findingRow = id => dbModule.query('SELECT * FROM health_check_findings WHERE id=$1', [id])
  .then(r => r.rows[0]);
const fixRow = id => dbModule.query('SELECT * FROM finding_fixes WHERE id=$1', [id]).then(r => r.rows[0]);

describe('pendingReleases', () => {
  test('只收 merged：還沒審完的（ready／adopted）與已經上線的（released）都不算待更版', async () => {
    await seedFix('ready');
    await seedFix('adopted');
    await seedFix('released');
    const { fixId } = await seedFix('merged');
    const rows = await release.pendingReleases();
    expect(rows.map(r => r.id)).toEqual([fixId]);
  });

  test('帶得出提案的 diagnosis 與 severity：更版頁要讓人看得出這次要上的是什麼', async () => {
    await seedFix('merged', '健檢提案：某某指標偏高');
    const [row] = await release.pendingReleases();
    expect(`${row.diagnosis} / ${row.severity}`).toBe('健檢提案：某某指標偏高 / medium');
  });
});

describe('restartNow', () => {
  test('重啟前就把提案標 done＋applied_at：重啟指令會把這個行程帶走，寫在後面的永遠寫不到', async () => {
    useFakeTimers();
    try {
      const { findingId } = await seedFix('merged');
      const r = await release.restartNow({ userId: 7 });
      expect(`restarted: ${r.restarted}`).toBe('restarted: true');
      // 此刻重啟指令都還沒送出去，標記卻必須已經落地
      expect(mockExecFile).not.toHaveBeenCalled();
      const f = await findingRow(findingId);
      expect(`${f.status} / decided_by=${f.decided_by} / applied=${f.applied_at !== null}`)
        .toBe('done / decided_by=7 / applied=true');
    } finally { jest.useRealTimers(); }
  });

  test('重啟過的那一列從 merged 收成 released：不收的話每個維護時段都會重啟一次沒有新碼的平台', async () => {
    useFakeTimers();
    try {
      const { fixId } = await seedFix('merged');
      await release.restartNow({ userId: 7 });
      expect((await fixRow(fixId)).status).toBe('released');
      expect(await release.pendingReleases()).toEqual([]);
    } finally { jest.useRealTimers(); }
  });

  test('docker restart 刻意延遲：指令會把自己這個行程帶走，回應得先送出去', async () => {
    useFakeTimers();
    try {
      await seedFix('merged');
      await release.restartNow({ userId: 7 });
      expect(mockExecFile).not.toHaveBeenCalled();
      jest.runAllTimers();
      expect(mockExecFile.mock.calls[0].slice(0, 2)).toEqual(['docker', ['restart', 'odoo-v2']]);
    } finally { jest.useRealTimers(); }
  });

  test('有任務在飛就不重啟，也不標 done：重啟會把 agent 當場砍掉留下 *_running 孤兒', async () => {
    useFakeTimers();
    try {
      const { findingId, fixId } = await seedFix('merged');
      const r = await release.restartNow({ userId: 7, inflight: [{ taskId: 77 }] });
      expect(`restarted: ${r.restarted}`).toBe('restarted: false');
      expect(r.reason).toMatch(/在飛/);
      jest.runAllTimers();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect((await findingRow(findingId)).status).toBe('approved');
      expect((await fixRow(fixId)).status).toBe('merged');   // 還在待更版清單裡，下次時段再上
    } finally { jest.useRealTimers(); }
  });

  test('查不到容器名＝重啟不了：不標 done，理由要帶回去（否則畫面顯示處置完成、平台跑著舊碼）', async () => {
    useFakeTimers();
    try {
      mockSelfContainer.mockRejectedValue(new Error('命中 0 個'));
      const { findingId, fixId } = await seedFix('merged');
      const r = await release.restartNow({ userId: 7 });
      expect(`restarted: ${r.restarted}`).toBe('restarted: false');
      expect(r.reason).toMatch(/容器/);
      jest.runAllTimers();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect((await findingRow(findingId)).status).toBe('approved');
      expect((await fixRow(fixId)).status).toBe('merged');
    } finally { jest.useRealTimers(); }
  });

  test('applied_at 只記第一次：它是回頭驗成效的起算點，第二次更版不該把它往後推', async () => {
    useFakeTimers();
    try {
      const { findingId, fixId } = await seedFix('merged');
      await release.restartNow({ userId: 7 });
      const first = (await findingRow(findingId)).applied_at;
      // 同一條提案又被修了一次、又合併了一次
      await dbModule.query(`UPDATE finding_fixes SET status='merged' WHERE id=$1`, [fixId]);
      await release.restartNow({ userId: 7 });
      expect((await findingRow(findingId)).applied_at).toEqual(first);
    } finally { jest.useRealTimers(); }
  });

});

describe('重啟指令失敗（標記已經寫下去，行程卻還活著）', () => {
  // 這一組守的是整條路徑上最危險的狀態：DB 裡寫著「這一批上線了」而平台其實沒重啟。
  // 那種狀態是靜默的——待更版清單空掉＝更版頁全綠、下一個時段判「沒東西要上」直接結束，
  // 於是這批碼再也不會被上線，平台無限期跑舊碼。標記不能搬到重啟之後（指令會把行程帶走），
  // 所以唯一的解法是「失敗時把標記收回來」，而 docker restart 失敗時行程還活著，做得到。
  const failRestart = msg => mockExecFile.mockImplementation((cmd, args, cb) => cb(new Error(msg)));
  // ⚠ 檔頭的 beforeEach 只做 mockClear（清呼叫紀錄，不清 implementation），所以這裡覆寫過的
  // 失敗行為會漏給後面每一支測試——把「重啟成功」全變成「重啟失敗」，而症狀出現在別的檔案段落。
  afterEach(() => mockExecFile.mockImplementation((cmd, args, cb) => cb && cb(null, { stdout: '', stderr: '' })));

  let envSeq = 0;
  async function seedRunningEnv() {
    // 每次只留這一台：captureRunningEnvs 撈的是全表，留著上一支測試的環境會讓斷言飄。
    await dbModule.query('DELETE FROM odoo_envs');
    // projects.name 有唯一鍵，固定名字會在第二支測試撞主鍵（症狀是 SQL 錯而不是斷言紅）。
    const { rows: [p] } = await dbModule.query(
      'INSERT INTO projects (name, odoo_version) VALUES ($1, $2) RETURNING id',
      [`更版失敗測試專案 ${++envSeq}`, '17.0']);
    await dbModule.query(
      'INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,$2,$3)', [p.id, 'running', 21099]);
    return p.id;
  }

  test('回滾成待更版：不回滾的話清單永遠是空的，畫面全綠而平台永遠跑舊碼', async () => {
    useFakeTimers();
    try {
      const { findingId, fixId } = await seedFix('merged');
      await seedRunningEnv();
      await require('../pipeline/maintenance').enterMaintenance(60 * 60 * 1000);
      await release.restartNow({ userId: 7 });
      // 標記此刻已經寫下去了（上面那幾支測試釘住的行為），指令還沒送出
      expect((await fixRow(fixId)).status).toBe('released');

      failRestart('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
      jest.runAllTimers();
      await release._pendingRestartFailureForTesting();

      const f = await findingRow(findingId);
      expect(`fix: ${(await fixRow(fixId)).status} / finding: ${f.status} / applied_at 清掉: ${f.applied_at === null}`)
        .toBe('fix: merged / finding: approved / applied_at 清掉: true');
      // 真正要守的是這一句：下一個時段（或人工按「立刻更版」）找得到東西要上
      expect((await release.pendingReleases()).length).toBe(1);
    } finally { jest.useRealTimers(); }
  });

  test('待重開測試區的清單要清掉：沒重啟卻留著，將來某次不相干的開機會把一批測試區翻出來重開', async () => {
    useFakeTimers();
    try {
      await seedFix('merged');
      const projectId = await seedRunningEnv();
      await release.restartNow({ userId: 7 });
      expect(await release.readEnvsToRevive()).toEqual([projectId]);

      failRestart('daemon busy');
      jest.runAllTimers();
      await release._pendingRestartFailureForTesting();
      expect(await release.readEnvsToRevive()).toEqual([]);
    } finally { jest.useRealTimers(); }
  });

  test('維護旗標要收回來、失敗要寫進畫面讀的那一筆：這台沒有 webhook，畫面是唯一通道', async () => {
    useFakeTimers();
    try {
      await seedFix('merged');
      await require('../pipeline/maintenance').enterMaintenance(60 * 60 * 1000);
      await release.restartNow({ userId: 7 });

      failRestart('No such container: odoo-v2');
      jest.runAllTimers();
      await release._pendingRestartFailureForTesting();

      expect(await require('../pipeline/maintenance').isMaintenance()).toBe(false);
      const last = await release.lastReleaseResult();
      expect(`restarted: ${last.restarted} / 說得出是哪一種失敗: ${/No such container/.test(last.reason || '')}`)
        .toBe('restarted: false / 說得出是哪一種失敗: true');
      // 人要知道「碼沒遺失、下一次會再試」，否則看到失敗只會不知道該做什麼
      expect(last.reason).toMatch(/仍跑著舊碼/);
      expect(`回滾了幾筆: ${last.restartFailed && last.restartFailed.rolledBack}`).toBe('回滾了幾筆: 1');
    } finally { jest.useRealTimers(); }
  });

  test('指令沒出錯就什麼都不動：補救碼自己去回滾成功的那一次，等於把上線的碼再打回待更版', async () => {
    useFakeTimers();
    try {
      const { fixId } = await seedFix('merged');
      await release.restartNow({ userId: 7 });
      jest.runAllTimers();   // 預設的 mock 是 cb(null)＝重啟指令送出成功
      await release._pendingRestartFailureForTesting();
      expect((await fixRow(fixId)).status).toBe('released');
    } finally { jest.useRealTimers(); }
  });
});

// 這一組釘的是「全部合起來」那道閘門。每條修正都是各自在自己的 worktree 上跑綠才合併的，
// 這個組合在維護時段之前不存在於任何地方——不在這裡跑，它就直接上線且沒有人在看。
describe('restartNow 的重啟前全跑閘門', () => {
  test('全跑紅燈時不重啟，理由要帶得出紅了幾支——光回一個 false，半夜兩點的人不知道下一步查哪裡', async () => {
    useFakeTimers();
    try {
      mockMeasure.mockResolvedValue({
        ok: false, summary: 'Tests: 3 failed, 5963 passed, 5966 total', failed: 3, passed: 5963, suiteFailed: 1 });
      const { findingId, fixId } = await seedFix('merged');
      const r = await release.restartNow({ userId: 7 });
      expect(`restarted: ${r.restarted}`).toBe('restarted: false');
      // 「跑了」不等於「過了」：這裡釘的是後者
      expect(`testsPassed: ${r.testsPassed}`).toBe('testsPassed: false');
      expect(r.reason).toMatch(/3 支測試紅/);
      expect(r.reason).toMatch(/Tests: 3 failed, 5963 passed, 5966 total/);
      jest.runAllTimers();
      expect(mockExecFile).not.toHaveBeenCalled();
      // 紅燈的正解是原封不動留到下個時段：標了 done 就等於畫面顯示「處置完成」而平台跑著舊碼
      expect((await findingRow(findingId)).status).toBe('approved');
      expect((await fixRow(fixId)).status).toBe('merged');
    } finally { jest.useRealTimers(); }
  });

  test('全跑綠燈才重啟，而且 testsPassed 是 true 不是 null：這一次真的有測試證據', async () => {
    useFakeTimers();
    try {
      await seedFix('merged');
      const r = await release.restartNow({ userId: 7 });
      expect(`restarted: ${r.restarted}`).toBe('restarted: true');
      expect(`testsPassed: ${r.testsPassed}`).toBe('testsPassed: true');
      expect(r.tests.summary).toBe(GREEN.summary);
      jest.runAllTimers();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });

  test('測試檔整支載不起來是騙人的 pass：Tests: 那行沒有 failed，照樣不准重啟', async () => {
    useFakeTimers();
    try {
      // 改壞的 require／語法錯時，沒跑到的測試不會被算進 Tests: 的 failed——
      // 那一行只是少掉一批 passed、完全沒有 "failed" 字樣，紅只留在 Test Suites: 上。
      mockMeasure.mockResolvedValue({
        ok: false, summary: 'Tests: 3 skipped, 5900 passed, 5903 total', failed: 0, passed: 5900, suiteFailed: 2 });
      await seedFix('merged');
      const r = await release.restartNow({ userId: 7 });
      expect(`restarted: ${r.restarted} / testsPassed: ${r.testsPassed}`)
        .toBe('restarted: false / testsPassed: false');
      expect(r.reason).toMatch(/2 個測試檔整支載不起來/);
      jest.runAllTimers();
      expect(mockExecFile).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  test('全跑根本沒跑完（逾時／npm 起不來）也不重啟，而且要說得出是哪個錯——不是紅燈但同樣沒有綠燈證據', async () => {
    useFakeTimers();
    try {
      mockMeasure.mockResolvedValue({
        ok: false, summary: '', failed: null, passed: null, suiteFailed: null, error: 'spawn npm ENOENT' });
      await seedFix('merged');
      const r = await release.restartNow({ userId: 7 });
      expect(`restarted: ${r.restarted} / testsPassed: ${r.testsPassed}`)
        .toBe('restarted: false / testsPassed: false');
      expect(r.reason).toMatch(/spawn npm ENOENT/);
      jest.runAllTimers();
      expect(mockExecFile).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  test('skipTests 時不跑測試，重啟但 testsPassed 是 null：「沒跑」永遠不能記成「通過」', async () => {
    useFakeTimers();
    try {
      await seedFix('merged');
      const r = await release.restartNow({ userId: 7, skipTests: true });
      expect(`restarted: ${r.restarted}`).toBe('restarted: true');
      expect(r.testsPassed).toBeNull();      // 不是 true——事後回頭查「這次驗過沒有」靠的就是這個值
      expect(mockMeasure).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  test('跑的是主 clone 的 repo 根：要驗的是「全部合起來」，那份組合只存在於 master 上，不在任何工作區副本', async () => {
    useFakeTimers();
    try {
      await seedFix('merged');
      await release.restartNow({ userId: 7 });
      const repoRoot = require('path').join(__dirname, '..', '..', '..');
      expect(mockMeasure.mock.calls[0][0]).toBe(repoRoot);
    } finally { jest.useRealTimers(); }
  });
});
