const { validateSelectOnly } = require('../lib/ssh-sql');

test('SELECT 與 WITH 通過', () => {
  expect(validateSelectOnly('SELECT id FROM res_users')).toBeNull();
  expect(validateSelectOnly('WITH a AS (SELECT 1) SELECT * FROM a')).toBeNull();
  expect(validateSelectOnly('SELECT 1;')).toBeNull(); // 允許結尾分號
});

test('DML/DDL 被擋', () => {
  expect(validateSelectOnly('DELETE FROM t')).toMatch(/不允許/);
  expect(validateSelectOnly('UPDATE t SET a=1')).toMatch(/不允許/);
  expect(validateSelectOnly('SELECT * INTO x FROM t')).toMatch(/SELECT INTO/);
});

test('多語句被擋', () => {
  expect(validateSelectOnly('SELECT 1; DROP TABLE t')).toMatch(/多語句/);
});

test('字串常量內的關鍵字不誤判', () => {
  expect(validateSelectOnly("SELECT * FROM t WHERE name = 'please DELETE me'")).toBeNull();
});

test('空字串被擋', () => {
  expect(validateSelectOnly('')).toMatch(/不能為空/);
});
