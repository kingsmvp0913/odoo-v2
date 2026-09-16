// 意圖：健檢 AI 要能 SELECT 平台 DB，但絕不能讀到密文、密碼雜湊、session token；也不能靠任何 SQL 技巧切回 superuser。
// pg-mem 不支援角色與欄位權限，這裡只驗「產出的 SQL 對不對、連線用的是哪個帳號、擋不擋非唯讀語句」；
// 真正的權限效果由第 3 部的自我檢測在真 PG 上驗（用唯讀角色讀 users.password_hash 必須 permission denied）。
process.env.APP_SECRET = 'test-platform-readonly';
const r = require('../lib/platform-readonly');

describe('isSensitiveColumn：09-15 實查的敏感欄位全部命中，健檢要用的欄位不誤殺', () => {
  test.each(['db_password_enc', 'ssh_key_enc', 'ssh_key_path', 'ssh_password_enc', 'vpn_config_enc', 'vpn_password_enc',
    'e2e_password', 'sso_secret', 'token_hash', 'claude_oauth_token_enc', 'client_secret', 'context7_api_key_enc',
    'figma_api_key_enc', 'openai_api_key_enc', 'github_pat_enc', 'password_enc', 'password_hash'])('%s 是敏感欄位', c => {
    expect(r.isSensitiveColumn(c)).toBe(true);
  });
  test.each(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_create_tokens', 'baseline_passed',
    'original_text', 'analysis_yaml', 'agent_type', 'status'])('%s 可讀', c => {
    expect(r.isSensitiveColumn(c)).toBe(false);
  });
});

describe('assertReadOnlySql', () => {
  test.each(['SELECT 1', '  with x as (select 1) select * from x', '-- 註解\nSELECT 1', 'EXPLAIN SELECT 1', 'SELECT 1;'])('放行：%s', sql => {
    expect(() => r.assertReadOnlySql(sql)).not.toThrow();
  });
  test.each(['UPDATE users SET role=1', 'SELECT 1; DROP TABLE users', 'SELECT 1; RESET ROLE', '/* x */ DELETE FROM tasks', ''])('擋下：%s', sql => {
    expect(() => r.assertReadOnlySql(sql)).toThrow();
  });
});

test('roPassword 由 APP_SECRET 派生、穩定、不等於 APP_SECRET', () => {
  expect(r.roPassword()).toBe(r.roPassword());
  expect(r.roPassword()).toMatch(/^[a-f0-9]{64}$/);
  expect(r.roPassword()).not.toContain(process.env.APP_SECRET);
});

test('roConnectionString 換成唯讀帳號密碼，其餘不變', () => {
  const u = new URL(r.roConnectionString('postgres://odoo:superpw@127.0.0.1:8772/aidev'));
  expect(u.username).toBe('aidev_ai_ro');
  expect(u.password).toBe(r.roPassword());
  expect(u.host).toBe('127.0.0.1:8772');
  expect(u.pathname).toBe('/aidev');
  expect(u.toString()).not.toContain('superpw');
});

describe('buildRoleSql', () => {
  const cols = [
    { table_name: 'users', column_name: 'id' }, { table_name: 'users', column_name: 'username' },
    { table_name: 'users', column_name: 'password_hash' }, { table_name: 'users', column_name: 'github_pat_enc' },
    { table_name: 'tasks', column_name: 'id' }, { table_name: 'tasks', column_name: 'original_text' },
  ];
  const sql = r.buildRoleSql(cols, 'ab12').join('\n');
  test('LOGIN、非 superuser、預設唯讀交易、有 statement_timeout', () => {
    expect(sql).toMatch(/CREATE ROLE aidev_ai_ro LOGIN/);
    expect(sql).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
    expect(sql).toMatch(/SET default_transaction_read_only = on/);
    expect(sql).toMatch(/SET statement_timeout = '15s'/);
  });
  // 2c 會 REVOKE CONNECT FROM PUBLIC（計畫 X19）：沒有這條，角色建好了卻連不上，端點只會回連線錯誤
  test('明確授權連線到目前的資料庫', () => {
    expect(sql).toMatch(/GRANT CONNECT ON DATABASE %I TO aidev_ai_ro', current_database\(\)/);
  });
  test('先收回整表權限，再逐欄授權非敏感欄位', () => {
    expect(sql).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA public FROM aidev_ai_ro/);
    expect(sql).toMatch(/GRANT SELECT \("id", "username"\) ON public\."users" TO aidev_ai_ro/);
    expect(sql).toMatch(/GRANT SELECT \("id", "original_text"\) ON public\."tasks" TO aidev_ai_ro/);
  });
  test('敏感欄位明確 REVOKE，且不出現在任何 GRANT 裡', () => {
    expect(sql).toMatch(/REVOKE SELECT \("password_hash", "github_pat_enc"\) ON public\."users" FROM aidev_ai_ro/);
    for (const line of sql.split('\n').filter(l => l.startsWith('GRANT SELECT'))) {
      expect(line).not.toMatch(/password_hash|github_pat_enc/);
    }
  });
  test('密碼只接受 hex（避免 SQL 字串逸脫問題）', () => {
    expect(() => r.buildRoleSql(cols, "x'; DROP")).toThrow();
  });
});

test('ensureReadonlyRole：先查 information_schema 再依序執行產出的 SQL', async () => {
  const calls = [];
  const query = async (text) => {
    calls.push(text);
    if (/information_schema\.columns/.test(text)) return { rows: [{ table_name: 'users', column_name: 'id' }, { table_name: 'users', column_name: 'password_hash' }] };
    return { rows: [] };
  };
  const out = await r.ensureReadonlyRole({ query });
  expect(calls[0]).toMatch(/information_schema\.columns/);
  expect(calls.some(c => /GRANT SELECT \("id"\) ON public\."users"/.test(c))).toBe(true);
  expect(calls.some(c => /GRANT CONNECT ON DATABASE/.test(c))).toBe(true);
  expect(out).toEqual({ tables: 1, denied: ['users.password_hash'] });
});

describe('runReadonlyQuery', () => {
  function fakeClient(result, seen) {
    return class {
      constructor(cfg) { seen.cfg = cfg; }
      async connect() { seen.connected = true; }
      async query(q) { seen.q = q; return result; }
      async end() { seen.ended = true; }
    };
  }
  test('用唯讀帳號另開連線、以 extended protocol 送出（單一語句）、用完關閉', async () => {
    const seen = {};
    const Client = fakeClient({ fields: [{ name: 'id' }], rows: [{ id: 1 }] }, seen);
    const out = await r.runReadonlyQuery('SELECT id FROM tasks', { Client, databaseUrl: 'postgres://odoo:pw@127.0.0.1:8772/aidev' });
    expect(new URL(seen.cfg.connectionString).username).toBe('aidev_ai_ro');
    expect(seen.q).toEqual({ text: 'SELECT id FROM tasks', queryMode: 'extended' });
    expect(seen.ended).toBe(true);
    expect(out).toEqual({ columns: ['id'], rows: [{ id: 1 }], row_count: 1, truncated: false });
  });
  test(`超過 ${r.MAX_ROWS} 列截斷並標記`, async () => {
    const seen = {};
    const rows = Array.from({ length: r.MAX_ROWS + 3 }, (_, i) => ({ id: i }));
    const out = await r.runReadonlyQuery('SELECT id FROM tasks', { Client: fakeClient({ fields: [{ name: 'id' }], rows }, seen), databaseUrl: 'postgres://odoo:pw@h:1/d' });
    expect(out.rows.length).toBe(r.MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.row_count).toBe(r.MAX_ROWS + 3);
  });
  test('非唯讀語句連線都不開', async () => {
    const seen = {};
    await expect(r.runReadonlyQuery('DELETE FROM tasks', { Client: fakeClient({ rows: [] }, seen), databaseUrl: 'postgres://o:p@h:1/d' })).rejects.toThrow();
    expect(seen.connected).toBeUndefined();
  });
});
