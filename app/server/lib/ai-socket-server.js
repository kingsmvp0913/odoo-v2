// app/server/lib/ai-socket-server.js
/**
 * ai-socket-server.js — 容器經出口閘道打 /ai 的唯一入口（子專案 0 §3、§4.4；總覽 D8）
 *
 * 為什麼是 unix socket：平台是 host 網路，閘道從 bridge 連回 8771 的來源 IP 與 nginx 反代進來的一樣，
 * 用 IP 分不出是誰。socket 檔只有掛了 data/run 的閘道容器碰得到。
 * 只掛 /ai/*：同一批 route 檔也註冊了 /api 路由，前置 middleware 一律 404 擋掉。
 * req.aidevVia 只在這個 app 設定；TCP 那個 app 永遠沒有這個欄位，無從偽造。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const express = require('express');

// 試連一次，判斷這個 socket 檔背後「有沒有行程在聽」。
// 連得上＝有人在服務；ECONNREFUSED／ENOENT＝前一個佔用者被 SIGKILL 留下的死檔，可以安全清掉。
// 其餘錯誤（EACCES、逾時等）一律當成「有人在聽」——寧可大聲失敗，也不要把別人正在服務的 socket 搶走。
function isSocketAlive(sockPath, timeoutMs = 1000) {
  return new Promise(resolve => {
    const probe = net.connect(sockPath);
    let settled = false;
    const done = alive => { if (settled) return; settled = true; probe.destroy(); resolve(alive); };
    probe.setTimeout(timeoutMs, () => done(true));
    probe.once('connect', () => done(true));
    probe.once('error', err => done(!(err.code === 'ECONNREFUSED' || err.code === 'ENOENT')));
  });
}

function aiSocketPath() {
  return process.env.AIDEV_AI_SOCKET || path.join(__dirname, '..', '..', '..', 'data', 'run', 'ai.sock');
}

function createAiSocketApp() {
  const app = express();
  app.use((req, res, next) => {
    if (!req.path.startsWith('/ai/')) return res.status(404).json({ ok: false, error: 'Not found' });
    req.aidevVia = 'socket';
    return next();
  });
  app.use(express.json());
  require('../db-query-routes').registerRoutes(app);
  require('../wiki-routes').registerRoutes(app);
  require('../ai-task-routes').registerRoutes(app);
  require('../ai-platform-routes').registerRoutes(app);
  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
  return app;
}

async function startAiSocketServer(sockPath) {
  if (Buffer.byteLength(sockPath) >= 104) throw new Error(`unix socket 路徑太長（上限 103 bytes）：${sockPath}`);
  const dir = path.dirname(sockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let st = null;
  try { st = fs.lstatSync(sockPath); } catch { st = null; }
  if (st) {
    if (!st.isSocket()) throw new Error(`${sockPath} 已存在且不是 socket，拒絕覆蓋`);
    // 砍之前必須先確認沒有人在聽。只看「檔案存在且是 socket」就 unlink 的話，容器模式下
    // 任何第二份平台程式（跑測試、手動起一次 server）都會把正在服務的 socket 靜默搶走：
    // 它結束之後，正式那支還在聽已經被 unlink 的 inode，路徑上卻是一個沒人聽的死檔
    // ⇒ 之後每一次 /ai 查詢都 ECONNREFUSED，而且平台一行 log 都不會寫。
    // 2026-09-18 正式環境實際發生過：對話 AI 查不到客戶資料庫，症狀只出現在 AI 那一側。
    if (await isSocketAlive(sockPath)) {
      throw new Error(`${sockPath} 已經有行程在聽，拒絕搶佔——請先停掉那個平台實例再啟動`);
    }
    fs.unlinkSync(sockPath);
  }
  const server = http.createServer(createAiSocketApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => { server.off('error', reject); resolve(); });
  });
  fs.chmodSync(sockPath, 0o600);
  return server;
}

module.exports = { aiSocketPath, createAiSocketApp, startAiSocketServer };
