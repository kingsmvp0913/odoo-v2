// 意圖：租約的借與還必須綁在測試區生命週期上——停機不還埠的話池子會單向耗盡，
// 症狀是「明明沒幾個測試區在跑卻說併發已滿」，且完全不指向真正的成因。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn() }));
jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return { ...actual, stopContainer: jest.fn().mockResolvedValue({ code: 0 }), removeContainer: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn().mockResolvedValue(), stopProjectVpns: jest.fn().mockResolvedValue() }));

let dbModule, stopEnv, nightlyShutdown, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('el','h','E') RETURNING id"
  );
  userId = u.id;
  ({ stopEnv, nightlyShutdown } = require('../pipeline/env-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
});

async function mkRunningEnv(name, port) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ($1,'17.0',$1) RETURNING id", [name]
  );
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',$2)", [p.id, port]
  );
  return p.id;
}

test('stopEnv 後租約歸還（port 設回 NULL）', async () => {
  const pid = await mkRunningEnv('a', 21000);
  await stopEnv(pid);
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('idle');
  expect(e.port).toBeNull();
});

test('夜間關機也要歸還租約', async () => {
  const pid = await mkRunningEnv('a', 21000);
  await nightlyShutdown();
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('idle');
  expect(e.port).toBeNull();
});

// 意圖：既有鐵則不得因租約改動而失效。
test('夜間關機跳過進行中的專案，且不歸還其租約', async () => {
  const pid = await mkRunningEnv('busy', 21000);
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'el_busy','odoo','T','deploy_testing',$2)",
    [userId, pid]
  );
  await nightlyShutdown();
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('running');
  expect(e.port).toBe(21000);
});
