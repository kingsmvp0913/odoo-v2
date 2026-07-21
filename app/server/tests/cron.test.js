const { newDb } = require('pg-mem');
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));

// Mock sync to avoid real HTTP/API calls
jest.mock('../pipeline/sync', () => ({
  syncUser: jest.fn().mockResolvedValue({ odoo: { added: 2 }, service: { added: 0 } })
}));

let dbModule, cronModule, notifyModule;
let userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, sync_interval) VALUES ('crontest', $1, '測試', 'user', 1) RETURNING id",
    [hash]
  );
  userId = rows[0].id;

  notifyModule = require('../notify');
  cronModule = require('../cron');
});

afterAll(() => {
  cronModule.stopCron();
  dbModule._setPoolForTesting(null);
});

test('notify.emitToUser does not throw when io is not set', () => {
  expect(() => notifyModule.emitToUser(1, 'task:synced', { count: 3 })).not.toThrow();
});

test('notify.emitToUser calls io.to().emit() when io is set', () => {
  const mockEmit = jest.fn();
  const mockTo = jest.fn(() => ({ emit: mockEmit }));
  const mockIo = { to: mockTo, emit: jest.fn() };

  notifyModule.setIo(mockIo);
  notifyModule.emitToUser(42, 'task:updated', { taskId: 1, status: 'new' });

  expect(mockTo).toHaveBeenCalledWith('user:42');
  expect(mockEmit).toHaveBeenCalledWith('task:updated', { taskId: 1, status: 'new' });

  notifyModule.setIo(null);
});

test('notify.emitAll calls io.emit()', () => {
  const mockEmit = jest.fn();
  notifyModule.setIo({ to: jest.fn(() => ({ emit: jest.fn() })), emit: mockEmit });
  notifyModule.emitAll('notify:toast', { level: 'info', message: 'test' });
  expect(mockEmit).toHaveBeenCalledWith('notify:toast', { level: 'info', message: 'test' });
  notifyModule.setIo(null);
});

test('startCron returns a task object (cron job started)', () => {
  const job = cronModule.startCron();
  expect(job).toBeDefined();
  expect(typeof job.stop).toBe('function');
  cronModule.stopCron();
});

test('autoArchiveDone 封存完成滿 30 天的任務，保留較新完成的', async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const { rows: [a] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, done_at) VALUES ($1,'arch_old','odoo','O','done',$2) RETURNING id",
    [userId, old]
  );
  const { rows: [b] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, done_at) VALUES ($1,'arch_recent','odoo','R','done',$2) RETURNING id",
    [userId, recent]
  );
  await cronModule.autoArchiveDone();
  const { rows: [ra] } = await dbModule.query('SELECT is_hidden FROM tasks WHERE id=$1', [a.id]);
  const { rows: [rb] } = await dbModule.query('SELECT is_hidden FROM tasks WHERE id=$1', [b.id]);
  expect(ra.is_hidden).toBe(true);
  expect(rb.is_hidden).toBe(false);
});

// 意圖：deploy／E2E 失敗 log 過去無任何清理、只增不減把磁碟塞爆；超過保留期的 .log 必須被清、較新的與非 .log 保留。
test('cleanupOldDeployLogs 刪超過保留期的 .log，保留較新與非 log 檔', () => {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-logclean-'));
  const oldMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 天前（超過預設 14 天保留）
  const mk = (name, ageMs) => {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, 'x');
    if (ageMs != null) fs.utimesSync(fp, new Date(ageMs), new Date(ageMs));
    return fp;
  };
  const oldLog = mk('deploy-task1-1.log', oldMs);
  const oldE2e = mk('e2e-task2-999.log', oldMs);
  const freshLog = mk('deploy-task3-1.log', Date.now());
  const notLog = mk('deploy-task4-1.txt', oldMs); // 非 .log 不動

  const prevDeploy = process.env.DEPLOY_LOG_DIR, prevE2e = process.env.E2E_LOG_DIR;
  process.env.DEPLOY_LOG_DIR = dir; process.env.E2E_LOG_DIR = dir;
  try {
    cronModule.cleanupOldDeployLogs();
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(oldE2e)).toBe(false);
    expect(fs.existsSync(freshLog)).toBe(true);
    expect(fs.existsSync(notLog)).toBe(true);
  } finally {
    if (prevDeploy == null) delete process.env.DEPLOY_LOG_DIR; else process.env.DEPLOY_LOG_DIR = prevDeploy;
    if (prevE2e == null) delete process.env.E2E_LOG_DIR; else process.env.E2E_LOG_DIR = prevE2e;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 意圖：token_usage 每個關卡 INSERT 一列、只增不減；超過保留期的明細必須裁掉，較新的保留（報表用）。
test('cleanupOldTokenUsage 裁掉超過保留期的列，保留較新的', async () => {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // 超過預設 180 天
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  await dbModule.query(
    "INSERT INTO token_usage (task_id, agent_type, recorded_at) VALUES ('tu_old','coding',$1)", [old]
  );
  await dbModule.query(
    "INSERT INTO token_usage (task_id, agent_type, recorded_at) VALUES ('tu_recent','coding',$1)", [recent]
  );
  await cronModule.cleanupOldTokenUsage();
  const { rows: oldRows } = await dbModule.query("SELECT 1 FROM token_usage WHERE task_id='tu_old'");
  const { rows: newRows } = await dbModule.query("SELECT 1 FROM token_usage WHERE task_id='tu_recent'");
  expect(oldRows.length).toBe(0);
  expect(newRows.length).toBe(1);
});
