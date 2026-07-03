const { buildPsqlCmd } = require('../lib/ssh-sql');

const base = { db_name: 'odoo_prd' };

test('docker mode 有密碼', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'docker', ssh_password: 'pw', docker_container: 'odoo-db', db_user: 'odoo' }, 'SELECT 1');
  expect(cmd).toContain('sudo -S');
  expect(cmd).toContain('docker exec -i odoo-db');
  expect(cmd).toContain('psql -U odoo -d odoo_prd --csv');
  expect(cmd).toContain('base64 -d');
});

test('docker mode 無密碼', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'docker', ssh_password: '', docker_container: 'c', db_user: 'u' }, 'SELECT 1');
  expect(cmd).toContain('sudo docker exec -i c');
  expect(cmd).not.toContain('sudo -S');
});

test('local mode 有密碼', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'local', ssh_password: 'pw', sudo_user: 'odoo' }, 'SELECT 1');
  expect(cmd).toContain('sudo -S -u odoo');
  expect(cmd).toContain('psql -d odoo_prd --csv');
});

test('SQL 以 base64 編碼帶入', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'docker', ssh_password: '', docker_container: 'c', db_user: 'u' }, 'SELECT 42');
  expect(cmd).toContain(Buffer.from('SELECT 42', 'utf8').toString('base64'));
});
