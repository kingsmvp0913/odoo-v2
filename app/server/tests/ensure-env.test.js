// 意圖：deploy 與 E2E 共用的環境自動啟動 helper。
// running 且埠實測活著才放行且不重啟；running 但埠已死（先健康後崩）→ 重啟；
// 未運行則呼叫 runEnvSetup 起環境，起得來→true、起不來→false。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/env-agent', () => ({ runEnvSetup: jest.fn(), waitForPort: jest.fn() }));

let dbModule, ensureEnvRunning, runEnvSetup, waitForPort, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  await dbModule.query("INSERT INTO users (username, password_hash, display_name) VALUES ('ee', $1, 'E')", [hash]);
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('EE', '17.0') RETURNING id");
  projectId = p.id;

  ({ runEnvSetup, waitForPort } = require('../pipeline/env-agent'));
  ({ ensureEnvRunning } = require('../pipeline/ensure-env'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runEnvSetup.mockReset();
  waitForPort.mockReset();
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [projectId]);
});

test('env running 且埠實測活著 → true，不呼叫 runEnvSetup（避免重啟正常環境）', async () => {
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',8069)", [projectId]);
  waitForPort.mockResolvedValue(true);
  const ok = await ensureEnvRunning(projectId);
  expect(ok).toBe(true);
  expect(waitForPort).toHaveBeenCalledWith(8069, 5000, 500);
  expect(runEnvSetup).not.toHaveBeenCalled();
});

test('env 標 running 但埠已死（先健康後崩）→ 重啟而非盲信', async () => {
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',8069)", [projectId]);
  waitForPort.mockResolvedValue(false); // 探不到：process 已不在
  runEnvSetup.mockImplementation(async (pid) => {
    await dbModule.query("UPDATE odoo_envs SET status='running' WHERE project_id=$1", [pid]);
  });
  const ok = await ensureEnvRunning(projectId);
  expect(ok).toBe(true);
  expect(runEnvSetup).toHaveBeenCalledWith(projectId); // 有重啟
});

test('env 未運行 → 呼叫 runEnvSetup 起環境；啟動成功 running → true', async () => {
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'idle')", [projectId]);
  // 模擬 runEnvSetup 成功把 env 拉成 running
  runEnvSetup.mockImplementation(async (pid) => {
    await dbModule.query("UPDATE odoo_envs SET status='running' WHERE project_id=$1", [pid]);
  });
  const ok = await ensureEnvRunning(projectId);
  expect(ok).toBe(true);
  expect(runEnvSetup).toHaveBeenCalledWith(projectId);
});

test('env 無紀錄 → 呼叫 runEnvSetup 起環境（首次自動建立）', async () => {
  runEnvSetup.mockImplementation(async (pid) => {
    await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'running')", [pid]);
  });
  const ok = await ensureEnvRunning(projectId);
  expect(ok).toBe(true);
  expect(runEnvSetup).toHaveBeenCalledWith(projectId);
});

test('env 起不來（runEnvSetup 後仍非 running）→ false，交由上層停任務標 env', async () => {
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'idle')", [projectId]);
  runEnvSetup.mockResolvedValue(undefined); // 起不來，狀態不變
  const ok = await ensureEnvRunning(projectId);
  expect(ok).toBe(false);
  expect(runEnvSetup).toHaveBeenCalledWith(projectId);
});
