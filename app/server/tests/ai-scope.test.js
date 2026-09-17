// 意圖（規格 §8.2）：從 socket 進來的請求一律只認「這次執行」的通行證——舊的全域通行碼在 socket 上無效，
// 過期／作廢回 401；scope 沒開的端點群組回 403；project scope 查別專案回 403。
// TCP loopback 的舊路徑（互動式 /getSQL）行為完全不變。
process.env.APP_SECRET = 'test-ai-scope-secret';
const express = require('express');
const request = require('supertest');
const { aiEndpointGuard, aiToken, AI_TOKEN_HEADER } = require('../lib/ai-token');
const { requireAiEndpoint, projectForbidden, forbidProject } = require('../lib/ai-scope');
const rt = require('../lib/agent-run-token');

function socketLikeApp() {
  const app = express();
  app.use((req, _res, next) => { req.aidevVia = 'socket'; next(); });
  app.get('/ai/db/probe', aiEndpointGuard, requireAiEndpoint('db'), (req, res) => {
    if (projectForbidden(req, Number(req.query.pid))) return forbidProject(res);
    res.json({ ok: true, run: req.aiRun });
  });
  app.post('/ai/platform/query', aiEndpointGuard, requireAiEndpoint('platform'), (req, res) => res.json({ ok: true }));
  return app;
}
function tcpApp() {
  const app = express();
  app.get('/ai/db/probe', aiEndpointGuard, requireAiEndpoint('db'), (req, res) => res.json({ ok: true, run: req.aiRun }));
  return app;
}

beforeEach(() => rt._resetRunsForTesting());

test('socket＋本次通行證 → 放行並帶出 aiRun', async () => {
  const { token } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(200);
  expect(res.body.run.scope).toBe('project-7');
});

test('A 專案的通行證查 B 專案 → 403', async () => {
  const { token } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=8').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(403);
});

test('過期的通行證 → 401', async () => {
  const { token } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 1, now: Date.now() - 10000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(401);
});

test('已作廢的通行證 → 401', async () => {
  const { token, runId } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  rt.revokeRun(runId);
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(401);
});

test('socket 上帶舊的全域通行碼 → 401', async () => {
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(401);
});

test('非 internal-audit 呼叫 /ai/platform/query → 403（含 internal-fix，R6-A）', async () => {
  for (const [scope, pid] of [['project-7', 7], ['internal-fix', null], ['none', null]]) {
    const { token } = rt.issueRunToken({ scope, projectId: pid, ttlMs: 60000 });
    const res = await request(socketLikeApp()).post('/ai/platform/query').set(AI_TOKEN_HEADER, token);
    expect(res.status).toBe(403);
  }
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  expect((await request(socketLikeApp()).post('/ai/platform/query').set(AI_TOKEN_HEADER, token)).status).toBe(200);
});

test('internal scope 查客戶正式 DB 群組 → 403', async () => {
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(403);
});

test('TCP loopback 舊路徑行為不變：全域通行碼放行、aiRun 為 null', async () => {
  const res = await request(tcpApp()).get('/ai/db/probe').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.run).toBeNull();
});

test('TCP 上帶每次執行通行證不算數（舊路徑只認全域通行碼）', async () => {
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  const res = await request(tcpApp()).get('/ai/db/probe').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(403);
});
