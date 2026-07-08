// 意圖：建立環境／同步使用者時，固定 E2E 帳號 auto_test_user 一定會被灌進 Odoo 測試區
// （即使系統沒有任何 app user 也要建），且以明文 password_plain 交由 Odoo 自行雜湊。
const { newDb } = require('pg-mem');

// 攔截 odoo-bin shell 子行程：不真的跑 Odoo，只擷取傳入的 SEED_USERS 環境變數。
// mock 前綴變數才可被 jest.mock factory 引用（factory 提升至 import 之上）。
const mockState = { env: null };
jest.mock('child_process', () => {
  const { EventEmitter } = require('events');
  return {
    spawn: jest.fn((_bin, _args, opts) => {
      mockState.env = opts && opts.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      setImmediate(() => {
        child.stdout.emit('data', 'SEED_DONE 1');
        child.emit('close', 0);
      });
      return child;
    })
  };
});
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn() }));

let dbModule, seedOdooUsers;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ seedOdooUsers } = require('../pipeline/env-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('seedOdooUsers 一律附加固定 E2E 帳號 auto_test_user（帶明文 password_plain）', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('x', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('alice', $1, 'Alice')", [hash]
  );

  await seedOdooUsers({ venvPython: 'py', odooBin: 'odoo-bin', dbName: 'test_x', addonsPath: 'a' });

  const seeded = JSON.parse(mockState.env.SEED_USERS);
  const e2e = seeded.find(u => u.login === 'auto_test_user');
  expect(e2e).toBeTruthy();
  expect(e2e.password_plain).toBe('auto_test_user'); // 明文交 Odoo 雜湊
  expect(e2e.password).toBeUndefined();              // 非 app hash 路徑
  // app user 仍照舊帶 hash（非明文）
  const alice = seeded.find(u => u.login === 'alice');
  expect(alice.password).toBeTruthy();
  expect(alice.password_plain).toBeUndefined();
});

test('即使無 app user，也一定灌入固定 E2E 帳號', async () => {
  const emptyDb = newDb();
  const { Pool } = emptyDb.adapters.createPg();
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  await seedOdooUsers({ venvPython: 'py', odooBin: 'odoo-bin', dbName: 'test_e', addonsPath: 'a' });

  const seeded = JSON.parse(mockState.env.SEED_USERS);
  expect(seeded).toHaveLength(1);
  expect(seeded[0].login).toBe('auto_test_user');
});
