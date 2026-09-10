// 意圖（Rule 9）：ssh2 預設「完全不驗對方是誰」——沒給 hostVerifier 就照單全收
// （它自己的 debug 訊息就寫著 'Host accepted by default (no verification)'）。
// 少了驗證，任何能坐在網路路徑上的人都能冒充客戶主機，收下我們送過去的 SSH 密碼與
// sudo 密碼，再回傳假的成功輸出。慈雲那台走公開網路，這不是理論風險。
//
// 這裡守的是 TOFU 的四種情形：沒得比對、第一次記錄、指紋相同、指紋不同。
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-ssh-host-key';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, buildConnectConfig, fingerprint;
const KEY_A = Buffer.from('ssh-ed25519 AAAA-machine-a');
const KEY_B = Buffer.from('ssh-ed25519 AAAA-machine-b');

// hostVerifier 是 callback 形式（回 undefined、之後才呼叫 verify），包成 Promise 好斷言
const ask = (cfg, key) => new Promise((resolve) => { cfg.hostVerifier(key, resolve); });

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p', '17.0')");
  await dbModule.query(
    "INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name) VALUES (1, '正式', '10.0.0.9', 'arich', 'odoo_prd')"
  );
  ({ buildConnectConfig, fingerprint } = require('../lib/ssh-exec'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

const resetKey = (v) => dbModule.query('UPDATE db_connections SET ssh_host_key = $1 WHERE id = 1', [v]);

// 這條是整個修正的核心：設定裡一定要有 hostVerifier，否則 ssh2 自動放行任何主機。
test('連線設定一定帶 hostVerifier（少了它 ssh2 會無條件信任任何主機）', () => {
  const cfg = buildConnectConfig({ id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p' }, 15000);
  expect(typeof cfg.hostVerifier).toBe('function');
});

test('第一次連線：記下指紋並放行（TOFU）', async () => {
  await resetKey(null);
  const cfg = buildConnectConfig({ id: 1, ssh_host: 'h', ssh_user: 'u' }, 15000);
  expect(await ask(cfg, KEY_A)).toBe(true);
  const { rows } = await dbModule.query('SELECT ssh_host_key FROM db_connections WHERE id = 1');
  expect(rows[0].ssh_host_key).toBe(fingerprint(KEY_A));
});

test('指紋相同：放行', async () => {
  await resetKey(fingerprint(KEY_A));
  const cfg = buildConnectConfig({ id: 1, ssh_host: 'h', ssh_user: 'u' }, 15000);
  expect(await ask(cfg, KEY_A)).toBe(true);
});

// 這一條就是「有人冒充客戶主機」的樣子。放行等於把密碼送給對方。
test('指紋不同：拒絕，且不覆寫已記錄的指紋', async () => {
  await resetKey(fingerprint(KEY_A));
  const cfg = buildConnectConfig({ id: 1, ssh_host: 'h', ssh_user: 'u' }, 15000);
  expect(await ask(cfg, KEY_B)).toBe(false);
  const { rows } = await dbModule.query('SELECT ssh_host_key FROM db_connections WHERE id = 1');
  expect(rows[0].ssh_host_key).toBe(fingerprint(KEY_A));
});

// 「測試連線」按鈕在連線還沒存檔時沒有 id，天生沒有可比對的舊指紋＝等同 TOFU 的第一次。
// 刻意不用 host:port 當鍵：走 VPN 時 host 會被改寫成 127.0.0.1、port 是動態配的轉發埠，
// 拿它當鍵等於每次都是新主機，驗證形同虛設。
test('沒有 conn.id 時放行（尚未存檔的連線，沒有可比對的對象）', async () => {
  const cfg = buildConnectConfig({ ssh_host: 'h', ssh_user: 'u' }, 15000);
  expect(await ask(cfg, KEY_B)).toBe(true);
});
