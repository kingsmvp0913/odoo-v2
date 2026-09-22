// 意圖：重啟從 applyFix 拆出來之後，「碼進了 master」與「新碼真的在跑」變成兩件事。
// 這一支釘住的是那條分界線上四件會靜默出錯的事：
//   (1) 待更版清單就是 status='merged' 那些列——少了它，維護時段不知道有沒有東西要上；
//   (2) 標 done／applied_at 只在真的重啟時發生，而且要在下重啟指令之前寫完（那道指令會把
//       這個行程一起帶走，寫在後面的永遠寫不到）；
//   (3) 重啟過的列要收掉，否則每個維護時段都看到同一批，沒有新碼也照樣重啟客戶一次；
//   (4) 有在飛任務、或查不到容器名時什麼都不做——尤其不能標 done：畫面會顯示「處置完成」
//       而平台其實還跑著舊碼。
const { newDb } = require('pg-mem');

const mockExecFile = jest.fn((cmd, args, cb) => cb && cb(null, { stdout: '', stderr: '' }));
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
// selfContainerName 會真的去問 docker；這裡只要控制「查得到／查不到」兩種結果
const mockSelfContainer = jest.fn();
jest.mock('../pipeline/finding-fix', () => ({ selfContainerName: (...a) => mockSelfContainer(...a) }));

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

  test('測試閘門還沒接上時 testsPassed 是 null，不是 true：呼叫端不得把「沒跑」當成「通過」', async () => {
    useFakeTimers();
    try {
      await seedFix('merged');
      const r = await release.restartNow({ userId: 7 });
      expect(r.testsPassed).toBeNull();
    } finally { jest.useRealTimers(); }
  });
});
