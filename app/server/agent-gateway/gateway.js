// app/server/agent-gateway/gateway.js
/**
 * 出口閘道（子專案 0 §4.3）。跑在 <實例id>-gw 容器內，同時接 internal 網路與預設 bridge；**不持有任何憑證**。
 *   3128：HTTPS CONNECT proxy，只放行 ALLOWED_CONNECT；其餘 403 並寫一行 JSON 到 stdout（docker logs 看得到）
 *   8080：/ai/* 轉發到掛入的 unix socket（平台 node 的 /ai 入口）；其餘 404
 * 只用 node 內建模組：閘道容器沿用平台映像的 node，不另裝套件。
 * 來源只記 IP（閘道沒有 docker socket，查不到容器名）；對應容器用 `docker network inspect <net>` 查（計畫 X14）。
 */
const http = require('http');
const net = require('net');

const ALLOWED_CONNECT = new Set([
  'api.anthropic.com:443',
  'platform.claude.com:443',
  'context7.com:443',
  'mcp.context7.com:443',
]);

const defaultLog = obj => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`);

function createConnectProxy({ allow = ALLOWED_CONNECT, log = defaultLog } = {}) {
  const server = http.createServer((req, res) => {
    log({ type: 'deny-method', method: req.method, url: req.url, src: req.socket.remoteAddress });
    res.writeHead(405).end('only CONNECT is allowed');
  });
  server.on('connect', (req, clientSocket, head) => {
    const dest = String(req.url || '').toLowerCase();
    const src = clientSocket.remoteAddress;
    if (!allow.has(dest)) {
      log({ type: 'deny', dest, src });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const idx = dest.lastIndexOf(':');
    const upstream = net.connect(Number(dest.slice(idx + 1)), dest.slice(0, idx), () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const done = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', err => { log({ type: 'upstream-error', dest, src, error: err.message }); clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    clientSocket.on('error', done);
  });
  return server;
}

function createAiForwarder({ socketPath, log = defaultLog }) {
  if (!socketPath) throw new Error('缺 socketPath');
  return http.createServer((req, res) => {
    if (!String(req.url || '').startsWith('/ai/')) { res.writeHead(404).end('not found'); return; }
    const up = http.request({ socketPath, path: req.url, method: req.method, headers: req.headers }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', err => {
      log({ type: 'ai-forward-error', path: req.url, error: err.message });
      if (!res.headersSent) res.writeHead(502);
      res.end('platform /ai socket unavailable');
    });
    req.pipe(up);
  });
}

if (require.main === module) {
  const socketPath = process.env.AIDEV_AI_SOCKET;
  if (!socketPath) { console.error('AIDEV_AI_SOCKET 未設定'); process.exit(1); }
  createConnectProxy().listen(3128, '0.0.0.0', () => defaultLog({ type: 'listen', port: 3128 }));
  createAiForwarder({ socketPath }).listen(8080, '0.0.0.0', () => defaultLog({ type: 'listen', port: 8080, socketPath }));
}

module.exports = { ALLOWED_CONNECT, createConnectProxy, createAiForwarder };
