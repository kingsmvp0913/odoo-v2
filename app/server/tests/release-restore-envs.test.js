// 意圖：平台重啟會讓**測試區 Odoo 的 cron 執行緒永久死掉**——測試區的 Odoo 連的是平台容器裡
// 那顆 postgres，平台一重啟連線瞬斷，例外從執行緒的 _bootstrap_inner 逃出去，執行緒就沒了
// （2026-09-10 萊峰19 實測：06:18 死後 30 分鐘零排程）。容器還在、畫面正常、HTTP 也通，
// 客戶看到的是「測試區開著但什麼都不動」，比整個關掉更難查。
//
// 以前重啟是稀有事件、有人在旁邊看；從現在起每週末 02:00 自動跑，沒有人在。這一支釘的就是
// 那條無人監督的路上四件會靜默出錯的事：
//   (1) 清單必須在**下重啟指令之前**落 DB——行程活不過重啟，而重啟完再掃的話，
//       「當時在跑、被連帶收掉」與「本來就沒在跑」長得一模一樣，那一台就靜靜地漏掉；
//   (2) 一台失敗不得影響其他台——整迴圈一起炸掉會把「一台有毛病」變成「全部沒救回來」；
//   (3) 失敗要留下人找得到的痕跡——這台沒有 webhook 也沒有 Teams，畫面是唯一的通道，
//       被吞掉的錯誤就是永遠看不見的錯誤；
//   (4) 清單用完要清掉——不清的話下次重啟會照著舊清單再翻一輪。
const { newDb } = require('pg-mem');

// 重啟指令。這一支只用它來確認「清單寫在它之前」。
const mockExecFile = jest.fn((cmd, args, cb) => cb && cb(null, { stdout: '', stderr: '' }));
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
// ⚠ measureTests 沒 mock 的話 restartNow 會真的 spawn 一次全跑（十幾分鐘，而且是在測試裡面
// 再跑一次測試）——症狀是跑不完，不是紅燈。
const mockSelfContainer = jest.fn();
const mockMeasure = jest.fn();
jest.mock('../pipeline/finding-fix', () => ({
  selfContainerName: (...a) => mockSelfContainer(...a),
  measureTests: (...a) => mockMeasure(...a),
}));

const GREEN = { ok: true, summary: 'Tests: 5966 passed', failed: 0, passed: 5966, suiteFailed: 0 };

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
  for (const name of ['proj-a', 'proj-b', 'proj-c']) {
    await dbModule.query('INSERT INTO projects (name, odoo_version) VALUES ($1, $2)', [name, '17.0']);
  }
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
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('UPDATE teams_settings SET release_envs_to_revive=NULL, release_last_result=NULL');
});

// 待更版的一筆修正：restartNow 沒有東西要上也照樣重啟，但真實情境一定有，順手擺著。
async function seedMergedFix() {
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind, status)
     VALUES ($1,'__audit__','某條提案','medium','proposal','approved') RETURNING id`, [runId]);
  await dbModule.query(
    `INSERT INTO finding_fixes (finding_id, status, branch) VALUES ($1,'merged',$2)`,
    [f.id, `fix/finding-${f.id}-1`]);
}

async function seedEnv(projectId, status) {
  await dbModule.query(
    'INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,$2,$3)',
    [projectId, status, 21000 + projectId]);
}

// ⚠ 假時鐘要放過 setImmediate／nextTick：pg-mem 的 Pool 靠它們推進，一起假掉會讓每一句 query
// 永遠不 resolve，整支測試變成逾時而不是紅在斷言上。
const useFakeTimers = () =>
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

describe('重啟前把執行中的測試區記下來', () => {
  test('清單在下重啟指令之前就落地：那道指令會把這個行程一起帶走，寫在後面的永遠寫不到', async () => {
    useFakeTimers();
    try {
      await seedMergedFix();
      await seedEnv(1, 'running');
      await seedEnv(2, 'running');
      const r = await release.restartNow({ userId: 7 });
      expect(`restarted: ${r.restarted}`).toBe('restarted: true');
      // 此刻重啟指令都還沒送出去，清單卻必須已經在 DB 裡
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(await release.readEnvsToRevive()).toEqual([1, 2]);
      jest.runAllTimers();
      expect(mockExecFile.mock.calls[0].slice(0, 2)).toEqual(['docker', ['restart', 'odoo-v2']]);
    } finally { jest.useRealTimers(); }
  });

  test('只記 running 的：idle 的環境本來就沒有 cron 在跑，重開它等於無故拉起一台沒人要的測試區', async () => {
    useFakeTimers();
    try {
      await seedMergedFix();
      await seedEnv(1, 'running');
      await seedEnv(2, 'idle');
      await seedEnv(3, 'setting_up');
      await release.restartNow({ userId: 7 });
      expect(await release.readEnvsToRevive()).toEqual([1]);
    } finally { jest.useRealTimers(); }
  });

  test('沒真的重啟就不留清單：不然下次開機會平白重開一輪根本沒被打斷的測試區', async () => {
    useFakeTimers();
    try {
      await seedMergedFix();
      await seedEnv(1, 'running');
      const r = await release.restartNow({ userId: 7, inflight: [{ taskId: 77 }] });
      expect(`restarted: ${r.restarted}`).toBe('restarted: false');
      expect(await release.readEnvsToRevive()).toEqual([]);
    } finally { jest.useRealTimers(); }
  });
});

describe('開機時兌現清單', () => {
  test('逐台重開，回報救回幾台——這是「排程活過來了」唯一的證據', async () => {
    await seedEnv(1, 'running');
    await seedEnv(2, 'running');
    await release.captureRunningEnvs();
    const restartEnv = jest.fn().mockResolvedValue({ ok: true });
    const stats = await release.reviveRunningEnvs({ restartEnv });
    expect(restartEnv.mock.calls.map(c => c[0])).toEqual([1, 2]);
    expect(`revived=${stats.revived} failed=${stats.failed}`).toBe('revived=2 failed=0');
  });

  test('一台失敗不影響其他台：整迴圈一起炸掉會把「一台有毛病」變成「全部都沒救回來」', async () => {
    await seedEnv(1, 'running');
    await seedEnv(2, 'running');
    await seedEnv(3, 'running');
    await release.captureRunningEnvs();
    const restartEnv = jest.fn(id => (id === 1
      ? Promise.reject(new Error('埠 21001 未進入監聽'))
      : Promise.resolve({ ok: true })));
    const stats = await release.reviveRunningEnvs({ restartEnv });
    expect(restartEnv.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
    expect(`revived=${stats.revived} failed=${stats.failed}`).toBe('revived=2 failed=1');
  });

  test('失敗要留下人找得到的痕跡：這台沒有 webhook 也沒有 Teams，畫面是唯一的通道', async () => {
    await seedEnv(1, 'running');
    await release.captureRunningEnvs();
    const errs = [];
    const spy = jest.spyOn(console, 'error').mockImplementation(m => errs.push(String(m)));
    try {
      await release.reviveRunningEnvs({
        restartEnv: () => Promise.reject(new Error('埠 21001 未進入監聽')) });
    } finally { spy.mockRestore(); }
    // (1) log 要指得出是哪一個專案、以及後果是什麼
    expect(errs.join('\n')).toMatch(/專案 1 .*排程/);
    // (2) log 會被輪替掉，所以同一件事要留在更版頁讀得到的那一筆結果裡
    const last = await release.lastReleaseResult();
    expect(last.envRevive.failures).toEqual([{ projectId: 1, error: '埠 21001 未進入監聽' }]);
  });

  test('容器已經不在跑的算略過不算失敗：那台沒有 cron 可救，不該在畫面上叫人來看', async () => {
    await seedEnv(1, 'running');
    await release.captureRunningEnvs();
    const stats = await release.reviveRunningEnvs({
      restartEnv: () => Promise.resolve({ ok: false, skipped: 'not_running' }) });
    expect(`revived=${stats.revived} skipped=${stats.skipped} failed=${stats.failed}`)
      .toBe('revived=0 skipped=1 failed=0');
    expect(await release.lastReleaseResult()).toBeNull();   // 沒有失敗就不要在畫面上製造雜訊
  });

  test('清單用完就清掉：不清的話每次開機都會照著這份舊清單再翻一輪', async () => {
    await seedEnv(1, 'running');
    await release.captureRunningEnvs();
    const restartEnv = jest.fn().mockResolvedValue({ ok: true });
    await release.reviveRunningEnvs({ restartEnv });
    expect(await release.readEnvsToRevive()).toEqual([]);
    // 下一次開機（例如當天稍後又重啟一次）不該再動任何測試區
    restartEnv.mockClear();
    const stats = await release.reviveRunningEnvs({ restartEnv });
    expect(`calls=${restartEnv.mock.calls.length} total=${stats.total}`).toBe('calls=0 total=0');
  });

  test('沒有清單就什麼都不做：一般重啟（沒經過更版）不該順手把測試區全部重開一遍', async () => {
    const restartEnv = jest.fn().mockResolvedValue({ ok: true });
    const stats = await release.reviveRunningEnvs({ restartEnv });
    expect(restartEnv).not.toHaveBeenCalled();
    expect(stats.total).toBe(0);
  });

  test('預算用盡就停手，但沒救到的要大聲說：這段跑在平台還沒 listen 之前，卡滿就是全平台停擺', async () => {
    await seedEnv(1, 'running');
    await seedEnv(2, 'running');
    await release.captureRunningEnvs();
    // 第一台花掉全部預算，第二台進不去
    let t = 0;
    const now = () => (t += 100000);
    const restartEnv = jest.fn().mockResolvedValue({ ok: true });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let stats;
    try {
      stats = await release.reviveRunningEnvs({ restartEnv, now, budgetMs: 150000 });
    } finally { spy.mockRestore(); }
    expect(`revived=${stats.revived} overBudget=${stats.overBudget}`).toBe('revived=1 overBudget=1');
    const last = await release.lastReleaseResult();
    expect(last.envRevive.failures.map(f => f.projectId)).toEqual([2]);
  });
});
