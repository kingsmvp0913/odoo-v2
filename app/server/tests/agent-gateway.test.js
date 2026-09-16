// 意圖：容器唯一的出口。白名單外一律拒絕並留紀錄（事後查得到 AI 試圖連哪裡）；/ai 以外的路徑不轉發（/api 不經閘道暴露）。
// 用本機的真 TCP／unix socket 驗，白名單以注入的本機位址代替 api.anthropic.com。
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectProxy, createAiForwarder, ALLOWED_CONNECT } = require('../agent-gateway/gateway');

const listen = (srv, arg = 0) => new Promise(r => srv.listen(arg, '127.0.0.1', () => r(srv.address().port)));
const listenSock = (srv, p) => new Promise(r => srv.listen(p, r));
const close = srv => new Promise(r => srv.close(r));

function connectVia(proxyPort, dest) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: dest });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', res => resolve({ status: res.statusCode }));
    req.on('error', reject);
    req.end();
  });
}

test('正式白名單只有四個網域的 443', () => {
  expect([...ALLOWED_CONNECT].sort()).toEqual(['api.anthropic.com:443', 'context7.com:443', 'mcp.context7.com:443', 'platform.claude.com:443']);
});

describe('CONNECT proxy', () => {
  let target, targetPort, proxy, proxyPort, logs;
  beforeAll(async () => {
    target = net.createServer(s => s.on('data', d => s.write(`echo:${d}`)));
    targetPort = await listen(target);
    logs = [];
    proxy = createConnectProxy({ allow: new Set([`127.0.0.1:${targetPort}`]), log: o => logs.push(o) });
    proxyPort = await listen(proxy);
  });
  afterAll(async () => { await close(proxy); await close(target); });

  test('白名單內 → 200 且資料雙向通', async () => {
    const { status, socket } = await connectVia(proxyPort, `127.0.0.1:${targetPort}`);
    expect(status).toBe(200);
    const reply = await new Promise(r => { socket.once('data', d => r(String(d))); socket.write('ping'); });
    expect(reply).toBe('echo:ping');
    socket.destroy();
  });

  test('白名單外 → 403 並記下目的地', async () => {
    const { status } = await connectVia(proxyPort, 'example.com:443');
    expect(status).toBe(403);
    expect(logs).toContainEqual(expect.objectContaining({ type: 'deny', dest: 'example.com:443' }));
  });

  test('一般 HTTP 代理請求（非 CONNECT）→ 405', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: 'http://example.com/' }, res => resolve(res.statusCode));
      req.on('error', reject); req.end();
    });
    expect(status).toBe(405);
  });
});

describe('/ai 轉發', () => {
  let backend, fwd, fwdPort, dir, sock;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
    sock = path.join(dir, 'ai.sock');
    backend = http.createServer((req, res) => res.end(JSON.stringify({ path: req.url, token: req.headers['x-aidev-ai-token'] || null })));
    await listenSock(backend, sock);
    fwd = createAiForwarder({ socketPath: sock, log: () => {} });
    fwdPort = await listen(fwd);
  });
  afterAll(async () => { await close(fwd); await close(backend); fs.rmSync(dir, { recursive: true, force: true }); });

  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fwdPort, path: p, headers }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.end();
  });

  test('/ai/* 原樣轉進 socket，header 保留', async () => {
    const r = await get('/ai/wiki/pages?project=x', { 'x-aidev-ai-token': 't1' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ path: '/ai/wiki/pages?project=x', token: 't1' });
  });

  test.each(['/api/tasks', '/', '/aix/y'])('%s → 404，不轉發', async (p) => {
    expect((await get(p)).status).toBe(404);
  });

  test('socket 不存在 → 502', async () => {
    const bad = createAiForwarder({ socketPath: path.join(dir, 'missing.sock'), log: () => {} });
    const port = await listen(bad);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ai/x' }, res => resolve(res.statusCode));
      req.on('error', reject); req.end();
    });
    expect(status).toBe(502);
    await close(bad);
  });
});
