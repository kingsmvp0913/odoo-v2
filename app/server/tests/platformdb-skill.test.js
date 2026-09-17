// 意圖：健檢 AI 在容器裡照 SKILL.md 跑 query.js，沒有 DATABASE_URL、也沒有 app/node_modules，
// 必須自動改走 /ai/platform/query；有 DATABASE_URL 的互動式／舊路徑行為不變。唯讀護欄在兩條路上都要先擋。
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const QUERY_JS = path.join(__dirname, '..', '..', '..', '.claude', 'skills', 'platformDB', 'query.js');
function runQuery(args, env) {
  return new Promise(resolve => execFile(process.execPath, [QUERY_JS, ...args], { env, cwd: require('os').tmpdir() },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
}

let server, port, seen;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      seen = { url: req.url, token: req.headers['x-aidev-ai-token'], body: JSON.parse(body || '{}') };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, columns: ['n'], rows: [{ n: 42 }], row_count: 1, truncated: false }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));

test('沒有 DATABASE_URL、有 AIDEV_AI_BASE／TOKEN → 打 /ai/platform/query 並帶通行證', async () => {
  seen = null;
  const r = await runQuery(['--json', 'SELECT COUNT(*) n FROM tasks'], { PATH: process.env.PATH, AIDEV_AI_BASE: `http://127.0.0.1:${port}`, AIDEV_AI_TOKEN: 'run-tok' });
  expect(r.code).toBe(0);
  expect(seen).toEqual({ url: '/ai/platform/query', token: 'run-tok', body: { sql: 'SELECT COUNT(*) n FROM tasks' } });
  expect(JSON.parse(r.stdout)).toEqual([{ n: 42 }]);
});

test('/ai 回 ok:false → exit 1 並印出錯誤', async () => {
  const s2 = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{"ok":false,"error":"permission denied for table users"}')); });
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const r = await runQuery(['SELECT password_hash FROM users'], { PATH: process.env.PATH, AIDEV_AI_BASE: `http://127.0.0.1:${s2.address().port}`, AIDEV_AI_TOKEN: 't' });
  await new Promise(res => s2.close(res));
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/permission denied/);
});

test('非唯讀語句在送出前就擋（exit 2），不打 /ai', async () => {
  seen = null;
  const r = await runQuery(['DELETE FROM tasks'], { PATH: process.env.PATH, AIDEV_AI_BASE: `http://127.0.0.1:${port}`, AIDEV_AI_TOKEN: 't' });
  expect(r.code).toBe(2);
  expect(seen).toBeNull();
});
