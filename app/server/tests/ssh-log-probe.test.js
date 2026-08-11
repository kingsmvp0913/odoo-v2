jest.mock('../lib/vpn-gateway', () => ({ ensureGatewayRunning: jest.fn() }));
const { ensureGatewayRunning } = require('../lib/vpn-gateway');
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

// I5：execFn 拋例外（SSH 連線層失敗）過去會直接冒泡出 probeLogSource（未捕捉），route 層再
// 包成 HTTP 500——與 runLogTail 同一種 SSH 故障卻回 200+{ok:false,error:'[SSH] …'} 不對稱。
test('execFn 拋例外時不冒泡，轉成 ok:false 物件並帶 [SSH] 前綴', async () => {
  const exec = async () => { throw new Error('連線逾時'); };
  const r = await probeLogSource({}, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('[SSH]');
  expect(r.error).toContain('連線逾時');
});

// I5 併修：docker ps 非 0 exit（常見成因：帳號僅有 sudo、未加入 docker 群組）與「這台機器
// 根本沒跑 docker」過去回同一句話，會把「權限沒開」誤診成「這台沒跑 docker」。
test('docker ps 非 0 exit（權限不足）與泛用的「三種都偵測不到」訊息可區分', async () => {
  const exec = async (conn, cmd) => {
    if (cmd.includes('docker ps')) {
      return { stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket', code: 1 };
    }
    return { stdout: '', stderr: '', code: 1 };
  };
  const r = await probeLogSource({}, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('docker ps');
  expect(r.error).toContain('permission denied');
});

// I4：VPN 撥號失敗／逾時的例外訊息（vpn-gateway.js）不帶 [VPN] 前綴，withVpn 包起來補上，
// probeLogSource 與 runLogTail 共用同一個 withVpn，此處驗證探測入口也吃得到這個修法。
test('VPN 撥號失敗時帶 [VPN] 前綴（不是裸的原始例外訊息）', async () => {
  ensureGatewayRunning.mockRejectedValueOnce(new Error('VPN 連線逾時（40 秒內未能透過隧道連到 1.2.3.4:22），請確認 VPN 帳號密碼與設定檔是否正確'));
  const conn = { vpn_enabled: true, vpn: { containerName: 'x' }, vpn_forward_port: 22000 };
  const exec = async () => ({ stdout: '', stderr: '', code: 1 });
  const r = await probeLogSource(conn, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('[VPN]');
  expect(r.error).toContain('逾時');
});

// I6：direct 模式不經 SSH，log 功能一律走 SSH，必須在最前面擋下，不能落到下游繼續嘗試
// SSH 握手（更隱蔽的是 vpn-gateway 對 direct 模式回的 targetHostPort 是 db_host:db_port，
// 若不擋在最前面，withVpn 會把它當 SSH 埠用，對 Postgres 埠做 SSH 握手）。
test('direct 模式連線一律擋下，不嘗試任何連線', async () => {
  const exec = jest.fn();
  const r = await probeLogSource({ connect_mode: 'direct' }, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('direct');
  expect(exec).not.toHaveBeenCalled();
});
