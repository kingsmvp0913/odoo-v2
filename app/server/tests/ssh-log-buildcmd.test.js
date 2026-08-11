const { buildLogCmd, validateLogPath } = require('../lib/ssh-log');

const FROM = Date.parse('2026-08-10T06:13:00Z');
const TO   = Date.parse('2026-08-10T06:33:00Z');

test('docker 模式用 RFC3339 UTC（帶 Z）', () => {
  const cmd = buildLogCmd({ log_mode: 'docker', log_container: 'odoo-app' }, FROM, TO);
  expect(cmd).toContain('docker logs');
  expect(cmd).toContain('odoo-app');
  expect(cmd).toContain('--since 2026-08-10T06:13:00Z');
  expect(cmd).toContain('--until 2026-08-10T06:33:00Z');
});

// docker_container 存的是「資料庫」容器，Odoo 是另一個。用錯不會報錯，
// 只會回傳格式正常但完全不相干的 PostgreSQL log。
test('docker 模式只認 log_container，不回退 docker_container', () => {
  expect(() => buildLogCmd({ log_mode: 'docker', docker_container: 'odoo-db' }, FROM, TO)).toThrow(/log_container/);
});

// journalctl --since 預設解讀為主機本地時間，不明寫 UTC 會依主機時區飄移。
test('journald 模式明寫 UTC 且用 -o cat 去除 syslog 前綴', () => {
  const cmd = buildLogCmd({ log_mode: 'journald', log_unit: 'odoo' }, FROM, TO);
  expect(cmd).toContain('journalctl -u odoo');
  expect(cmd).toContain('--since "2026-08-10 06:13:00 UTC"');
  expect(cmd).toContain('--until "2026-08-10 06:33:00 UTC"');
  expect(cmd).toContain('-o cat');
});

// file 模式比對的是 log 檔內的時間戳，基準是 log 自己的時區，非 UTC。
test('file 模式依 log_tz_offset 換算後比對', () => {
  const cmd = buildLogCmd(
    { log_mode: 'file', log_path: '/var/log/odoo/odoo.log', log_tz_offset: 480 }, FROM, TO);
  expect(cmd).toContain('awk');
  expect(cmd).toContain('/var/log/odoo/odoo.log');
  expect(cmd).toContain('2026-08-10 14:13:00');   // +8h
  expect(cmd).toContain('2026-08-10 14:33:00');
});

test('file 模式 log_tz_offset 為 0 時等同 UTC', () => {
  const cmd = buildLogCmd({ log_mode: 'file', log_path: '/var/log/odoo/o.log', log_tz_offset: 0 }, FROM, TO);
  expect(cmd).toContain('2026-08-10 06:13:00');
});

// awk 的 inrange 狀態變數讓 traceback 續行跟隨所屬記錄；缺了它續行永遠不匹配範圍條件而被整批丟棄。
test('file 模式的 awk 帶 inrange 狀態，續行才跟得上', () => {
  const cmd = buildLogCmd({ log_mode: 'file', log_path: '/x.log', log_tz_offset: 0 }, FROM, TO);
  expect(cmd).toContain('inrange');
});

test('未探測（log_mode 為空）時丟出可辨識的錯誤', () => {
  expect(() => buildLogCmd({}, FROM, TO)).toThrow(/尚未偵測/);
});

test('log_path 白名單：只允許絕對路徑，拒絕 .. 與元字元', () => {
  expect(validateLogPath('/var/log/odoo/odoo.log')).toBe(true);
  expect(validateLogPath('/var/log/../../etc/shadow')).toBe(false);
  expect(validateLogPath('var/log/odoo.log')).toBe(false);
  expect(validateLogPath('/var/log/$(whoami).log')).toBe(false);
  expect(validateLogPath('/var/log/a;rm -rf /.log')).toBe(false);
});

test('容器名與 unit 名沿用既有連線欄位白名單', () => {
  expect(() => buildLogCmd({ log_mode: 'docker', log_container: 'a;rm -rf /' }, FROM, TO)).toThrow();
  expect(() => buildLogCmd({ log_mode: 'journald', log_unit: '$(id)' }, FROM, TO)).toThrow();
});

test('sudo 需求沿用既有 ssh_password 慣例', () => {
  const cmd = buildLogCmd({ log_mode: 'docker', log_container: 'c', ssh_password: 'pw' }, FROM, TO);
  expect(cmd).toContain('sudo -S');
});
