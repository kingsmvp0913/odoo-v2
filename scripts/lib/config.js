// scripts/lib/config.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { IDENT_RE } = require('./postgres');

function randomSecret() {
  return crypto.randomBytes(32).toString('base64');
}

// 在寫檔前就擋掉不合法的 PG_USER/PG_DB（只允許英數與底線、不可數字開頭）。
// 否則畸形值（如 email）會先被寫進 config.json，之後 ensurePostgres 才驗證失敗，
// 而 idempotent 的 ensureConfig 重跑時又跳過詢問、拿舊的壞值重試 → 使用者卡死。
function assertIdent(name, val) {
  if (!IDENT_RE.test(val)) {
    throw new Error(`${name} 格式不合法（僅允許英數與底線、不可數字開頭）：${val}`);
  }
}

// config.json 同時持有 DB 密碼、JWT 簽章金鑰與所有 *_enc 欄位的主金鑰。
// 不能只依賴 umask／父目錄 ACL：Windows 的 repo 常繼承「Authenticated Users 可修改」，
// Linux 的一般 umask 則會產生 0644。每次 setup 都重套一次，連既有安裝一併修正。
function restrictConfigFile(configPath, deps = {}) {
  const platform = deps.platform || process.platform;
  const chmod = deps.chmodSync || fs.chmodSync;
  const run = deps.execFileSync || execFileSync;
  if (platform !== 'win32') {
    chmod(configPath, 0o600);
    return;
  }

  const who = String(run('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }));
  const sid = who.match(/S-(?:\d+-)+\d+/i)?.[0];
  if (!sid) throw new Error('無法取得目前 Windows 使用者 SID，config.json ACL 未收緊');
  // 先重設明確 ACE，再移除繼承；僅 /inheritance:r 會留下檔案原本明確授予的廣泛權限。
  run('icacls', [configPath, '/reset'], { stdio: 'ignore' });
  run('icacls', [configPath, '/inheritance:r', '/grant:r',
    `*${sid}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'], { stdio: 'ignore' });
}

async function ensureConfig(configPath, ask) {
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let changed = false;
    if (!cfg.APP_SECRET) { cfg.APP_SECRET = randomSecret(); changed = true; }
    if (!cfg.JWT_SECRET) { cfg.JWT_SECRET = randomSecret(); changed = true; }
    if (changed) fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    restrictConfigFile(configPath);
    return cfg;
  }

  const pgHost = await ask('PG_HOST', 'localhost');
  const pgPort = await ask('PG_PORT', '5432');
  const pgDb = await ask('PG_DB', 'aidev');
  const pgUser = await ask('PG_USER', 'aidev');
  const pgPassword = await ask('PG_PASSWORD', '');
  const apiKey = await ask('ANTHROPIC_API_KEY', '');

  assertIdent('PG_USER', pgUser);
  assertIdent('PG_DB', pgDb);

  const cfg = {
    DATABASE_URL: `postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDb}`,
    JWT_SECRET: randomSecret(),
    APP_SECRET: randomSecret(),
    PORT: 3939,
  };
  if (apiKey) cfg.ANTHROPIC_API_KEY = apiKey;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  restrictConfigFile(configPath);
  return cfg;
}

module.exports = { ensureConfig, randomSecret, restrictConfigFile };
