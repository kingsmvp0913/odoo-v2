#!/usr/bin/env node
// scripts/setup.js — 跨平台安裝編排入口
// Usage: node scripts/setup.js [--skip-start]
const path = require('path');
const readline = require('readline');
const { execSync, execFileSync } = require('child_process');

const { ensureConfig } = require('./lib/config');
const { ensurePostgres } = require('./lib/postgres');
const { ensureClaudeEnv } = require('./lib/claude-env');
const { verifyRuntimeDeps } = require('./lib/checks');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');

function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(name, defaultValue) {
      if (process.env[name]) return Promise.resolve(process.env[name]);
      return new Promise((resolve) => {
        const suffix = defaultValue ? ` [${defaultValue}]` : '';
        rl.question(`${name}${suffix}: `, (answer) => resolve(answer.trim() || defaultValue));
      });
    },
    close() { rl.close(); },
  };
}

async function main() {
  const skipStart = process.argv.includes('--skip-start');
  console.log('=== odoo-v2 一鍵安裝 ===');

  const asker = makeAsker();
  const cfg = await ensureConfig(CONFIG_PATH, (name, def) => asker.ask(name, def));
  asker.close();
  console.log('[OK] 設定檔就緒：' + CONFIG_PATH);

  const { ok, missing } = verifyRuntimeDeps();
  if (!ok) {
    console.error('缺少下列執行期相依，請安裝後重新執行 node scripts/setup.js：');
    for (const m of missing) console.error(`  - ${m.name}: ${m.hint}`);
    process.exit(1);
  }
  console.log('[OK] 執行期相依檢查通過');

  await ensurePostgres(cfg.DATABASE_URL);
  console.log('[OK] PostgreSQL 已就緒');

  execSync('npm install --prefer-offline', { cwd: path.join(ROOT, 'app'), stdio: 'inherit' });
  console.log('[OK] npm install 完成');

  await ensureClaudeEnv();
  console.log('[OK] Claude Code 環境已就緒');

  if (skipStart) {
    console.log('已略過啟動（--skip-start）。可自行執行 node app/server/index.js 或 ./start.ps1 / ./start.sh。');
    return;
  }

  process.env.DATABASE_URL = cfg.DATABASE_URL;
  process.env.JWT_SECRET = cfg.JWT_SECRET;
  process.env.APP_SECRET = cfg.APP_SECRET;
  process.env.PORT = String(cfg.PORT || 3939);
  if (cfg.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.ANTHROPIC_API_KEY;

  const url = `http://localhost:${process.env.PORT}/setup.html`;
  console.log(`啟動 AI Dev：${url}`);
  try {
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url]);
    else if (process.platform === 'darwin') execFileSync('open', [url]);
    else execFileSync('xdg-open', [url]);
  } catch {
    // 開瀏覽器失敗不擋啟動，使用者可自行開網址
  }

  require(path.join(ROOT, 'app', 'server', 'index.js'));
}

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  process.exit(1);
});
