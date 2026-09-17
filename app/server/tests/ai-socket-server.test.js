// 意圖：出口閘道唯一連得到的平台入口就是這個 socket 檔。它必須：只有 /ai/* 有東西（/api 一律 404）、
// 權限 600（別的 uid 連不上）、只認每次執行通行證（全域通行碼無效）。用真的 unix socket 驗，不靠 mock。
process.env.APP_SECRET = 'test-ai-socket';
process.env.JWT_SECRET = 'test-ai-socket-jwt';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const { AI_TOKEN_HEADER, aiToken } = require('../lib/ai-token');
const rt = require('../lib/agent-run-token');

let dbModule, server, sock, dir;
function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: urlPath, method: 'GET', headers }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query("INSERT INTO projects (name,folder_name,odoo_version) VALUES ('s','sock_p','17.0')");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisock-'));
  sock = path.join(dir, 'run', 'ai.sock');
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  server = await startAiSocketServer(sock);
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  dbModule._setPoolForTesting(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('socket 檔權限 600、所在目錄 700', () => {
  expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
});

test('非 /ai/ 路徑一律 404（/api 不經 socket 暴露）', async () => {
  expect((await get('/api/tasks')).status).toBe(404);
  expect((await get('/')).status).toBe(404);
});

test('帶本次通行證 → 200', async () => {
  rt._resetRunsForTesting();
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  const res = await get('/ai/wiki/pages?project=sock_p', { [AI_TOKEN_HEADER]: token });
  expect(res.status).toBe(200);
});

test('帶全域通行碼 → 401', async () => {
  const res = await get('/ai/wiki/pages?project=sock_p', { [AI_TOKEN_HEADER]: aiToken() });
  expect(res.status).toBe(401);
});

test('重啟時殘留的 socket 檔會被清掉重建', async () => {
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  await new Promise(r => server.close(r));
  // close 會移除 socket；手動放一個殘留 socket 模擬被 kill 的情形
  const stale = http.createServer();
  await new Promise(r => stale.listen(sock, r));
  stale.unref();
  server = await startAiSocketServer(sock);
  expect(fs.statSync(sock).isSocket()).toBe(true);
});

test('同路徑是一般檔案 → 丟例外（不亂刪不是 socket 的東西）', async () => {
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  const f = path.join(dir, 'run', 'not-a-socket');
  fs.writeFileSync(f, 'x');
  await expect(startAiSocketServer(f)).rejects.toThrow(/不是 socket/);
});
