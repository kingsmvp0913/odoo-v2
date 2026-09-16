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
const express = require('express');

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
