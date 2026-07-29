// SSH 執行分支：mock ssh2，驗證 psql 出錯不會被吞成「成功 0 筆」。
// 這條路徑原本只看 exit code，而 psql 沒設 ON_ERROR_STOP 時 SQL 錯誤仍會 exit 0。
// mock 前綴是 jest 工廠允許引用外部變數的唯一豁免（babel 會擋其他名稱）
let mockSshResult = { stdout: '', stderr: '', code: 0 };

jest.mock('ssh2', () => ({
  Client: class {
    on(ev, cb) { if (ev === 'ready') this._ready = cb; return this; }
    connect() { process.nextTick(() => this._ready()); }
    exec(cmd, cb) {
      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      cb(null, stream);
      process.nextTick(() => {
        if (mockSshResult.stdout) stream.emit('data', Buffer.from(mockSshResult.stdout));
        if (mockSshResult.stderr) stream.stderr.emit('data', Buffer.from(mockSshResult.stderr));
        stream.emit('close', mockSshResult.code);
      });
    }
    end() {}
  },
}));

const { runSelect, buildPsqlCmd } = require('../lib/ssh-sql');

const conn = {
  connect_mode: 'docker', ssh_host: 'h', ssh_user: 'u', ssh_password: '',
  docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_prd',
};

test('SQL 錯誤但 psql exit 0：必須回錯誤，不得偽裝成成功的 0 筆', async () => {
  // psql 未設 ON_ERROR_STOP 時的真實行為：錯誤只進 stderr，exit code 仍是 0
  mockSshResult = { stdout: '', stderr: 'ERROR:  column "no_such_col" does not exist\n', code: 0 };
  const res = await runSelect(conn, 'SELECT no_such_col FROM res_users');
  expect(res.ok).toBe(false);
  expect(res.error).toContain('no_such_col');
});

test('exit 0 且 stdout 全空、stderr 也空：仍視為失敗（--csv 至少會有表頭）', async () => {
  mockSshResult = { stdout: '', stderr: '', code: 0 };
  const res = await runSelect(conn, 'SELECT 1');
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/未成功執行/);
});

test('真的查無資料：只有表頭仍是 ok 的 0 筆', async () => {
  mockSshResult = { stdout: 'id,login\n', stderr: '', code: 0 };
  const res = await runSelect(conn, 'SELECT id, login FROM res_users WHERE false');
  expect(res).toEqual({ ok: true, columns: ['id', 'login'], rows: [], row_count: 0 });
});

test('正常多筆：表頭與資料列各就各位', async () => {
  mockSshResult = { stdout: 'id,login\n2,admin\n6,user1\n', stderr: '', code: 0 };
  const res = await runSelect(conn, 'SELECT id, login FROM res_users');
  expect(res).toEqual({ ok: true, columns: ['id', 'login'], rows: [['2', 'admin'], ['6', 'user1']], row_count: 2 });
});

test('exit code 非 0：回 stderr 並濾掉 sudo 密碼提示', async () => {
  mockSshResult = { stdout: '', stderr: '[sudo] password for odoo:\nFATAL:  database "nope" does not exist\n', code: 3 };
  const res = await runSelect(conn, 'SELECT 1');
  expect(res.ok).toBe(false);
  expect(res.error).toContain('FATAL');
  expect(res.error).not.toContain('[sudo]');
});

test('psql 帶 ON_ERROR_STOP=1，讓 SQL 錯誤真的反映在 exit code', () => {
  for (const c of [
    { connect_mode: 'docker', ssh_password: 'pw', docker_container: 'c', db_user: 'u', db_name: 'd' },
    { connect_mode: 'docker', ssh_password: '', docker_container: 'c', db_user: 'u', db_name: 'd' },
    { connect_mode: 'local', ssh_password: 'pw', sudo_user: 'odoo', db_name: 'd' },
    { connect_mode: 'local', ssh_password: '', sudo_user: 'odoo', db_name: 'd' },
  ]) {
    expect(buildPsqlCmd(c, 'SELECT 1')).toContain('psql -v ON_ERROR_STOP=1');
  }
});
