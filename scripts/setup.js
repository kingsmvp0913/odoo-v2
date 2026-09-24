#!/usr/bin/env node
// scripts/setup.js — 跨平台安裝編排入口
// Usage: node scripts/setup.js [--skip-start]
const path = require('path');
const readline = require('readline');
const { execSync, execFileSync } = require('child_process');

const { ensureConfig } = require('./lib/config');
const { ensurePostgres } = require('./lib/postgres');
const { ensureClaudeEnv } = require('./lib/claude-env');
const { ensureCodexCli } = require('./lib/codex-env');
const { verifyRuntimeDeps } = require('./lib/checks');
const { restoreHandoff } = require('./lib/handoff');
const { ensureRtk } = require('./lib/rtk');
const { verifyDocker, ensureGatewayImage, ensureAgentImage } = require('./lib/docker');

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

  const dockerCheck = verifyDocker();
  if (dockerCheck.ok) {
    ensureGatewayImage();
    console.log('[OK] Docker 已就緒，VPN Gateway image 已備妥');
  } else {
    console.log(`[SKIP] 未偵測到 Docker，需要 VPN 才能連的資料庫查詢功能將無法使用（安裝 Docker 後重跑 node scripts/setup.js 即可補上）：${dockerCheck.hint}`);
  }

  await ensurePostgres(cfg.DATABASE_URL);
  console.log('[OK] PostgreSQL 已就緒');

  execSync('npm install --prefer-offline', { cwd: path.join(ROOT, 'app'), stdio: 'inherit' });
  console.log('[OK] npm install 完成');

  await ensureClaudeEnv();
  console.log('[OK] Claude Code 環境已就緒');

  ensureCodexCli();
  console.log('[OK] Codex CLI 已就緒');

  // 一定要排在接手包之前：接手包會偵測 rtk 在不在，決定要不要寫入那條 Bash hook。
  const rtk = ensureRtk();
  console.log(`[${rtk.status === 'done' ? 'OK' : rtk.status === 'failed' ? 'WARN' : 'SKIP'}] rtk：${rtk.detail}`);

  // 排在 Claude 環境之後：登入流程會先把 ~/.claude 建出來，設定才有地方合併。
  for (const step of restoreHandoff({ root: ROOT }).steps) {
    console.log(`[${step.status === 'done' ? 'OK' : 'SKIP'}] ${step.name}：${step.detail}`);
  }

  // 排在這裡是因為兩個 build-arg 分別要等 npm install（context7-mcp 版本）與 claude 安裝（claude --version）。
  // 建置失敗不中斷安裝——比照 Chrome：平台本身仍可用，缺的是容器隔離模式。但要大聲講，
  // 因為沙盒開關不是 off 時，映像缺了會讓「每一次」AI 呼叫失敗，而錯誤只出現在執行期。
  if (dockerCheck.ok && !process.argv.includes('--skip-agent-image')) {
    try {
      console.log('檢查 AI 沙盒映像（第一次建置要下載數百 MB，可能要很久；加 --skip-agent-image 可跳過）...');
      const r = ensureAgentImage();
      console.log(`[OK] AI 沙盒映像 ${r.image} ${r.built ? '已建置' : '已存在'}`);
    } catch (err) {
      console.error(`[WARN] AI 沙盒映像建置失敗：${err.message}`);
      console.error('       沙盒模式不是 off 時，AI 會全部因映像不存在而失敗。修好網路後重跑 node scripts/setup.js --skip-start 即可補建。');
    }
  } else if (dockerCheck.ok) {
    console.log('[SKIP] 未建 AI 沙盒映像（--skip-agent-image）。沙盒模式不是 off 時，AI 會全部失敗，記得補跑。');
  }

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
