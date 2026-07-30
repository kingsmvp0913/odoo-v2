/**
 * 重複啟動 server → 綁不到埠的那個行程必須自己結束，不可留下照樣派工的 cron。
 *
 * 這是實際事故的回歸測試：舊順序是先 `startCron()` 再 `httpServer.listen(PORT)`，且 listen 沒掛
 * error handler → EADDRINUSE 以 'error' 事件丟出 → 變成 uncaughtException → 被 index.js 的
 * 「最後防線」handler 只印 log、不 exit 接走。於是第二次啟動留下一個沒有 HTTP 埠、前端看不到、
 * 但 cron 每分鐘照樣 runPipeline 的隱形派工者；它與正常 server 各有一份自己的 `_inFlight`
 * （runner.js:31 ＝ 行程內記憶體），同一任務同一關就被派兩次：兩支 claude 並行寫同一個 worktree，
 * reentry_count 也被記兩次（MAX_REENTRY=2 在第一次真實彈跳就打滿）。
 *
 * 本檔用真的子行程跑真的 index.js 啟動路徑（DB 以 pg-mem 注入，維持 hermetic）：
 * 先把埠占住，再啟動一個 server，斷言它必須自己結束。
 */
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..', '..');            // app/
const SERVER_DIR = path.join(__dirname, '..');               // app/server/
const WAIT_FOR_EXIT_MS = 15000;

// 子行程：注入 pg-mem 當 DB → 記下 node-cron 排程動作 → 以「主模組」身分載入 index.js
const BOOTSTRAP = `
const path = require('path');
const serverDir = process.env.SERVER_DIR;
const db = require(path.join(serverDir, 'db.js'));
const { newDb } = require('pg-mem');
const { Pool } = newDb().adapters.createPg();
db._setPoolForTesting(new Pool());

// 只記錄「cron 有被排程」這件事並照常委派（證明 startCron 發生在 listen 之前）
const nodeCron = require('node-cron');
const origSchedule = nodeCron.schedule.bind(nodeCron);
nodeCron.schedule = (...args) => { console.log('[TEST] cron-scheduled'); return origSchedule(...args); };

const Module = require('module');
const idx = path.join(serverDir, 'index.js');
const m = new Module(idx, null);
m.filename = idx;
m.paths = Module._nodeModulePaths(path.dirname(idx));
process.mainModule = m;            // 讓 index.js 的 require.main === module 成立
Module._cache[idx] = m;
m.load(idx);
`;

function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    // 不指定 host：與 index.js:201 的 httpServer.listen(PORT) 綁法一致，否則 Windows 上
    // 0.0.0.0 與 :: 是兩個不同的 socket，占不住對方
    srv.listen(port, () => resolve(srv));
  });
}

async function freePort() {
  const srv = await occupy(0);
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

test('埠已被占用時重複啟動 server → 該行程必須結束，不可留下照樣派工的 cron', async () => {
  const port = await freePort();
  const blocker = await occupy(port);          // 模擬「前一個 server 還活著」
  let child;
  try {
    child = spawn(process.execPath, ['-e', BOOTSTRAP], {
      cwd: APP_DIR,
      env: { ...process.env, SERVER_DIR, PORT: String(port), JWT_SECRET: 'test-secret', DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });

    const exited = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), WAIT_FOR_EXIT_MS);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });

    // 前提檢查（測試本身沒跑偏）：真的走到 listen 且真的撞 EADDRINUSE。
    // 若 index.js 在抵達 listen 前就因別的原因掛掉，這裡會擋下來，避免整支測試假綠。
    expect(out + err).toContain('EADDRINUSE');

    // 真正的斷言：綁不到埠的行程必須自己結束，且在那之前不可已經把 cron 排下去。
    // 三個條件各自對應一種回歸：把 startCron() 搬回 listen 之前 → cron已排程 變 true；
    // 拿掉 httpServer 的 'error' handler → 行程已結束 變 false 且 吞掉致命錯誤 變 true。
    expect({
      行程已結束: exited,
      吞掉致命錯誤: /\[FATAL\] uncaughtException/.test(err),
      cron已排程: out.includes('[TEST] cron-scheduled'),
    }).toEqual({ 行程已結束: true, 吞掉致命錯誤: false, cron已排程: false });
  } finally {
    if (child && child.exitCode === null) child.kill();
    await new Promise(r => blocker.close(r));
  }
}, 30000);
