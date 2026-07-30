/**
 * 重複派工重現：同一任務同一關同時跑兩個 claude。
 *
 * 現場（正式站 task 157／171，2026-07-30）：每一關的 `▶ 階段標記`（runner.js:295，全庫唯一出處）
 * 都出現兩次、session id 不同，token_usage 每關成對且時間重疊（coding 669s／647s 併行）。
 * 第二支 coding 自己說「工作已被另一個併發行程完成並 commit」。
 *
 * 根因不在 runner 的 in-flight 互斥本身，而在「互斥只存在於單一行程的記憶體」：
 *   - runner.js:31 `_inFlight`／:32 `_pipelineRunning` 是 module 內的 Map/Set；
 *     dispatchTask（runner.js:392）的 has→set 是同步區段，同一行程內確實原子（見下方兩支對照組）。
 *   - tasks 表沒有任何「已被誰認領」的欄位／租約 → 第二個派工者完全不受任何約束。
 *   - index.js:200-201 先 `startCron()` 才 `httpServer.listen(PORT)`，且 listen 沒有 error handler；
 *     EADDRINUSE 走到 index.js:137 的 uncaughtException 只印 log 不 exit ＝ 重複啟動會留下
 *     一個「沒有 HTTP 埠、但 cron 照跑照派工」的隱形 server。實測 pg_stat_activity 同一分鐘
 *     有兩份一模一樣的 runPipeline 掃描查詢，來自兩個 node pid。
 *
 * 本檔用「兩個 module registry ＋ 同一個 pg-mem DB」模型化那兩個派工行程：
 * 派工邏輯（runPipeline／dispatchTask／runTask）完全是正式碼，沒有被 mock 掉；
 * 被複製的只是「行程」這個容器。斷言用的就是現場那份證據——同一關的階段標記只該有一筆。
 *
 * 修法是兩層，本檔守的是第二層（`dispatch-lease.js` 的值班牌；第一層的綁埠守衛見
 * server-duplicate-launch.test.js）。主測試模型化的是**兩個 cron**——現場第二個行程沒有
 * HTTP 埠、收不到任何手動請求，所以「一邊手動一邊 cron」不是真實情境，也是設計上刻意
 * 不擋的（手動推進不受值班牌限制，牌卡住時人工仍推得動任務）。
 */
const { newDb } = require('pg-mem');

// 兩個 registry 各自會拿到一份新的 mock（factory 會重跑），故計數／resolver 掛在 global 上共用
global.__dupDispatch = { calls: {}, resolvers: [], gateHold: null };

jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn().mockResolvedValue(undefined),
  checkoutDefault: jest.fn().mockResolvedValue(undefined),
  ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  AI_BRANCH: 'ai-dev'
}));
// 用量閘門：可被測試「掛住」，用來把一次 cron 掃描停在 runner.js:435 的 await 裡
// （runPipeline 是先 await 閘門、才拿掃描鎖 _pipelineRunning）
jest.mock('../pipeline/usage-gate', () => ({
  getGateState: () => {
    const hold = global.__dupDispatch.gateHold;
    const state = { enabled: true, blocked: false };
    return hold ? hold.then(() => state) : Promise.resolve(state);
  },
  _resetForTesting: jest.fn()
}));
jest.mock('../pipeline/cs-agent', () => ({ runCsAgent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/merge-agent', () => ({ runMergeAgent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/deploy-testing', () => ({ runDeployTesting: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/playwright-agent', () => ({ runTourStage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/reject-triage', () => ({ runRejectTriage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/respec-agent', () => ({ runRespecPatch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/clarify-chat', () => ({ runClarifyChat: jest.fn().mockResolvedValue(undefined), loadConversation: jest.fn().mockResolvedValue('') }));
// coding／qa handler 代表「一支真的 claude」：掛住不 resolve，直到測試放行 → 兩次派工才會真的重疊
jest.mock('../pipeline/task-agent', () => ({
  runTaskAnalysis: jest.fn().mockResolvedValue(true),
  runTaskCoding: jest.fn(() => new Promise(resolve => {
    const g = global.__dupDispatch;
    g.calls.coding = (g.calls.coding || 0) + 1;
    g.resolvers.push(async () => {
      if (g.advanceToQa) await g.advanceToQa();
      resolve(true);
    });
  }))
}));
jest.mock('../pipeline/qa-agent', () => ({
  runQaAgent: jest.fn(() => new Promise(resolve => {
    const g = global.__dupDispatch;
    g.calls.qa = (g.calls.qa || 0) + 1;
    g.resolvers.push(() => resolve(undefined));
  }))
}));

const hooks = global.__dupDispatch;

let dbA, runnerA, leaseA, dbB, runnerB, leaseB, userId, seq = 0;

// 模型化一次 cron tick：先搶值班牌，再跑自動推進掃描（＝ cron.js 的實際順序）
async function cronTick(lease, runner) {
  const got = await lease.acquireDispatchLease();
  const res = await runner.runPipeline(userId, { auto: true });
  return { got, dispatched: res.dispatched };
}

// 讓已排定的 microtask／pg-mem 查詢跑完（含「第二次派工」若真的發生也已進到 handler）
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
};

async function seedTask(status) {
  const { rows: [t] } = await dbA.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1, $2, 'manual', $3) RETURNING id",
    [userId, `dup_${++seq}`, status]
  );
  return t.id;
}

async function countStageMarkers(taskId, label) {
  const { rows } = await dbA.query('SELECT content FROM task_events WHERE task_id = $1', [taskId]);
  return rows.filter(r => r.content.includes('▶') && r.content.includes(label)).length;
}

// 放行所有掛住的 handler，等兩個 registry 的在飛任務都收乾（避免洩漏到下一個測試）。
// 不用 whenIdle()：斷言失敗時可能有「resolver 已被丟掉」的孤兒 promise，whenIdle 會永遠等下去。
async function drain() {
  hooks.gateHold = null;
  if (hooks.releaseGate) { hooks.releaseGate(); hooks.releaseGate = null; }
  for (let i = 0; i < 50; i++) {
    const pending = hooks.resolvers.splice(0);
    for (const r of pending) await r();
    await settle();
    if (!hooks.resolvers.length && !runnerA.getInflightTaskIds().length && !runnerB.getInflightTaskIds().length) return;
  }
}

beforeAll(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();

  // registry A ＝ 行程 1（例：對外 listen 的那個 server）
  jest.resetModules();
  dbA = require('../db');
  dbA._setPoolForTesting(new Pool());
  runnerA = require('../pipeline/runner');
  leaseA = require('../dispatch-lease');

  // registry B ＝ 行程 2（例：listen 撞 EADDRINUSE 卻沒死、cron 照跑的隱形 server）。
  // 兩個 Pool 都由同一個 pg-mem 實例建出 → 同一份資料，正如兩個行程連同一個 Postgres。
  jest.resetModules();
  dbB = require('../db');
  dbB._setPoolForTesting(new Pool());
  runnerB = require('../pipeline/runner');
  leaseB = require('../dispatch-lease');

  expect(dbA).not.toBe(dbB);            // 前提：真的是兩份獨立的 module 實例
  expect(runnerA).not.toBe(runnerB);
  expect(leaseA).not.toBe(leaseB);      // 兩個行程各有自己的身分與值班狀態
  expect(leaseA.HOLDER).not.toBe(leaseB.HOLDER);

  await dbA.migrate();
  const { rows: [u] } = await dbA.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('dup', 'x', 'D') RETURNING id"
  );
  userId = u.id;
});

afterAll(() => { dbA._setPoolForTesting(null); dbB._setPoolForTesting(null); });

beforeEach(async () => {
  hooks.calls = {};
  hooks.advanceToQa = null;
  // runTask 一定會寫 task_events，先清依賴表再清 tasks（比照 runner.test.js／usage-gate-runner.test.js）
  await dbA.query('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
  await dbA.query('DELETE FROM tasks WHERE user_id = $1', [userId]);
  // 值班牌回到「沒人持有」，兩個行程都還沒問過（＝剛啟動的狀態）
  await dbA.query('DELETE FROM dispatcher_lease');
  leaseA.__setDispatcherForTesting(null);
  leaseB.__setDispatcherForTesting(null);
});

// 斷言失敗也要收乾在飛任務，否則掛住的 handler 會活到下一個測試裡（beforeEach 的 DELETE 會撞 FK）
afterEach(drain);

// ── 主證明：跨行程沒有互斥 ───────────────────────────────────────────────
test('兩個行程各跑一次 cron tick → 同一任務同一關只能被派工一次（現場症狀：▶ 階段標記每關兩次）', async () => {
  const taskId = await seedTask('coding_running');

  // 兩個行程的 cron 各掃一次同一筆任務（handler 掛住＝claude 還在跑，重疊才會顯現）
  const a = await cronTick(leaseA, runnerA);
  const b = await cronTick(leaseB, runnerB);
  await settle();

  // 值班牌只有一個行程拿得到，所以整體只該派一次、階段標記只該一筆。
  // 拿掉值班牌（runner.js 的 isDispatcher 閘門或 cron.js 的 acquire）→ 兩邊都會派，
  // coding_handler_呼叫次數 與 開發中_階段標記筆數 同時變 2。
  expect({
    拿到值班牌的行程數: [a.got, b.got].filter(Boolean).length,
    總派工次數: a.dispatched + b.dispatched,
    coding_handler_呼叫次數: hooks.calls.coding || 0,
    開發中_階段標記筆數: await countStageMarkers(taskId, '開發中')
  }).toEqual({
    拿到值班牌的行程數: 1,
    總派工次數: 1,
    coding_handler_呼叫次數: 1,
    開發中_階段標記筆數: 1
  });
});

// ── 對照組 1：同一行程內兩個掃描來源（cron ＋ 路由）＝ 正確互斥 ─────────────
test('對照組：同一行程內 cron 與路由同時掃描 → 只派一次', async () => {
  const taskId = await seedTask('coding_running');

  const [a, b] = await Promise.all([
    runnerA.runPipeline(userId),                  // 路由（手動）
    runnerA.runPipeline(userId, { auto: true })   // cron
  ]);
  await settle();

  expect(hooks.calls.coding).toBe(1);
  expect(a.dispatched + b.dispatched).toBe(1);
  expect(await countStageMarkers(taskId, '開發中')).toBe(1);

  await drain();
});

// ── 對照組 2：自動接續下一關的空窗期（_inFlight 已 delete、下一關還沒 set）被 cron 掃到 ──
// runner.js:402-405 的 .finally 先 delete 再 await continuePipelineIfAdvanced，
// 中間有多個 await；本測試刻意把一次 cron 掃描停在 runner.js:435 的閘門 await 裡，
// 讓它與自動接續同時落在那段空窗，驗證 dispatchTask 的 has→set 同步區段仍然擋得住。
test('對照組：自動接續下一關的空窗期被 cron 掃到 → 下一關也只派一次', async () => {
  const taskId = await seedTask('coding_running');
  // coding handler resolve 之前先把狀態推進到 qa_running（模擬真 handler 的行為）
  hooks.advanceToQa = () => dbA.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [taskId]);

  await runnerA.runPipeline(userId);
  await settle();
  expect(hooks.calls.coding).toBe(1);

  // 把一次 cron 掃描停在閘門 await 裡（此時 _inFlight 仍有 coding 的佔位）
  hooks.gateHold = new Promise(r => { hooks.releaseGate = r; });
  const parkedCron = runnerA.runPipeline(userId, { auto: true });
  await settle();

  // 放行 coding → .finally 刪佔位並走自動接續（也會撞到被掛住的閘門）
  const [resolveCoding] = hooks.resolvers.splice(0);
  await resolveCoding();
  await settle();

  // 兩條路徑（自動接續、被停住的 cron）同時從空窗期醒來
  hooks.gateHold = null;
  hooks.releaseGate();
  hooks.releaseGate = null;
  await parkedCron;
  await settle();

  expect(hooks.calls.qa).toBe(1);
  expect(await countStageMarkers(taskId, 'QA 審查中')).toBe(1);

  await drain();
});
