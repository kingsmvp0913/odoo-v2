const { looksLikeOdooLog, deriveTzOffset, probeLogSource } = require('../lib/ssh-log');

const LINE = '2026-08-10 14:23:45,123 1234 INFO test_db odoo.http: request done';

test('辨識 Odoo log 格式', () => {
  expect(looksLikeOdooLog(LINE)).toBe(true);
  expect(looksLikeOdooLog('2026-08-10 14:23:45.123 UTC [1] LOG:  database system is ready')).toBe(false);
  expect(looksLikeOdooLog('')).toBe(false);
});

test('推算時區偏移並吸收到 30 分鐘級距', () => {
  // log 最後一行 14:23，遠端 UTC 06:25 → +7h58m，吸收為 +480
  expect(deriveTzOffset('2026-08-10 14:23:45,123', '2026-08-10 06:25:10')).toBe(480);
  expect(deriveTzOffset('2026-08-10 06:23:45,123', '2026-08-10 06:25:10')).toBe(0);
});

test('偏移超過 14 小時判定推算失敗', () => {
  expect(deriveTzOffset('2026-08-11 20:00:00,000', '2026-08-10 06:00:00')).toBeNull();
});

test('探測依序試 docker → journald → file，取第一個成功者', async () => {
  const calls = [];
  const exec = async (conn, cmd) => {
    calls.push(cmd);
    if (cmd.includes('docker ps')) return { stdout: 'odoo-app\nodoo-db\n', stderr: '', code: 0 };
    if (cmd.includes('docker logs')) return { stdout: LINE, stderr: '', code: 0 };
    if (cmd.includes('date -u')) return { stdout: '2026-08-10 06:25:10', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 1 };
  };
  const r = await probeLogSource({}, exec);
  expect(r.ok).toBe(true);
  expect(r.log_mode).toBe('docker');
  expect(r.log_container).toBe('odoo-app');
  expect(r.log_tz_offset).toBe(480);
  expect(calls.some(c => c.includes('journalctl'))).toBe(false);
});

// 拿到 PostgreSQL 容器的 log 不會報錯，只會回傳完全不相干的內容——
// 所以候選容器必須以「輸出是否為 Odoo log 格式」驗證，不能只看名字。
test('容器名含 odoo 但輸出非 Odoo 格式則不採用', async () => {
  const exec = async (conn, cmd) => {
    if (cmd.includes('docker ps')) return { stdout: 'odoo-db\n', stderr: '', code: 0 };
    if (cmd.includes('docker logs')) return { stdout: '2026-08-10 06:00:00.000 UTC [1] LOG:  ready', stderr: '', code: 0 };
    if (cmd.includes('journalctl')) return { stdout: LINE, stderr: '', code: 0 };
    if (cmd.includes('date -u')) return { stdout: '2026-08-10 06:25:10', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 1 };
  };
  const r = await probeLogSource({}, exec);
  expect(r.ok).toBe(true);
  expect(r.log_mode).toBe('journald');
});

test('三種都失敗時回報失敗，不猜測', async () => {
  const exec = async () => ({ stdout: '', stderr: '', code: 1 });
  const r = await probeLogSource({}, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('偵測');
});

test('探測到來源但時區推算失敗時仍回報失敗（不留錯的偏移）', async () => {
  const exec = async (conn, cmd) => {
    if (cmd.includes('docker ps')) return { stdout: 'odoo-app\n', stderr: '', code: 0 };
    if (cmd.includes('docker logs')) return { stdout: LINE, stderr: '', code: 0 };
    if (cmd.includes('date -u')) return { stdout: '2026-08-01 06:25:10', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 1 };
  };
  const r = await probeLogSource({}, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('時區');
});
