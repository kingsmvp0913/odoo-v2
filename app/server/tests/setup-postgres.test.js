// app/server/tests/setup-postgres.test.js
const { parseDatabaseUrl, ensurePostgres } = require('../../../scripts/lib/postgres');

describe('parseDatabaseUrl', () => {
  test('解析出 host/port/user/password/db', () => {
    const cfg = parseDatabaseUrl('postgres://alice:s3cr3t@localhost:5432/aidev');
    expect(cfg).toEqual({ pgHost: 'localhost', pgPort: '5432', pgUser: 'alice', pgPassword: 's3cr3t', pgDb: 'aidev' });
  });

  test('缺 port 時預設 5432', () => {
    const cfg = parseDatabaseUrl('postgres://alice:pw@localhost/aidev');
    expect(cfg.pgPort).toBe('5432');
  });

  test('pgUser 含不合法字元時丟出錯誤（防 SQL 注入）', () => {
    expect(() => parseDatabaseUrl('postgres://a%22%3Bdrop%20table--:pw@localhost/aidev'))
      .toThrow(/PG_USER/);
  });
});

describe('ensurePostgres', () => {
  function makeFakeExec({ directConnectFails = true, roleExists = false, dbExists = false } = {}) {
    const calls = [];
    const fn = (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes('-c')) {
        if (directConnectFails) throw new Error('connection refused');
        return '';
      }
      const sql = args[args.indexOf('-tAc') + 1];
      if (sql.includes('pg_roles')) return roleExists ? '1\n' : '';
      if (sql.includes('pg_database')) return dbExists ? '1\n' : '';
      return ''; // CREATE ROLE / CREATE DATABASE
    };
    fn.calls = calls;
    return fn;
  }

  test('直接連線成功時回報 created:false，不碰 admin 連線', async () => {
    const execFileSync = makeFakeExec({ directConnectFails: false });
    const result = await ensurePostgres('postgres://alice:pw@localhost:5432/aidev', { execFileSync });
    expect(result).toEqual({ created: false });
    expect(execFileSync.calls).toHaveLength(1);
  });

  test('role 與 db 都缺時，依序建立 role 再建立 database', async () => {
    const execFileSync = makeFakeExec({ directConnectFails: true, roleExists: false, dbExists: false });
    const result = await ensurePostgres('postgres://alice:pw@localhost:5432/aidev', { execFileSync });
    expect(result).toEqual({ created: true });
    const sqls = execFileSync.calls.map(c => c.args.join(' '));
    expect(sqls.some(s => s.includes('CREATE ROLE "alice"'))).toBe(true);
    expect(sqls.some(s => s.includes('CREATE DATABASE "aidev"'))).toBe(true);
  });

  test('role 已存在、只缺 db 時，不重建 role', async () => {
    const execFileSync = makeFakeExec({ directConnectFails: true, roleExists: true, dbExists: false });
    await ensurePostgres('postgres://alice:pw@localhost:5432/aidev', { execFileSync });
    const sqls = execFileSync.calls.map(c => c.args.join(' '));
    expect(sqls.some(s => s.includes('CREATE ROLE'))).toBe(false);
    expect(sqls.some(s => s.includes('CREATE DATABASE "aidev"'))).toBe(true);
  });
});
