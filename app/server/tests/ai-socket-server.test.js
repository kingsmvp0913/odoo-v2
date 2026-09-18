// 意圖：出口閘道唯一連得到的平台入口就是這個 socket 檔。它必須：只有 /ai/* 有東西（/api 一律 404）、
// 權限 600（別的 uid 連不上）、只認每次執行通行證（全域通行碼無效）。用真的 unix socket 驗，不靠 mock。
process.env.APP_SECRET = 'test-ai-socket';
process.env.JWT_SECRET = 'test-ai-socket-jwt';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
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

test('殘留的死 socket 檔（前一個佔用者被 kill）會被清掉重建', async () => {
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  await new Promise(r => server.close(r));
  // 真的造一個「檔在、沒人聽」的殘留：子行程 bind 之後被 SIGKILL。
  // 原本這裡是在同一個行程裡開一個「活的」listener，那根本不是被 kill 的形狀——
  // 行程正常結束時 Node 會把 socket 檔刪掉，留得下檔案的只有被 SIGKILL 這一種。
  // 造錯形狀的後果很實際：它讓「搶佔正在服務中的 socket」看起來是正常行為（2026-09-18 正式環境事故）。
  const oneLiner = 'require("net").createServer().listen(process.argv[1], () => console.log("bound"))';
  const child = spawn(process.execPath, ['-e', oneLiner, sock]);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('bound')) resolve(); });
    child.once('error', reject);
    setTimeout(() => reject(new Error('子行程沒有在時限內 bind')), 10000);
  });
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  expect(fs.lstatSync(sock).isSocket()).toBe(true);   // 檔還在，但沒人聽

  server = await startAiSocketServer(sock);
  expect(fs.statSync(sock).isSocket()).toBe(true);
});

test('已經有人在聽同一個 socket → 大聲失敗，絕不搶佔', async () => {
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  // 這一支守的是 2026-09-18 的正式環境事故：容器模式下，任何第二份平台程式只要跑一秒，
  // 就會把正在服務的 /ai socket 砍掉換成自己的；它結束後正式的那支還在聽已被 unlink 的 inode，
  // 路徑上卻是一個沒人聽的死檔 ⇒ 之後每一次 /ai 查詢都 ECONNREFUSED，而且平台完全不知道。
  // 此時 server 正在聽 sock（上一支測試重建的）。
  await expect(startAiSocketServer(sock)).rejects.toThrow(/已經有行程在聽/);
  // 搶佔失敗不能反而把服務中的 socket 弄壞
  const res = await get('/api/anything');
  expect(res.status).toBe(404);
});

test('同路徑是一般檔案 → 丟例外（不亂刪不是 socket 的東西）', async () => {
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  const f = path.join(dir, 'run', 'not-a-socket');
  fs.writeFileSync(f, 'x');
  await expect(startAiSocketServer(f)).rejects.toThrow(/不是 socket/);
});
