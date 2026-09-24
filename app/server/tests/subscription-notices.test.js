const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ notifyAction: jest.fn() }));

let dbModule, sendExpiryNotices, notify;
const now = new Date('2026-10-01T04:00:00.000Z');
const days = n => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ sendExpiryNotices } = require('../lib/subscription-notices'));
  notify = require('../notify');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('platform','x','平台','admin')"
  );
});

afterAll(() => dbModule._setPoolForTesting(null));

test('14 天／3 天各通知一次，只通知啟用的客戶公司管理員與平台管理員', async () => {
  const company = async (name, until, active = true, internal = false) =>
    (await dbModule.query(
      'INSERT INTO companies (name, is_active, is_internal, active_until) VALUES ($1,$2,$3,$4) RETURNING id',
      [name, active, internal, until]
    )).rows[0].id;
  const a = await company('甲', days(13));
  const b = await company('乙', days(2));
  await company('太早', days(30));
  await company('已過期', days(-1));
  await company('停用', days(2), false);
  await company('內部', days(2), true, true);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('a-admin','x','甲管理員','company_admin',$1),('b-admin','x','乙管理員','company_admin',$2)",
    [a, b]
  );

  expect(await sendExpiryNotices(now)).toEqual({ sent: 2 });
  const { rows: notices } = await dbModule.query('SELECT company_id, days_before FROM company_expiry_notices');
  expect(notices).toEqual(expect.arrayContaining([
    { company_id: a, days_before: 14 }, { company_id: b, days_before: 3 },
  ]));
  expect(notices).toHaveLength(2);
  const recipients = notify.notifyAction.mock.calls.map(([id, payload]) => [id, payload.companyId, payload.daysBefore]);
  const { rows: users } = await dbModule.query("SELECT id, username FROM users WHERE role IN ('admin','company_admin')");
  const ids = Object.fromEntries(users.map(u => [u.username, u.id]));
  expect(recipients).toEqual(expect.arrayContaining([
    [ids.platform, a, 14], [ids['a-admin'], a, 14],
    [ids.platform, b, 3], [ids['b-admin'], b, 3],
  ]));
  expect(recipients).toHaveLength(4);

  notify.notifyAction.mockClear();
  expect(await sendExpiryNotices(now)).toEqual({ sent: 0 });
  expect(notify.notifyAction).not.toHaveBeenCalled();

  expect(await sendExpiryNotices(days(11))).toEqual({ sent: 1 });
  expect(notify.notifyAction.mock.calls.map(([, payload]) => payload.daysBefore)).toEqual([3, 3]);

  notify.notifyAction.mockClear();
  await dbModule.query('UPDATE companies SET active_until = $2 WHERE id = $1', [a, days(23)]);
  expect(await sendExpiryNotices(days(11))).toEqual({ sent: 1 });
  expect(notify.notifyAction.mock.calls.map(([, payload]) => payload.daysBefore)).toEqual([14, 14]);
});
