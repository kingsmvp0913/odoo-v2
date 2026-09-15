// 意圖：測試區 Odoo 以前拿平台的 PG 超級使用者帳密（進測試區的人能讀平台 DB、別家測試資料、COPY TO PROGRAM
// 拿總鑰匙）。改成每個測試區自己的非超級使用者角色——這支守的是「帳密絕不帶到平台帳號」與
// 「轉擁有者的 SQL 不能用 REASSIGN OWNED」（09-15 實測：odoo 是 bootstrap 角色會報錯，且會連別的 DB 一起轉走）。
const { newDb } = require('pg-mem');
const role = require('../lib/testenv-db-role');

const PLATFORM_URL = 'postgres://odoo:platform-pw@localhost:8772/aidev';
let prevUrl;
beforeEach(() => { prevUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = PLATFORM_URL; });
afterEach(() => { if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl; });

describe('roleNameFor', () => {
  test('用專案 id 組出固定前綴的角色名', () => {
    expect(role.roleNameFor(18)).toBe('testenv_p18');
    expect(role.roleNameFor('7')).toBe('testenv_p7');
  });
  test('不是正整數一律拒絕（角色名會進 SQL）', () => {
    for (const bad of [0, -1, '1; DROP ROLE odoo', 'abc', null, undefined, 1.5]) {
      expect(() => role.roleNameFor(bad)).toThrow();
    }
  });
});

test('quoteIdent／quoteLiteral：大小寫混合的 DB 名與含引號的字串都要正確跳脫', () => {
  expect(role.quoteIdent('test_liSheng')).toBe('"test_liSheng"');
  expect(role.quoteIdent('a"b')).toBe('"a""b"');
  expect(role.quoteLiteral("it's")).toBe("'it''s'");
});

test('testEnvDbArgs：host／port 沿用平台 DB，帳密換成測試區角色——平台密碼不得出現', () => {
  const args = role.testEnvDbArgs({ role: 'testenv_p18', password: 'role-pw' });
  expect(args).toEqual(['--db_host', 'localhost', '--db_port', '8772', '--db_user', 'testenv_p18', '--db_password', 'role-pw']);
  expect(args.join(' ')).not.toContain('platform-pw');
  expect(args).not.toContain('odoo');
});

test('testEnvDbArgs：沒有 DATABASE_URL 時只帶角色帳密（容器端會補 host），不報錯也不帶任何平台帳號', () => {
  delete process.env.DATABASE_URL;
  expect(role.testEnvDbArgs({ role: 'testenv_p18', password: 'role-pw' })).toEqual(['--db_user', 'testenv_p18', '--db_password', 'role-pw']);
});

test('platformDbUser：取 DATABASE_URL 的帳號；沒設回 null', () => {
  expect(role.platformDbUser()).toBe('odoo');
  delete process.env.DATABASE_URL;
  expect(role.platformDbUser()).toBeNull();
});

describe('ownershipTransferSql', () => {
  const sql = role.ownershipTransferSql({ from: 'odoo', to: 'testenv_p18' });
  test('逐物件 ALTER OWNER，不用 REASSIGN OWNED', () => {
    expect(sql).not.toMatch(/REASSIGN\s+OWNED/i);
    expect(sql).toMatch(/ALTER %s %I\.%I OWNER TO %I/);
    expect(sql).toMatch(/ALTER ROUTINE %s OWNER TO %I/);
  });
  test('排除擴充套件成員與被表擁有的序列（改它們會報錯）', () => {
    expect(sql).toContain("d.deptype IN ('e', 'a', 'i')");
    expect(sql).toContain("d.deptype = 'e'");
  });
  test('來源與目標角色以字面值嵌入並跳脫', () => {
    const tricky = role.ownershipTransferSql({ from: "o'doo", to: 'testenv_p1' });
    expect(tricky).toContain("'o''doo'");
  });
});

describe('ensureTestEnvDbRole（假 PG client 記錄 SQL；odoo_envs 用 pg-mem）', () => {
  let dbModule;
  const PID = 18;
  beforeAll(async () => {
    process.env.APP_SECRET = process.env.APP_SECRET || 'test-app-secret-2c';
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    await dbModule.query(`INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-2c', '17.0', 'liSheng')`);
  });
  afterAll(() => dbModule._setPoolForTesting(null));
  beforeEach(async () => {
    await dbModule.query('DELETE FROM odoo_envs');
    await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1, 'setting_up')", [PID]);
  });

  // pg_roles／pg_database 的查詢依 fixture 回答，其餘 SQL 只記錄
  function fakePg({ roleExists = false, dbOwner = null } = {}) {
    const log = [];
    const createClient = (database) => ({
      connect: async () => {},
      end: async () => {},
      query: async (sql, params = []) => {
        log.push({ database, sql, params });
        if (/FROM pg_roles/.test(sql)) return { rows: roleExists ? [{ '?column?': 1 }] : [] };
        if (/FROM pg_database WHERE datname/.test(sql)) return { rows: dbOwner ? [{ owner: dbOwner }] : [] };
        return { rows: [] };
      },
    });
    return { createClient, log, sqls: () => log.map((l) => l.sql) };
  }

  test('全新測試區：建角色 → 平台先建 DB（擁有者＝角色）→ 撤 PUBLIC 連線 → 在該 DB 建 pg_trgm 並轉擁有者', async () => {
    const pg = fakePg();
    const r = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    expect(r.role).toBe('testenv_p18');
    const s = pg.sqls();
    const idx = (re) => s.findIndex((x) => re.test(x));
    expect(s[idx(/^CREATE ROLE/)]).toMatch(/^CREATE ROLE "testenv_p18" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '/);
    expect(s[idx(/^CREATE DATABASE/)]).toBe(`CREATE DATABASE "test_liSheng" OWNER "testenv_p18" ENCODING 'UTF8' LC_COLLATE 'C' TEMPLATE template0`);
    expect(idx(/^REVOKE CONNECT ON DATABASE "test_liSheng" FROM PUBLIC$/)).toBeGreaterThan(idx(/^CREATE DATABASE/));
    const ext = pg.log.find((l) => /CREATE EXTENSION IF NOT EXISTS pg_trgm/.test(l.sql));
    expect(ext.database).toBe('test_liSheng');                 // 建在測試 DB 裡，不是 postgres
    expect(idx(/^DO \$\$/)).toBeGreaterThan(idx(/CREATE EXTENSION/));
    expect(s.some((x) => /REASSIGN\s+OWNED/i.test(x))).toBe(false);
    expect(s.some((x) => /\bSUPERUSER\b/.test(x.replace(/NOSUPERUSER/g, '')))).toBe(false);
  });

  test('既有 DB 擁有者還是平台帳號：ALTER DATABASE OWNER，不重建 DB', async () => {
    const pg = fakePg({ roleExists: false, dbOwner: 'odoo' });
    await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    const s = pg.sqls();
    expect(s).toContain('ALTER DATABASE "test_liSheng" OWNER TO "testenv_p18"');
    expect(s.some((x) => /^CREATE DATABASE/.test(x))).toBe(false);
  });

  test('已經轉好的 DB：不再 ALTER DATABASE，但轉擁有者的 DO 區塊照跑（冪等，補轉之後 Odoo 以超級使用者建的漏網物件）', async () => {
    const pg = fakePg({ roleExists: true, dbOwner: 'testenv_p18' });
    await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    const s = pg.sqls();
    expect(s.some((x) => /^ALTER DATABASE/.test(x))).toBe(false);
    expect(s.some((x) => /^DO \$\$/.test(x))).toBe(true);
    expect(s.some((x) => /^ALTER ROLE "testenv_p18" LOGIN NOSUPERUSER/.test(x))).toBe(true);
  });

  test('密碼加密存進 odoo_envs、明文不落庫；下次沿用同一把（重建時容器與角色密碼不脫鉤）', async () => {
    const first = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: fakePg().createClient });
    const { rows: [env] } = await dbModule.query('SELECT db_password_enc FROM odoo_envs WHERE project_id=$1', [PID]);
    expect(env.db_password_enc).toBeTruthy();
    expect(env.db_password_enc).not.toContain(first.password);
    const second = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: fakePg({ roleExists: true, dbOwner: 'testenv_p18' }).createClient });
    expect(second.password).toBe(first.password);
    expect(await role.loadTestEnvDbCreds(PID)).toEqual({ role: 'testenv_p18', password: first.password });
  });

  test('存的密文解不開（例如 APP_SECRET 換過）：產新密碼並 ALTER ROLE 設進去，不沿用壞值', async () => {
    await dbModule.query("UPDATE odoo_envs SET db_password_enc='not:valid:cipher' WHERE project_id=$1", [PID]);
    const pg = fakePg({ roleExists: true, dbOwner: 'testenv_p18' });
    const r = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    expect(r.password).toMatch(/^[0-9a-f]{48}$/);
    expect(pg.sqls().find((x) => /^ALTER ROLE/.test(x))).toContain(`PASSWORD '${r.password}'`);
  });

  test('loadTestEnvDbCreds：沒存過密碼回 null（呼叫端據此大聲失敗，不退回平台帳號）', async () => {
    expect(await role.loadTestEnvDbCreds(PID)).toBeNull();
  });

  test('沒有 DATABASE_URL：直接失敗，不送任何 SQL', async () => {
    delete process.env.DATABASE_URL;
    const pg = fakePg();
    await expect(role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient })).rejects.toThrow(/DATABASE_URL/);
    expect(pg.log).toHaveLength(0);
  });
});

test('revokePublicConnectAll：每個允許連線的 DB（含平台 DB 與 postgres）都撤 PUBLIC 的 CONNECT', async () => {
  const log = [];
  const createClient = (database) => ({
    connect: async () => {}, end: async () => {},
    query: async (sql) => {
      log.push({ database, sql });
      if (/FROM pg_database/.test(sql)) return { rows: [{ datname: 'aidev' }, { datname: 'postgres' }, { datname: 'test_liSheng' }] };
      return { rows: [] };
    },
  });
  const n = await role.revokePublicConnectAll({ createClient });
  expect(n).toBe(3);
  expect(log[0].sql).toMatch(/WHERE datallowconn/);
  expect(log.slice(1).map((l) => l.sql)).toEqual([
    'REVOKE CONNECT ON DATABASE "aidev" FROM PUBLIC',
    'REVOKE CONNECT ON DATABASE "postgres" FROM PUBLIC',
    'REVOKE CONNECT ON DATABASE "test_liSheng" FROM PUBLIC',
  ]);
});
