/**
 * company-deactivate-abort.test.js — 停用公司立刻中止它正在跑的 AI（規格 §7 第五列、§8 P5）
 *
 * canRun 只擋得住下一次執行；已經在跑的那一輪會跑完，平台繼續替停繳的客戶燒錢。
 * 中止的語意沿用既有慣例：狀態原地不動、不寫失敗，只留一行時間軸讓人看得懂。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-cda-jwt';
process.env.APP_SECRET = 'test-cda-secret';

let dbModule, runner, coA, coB, uA, uB, tA, tB;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  runner = require('../pipeline/runner');

  coA = (await one('INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['甲'])).id;
  coB = (await one('INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['乙'])).id;
  const mkUser = async (n, co) => (await one(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4) RETURNING id',
    [n, 'x', 'user', co])).id;
  uA = await mkUser('a', coA);
  uB = await mkUser('b', coB);
  const pid = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['p'])).id;
  // task_id／source 為 NOT NULL 欄位（db.js:91-92），brief 原始程式碼未帶，比照本目錄其餘測試補上。
  let mkTaskN = 0;
  const mkTask = async (uid) => (await one(
    "INSERT INTO tasks (title, user_id, project_id, status, task_id, source) VALUES ($1,$2,$3,'coding_running',$4,'manual') RETURNING id",
    ['t', uid, pid, 'cda-' + (++mkTaskN)])).id;
  tA = await mkTask(uA);
  tB = await mkTask(uB);
});

afterAll(() => dbModule._setPoolForTesting(null));

test('只中止那家公司的任務，別家的不動', async () => {
  const ctrlA = new AbortController();
  const ctrlB = new AbortController();
  runner._setInflightForTesting(tA, { ctrl: ctrlA, userId: uA, startedAt: Date.now(), status: 'coding_running' });
  runner._setInflightForTesting(tB, { ctrl: ctrlB, userId: uB, startedAt: Date.now(), status: 'coding_running' });

  const aborted = await runner.abortCompanyTasks(coA);

  expect(aborted).toEqual([tA]);
  expect(ctrlA.signal.aborted).toBe(true);
  expect(ctrlB.signal.aborted).toBe(false);
});

test('寫一行時間軸，讓人看得懂為什麼停了', async () => {
  const { rows } = await dbModule.query(
    "SELECT role, content FROM task_logs WHERE task_id = $1 ORDER BY id DESC LIMIT 1", [tA]);
  expect(rows[0].content).toContain('停用');
});

test('狀態原地不動（既有中止慣例：不寫失敗、不列 blocker）', async () => {
  expect((await one('SELECT status FROM tasks WHERE id=$1', [tA])).status).toBe('coding_running');
});

test('沒有任何任務在跑的公司 → 回空陣列，不爆', async () => {
  expect(await runner.abortCompanyTasks(coB === undefined ? 0 : 999999)).toEqual([]);
});
