// 意圖：容器進來的 /ai 請求只認這張通行證。它必須：綁住 scope 與專案（改一個字就失效）、
// 執行結束立刻作廢（不是等到期）、平台重啟後全部失效（清單在記憶體）、外洩也賠不到 APP_SECRET。
process.env.APP_SECRET = 'test-secret-run-token';
const t = require('../lib/agent-run-token');

beforeEach(() => t._resetRunsForTesting());

test('簽發後驗得過，並帶出 scope、專案與可用端點', () => {
  const { token, runId } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const v = t.verifyRunToken(token);
  expect(v.ok).toBe(true);
  expect(v.run).toEqual({ runId, scope: 'project-7', projectId: 7, endpoints: ['db', 'wiki', 'tasks', 'glossary'] });
});

test('執行結束作廢後立刻驗不過（不只看到期時間）', () => {
  const { token, runId } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 3600000 });
  t.revokeRun(runId);
  expect(t.verifyRunToken(token)).toEqual({ ok: false, reason: expect.stringMatching(/作廢|不在執行中/) });
});

test('過期驗不過', () => {
  const now = 1_000_000;
  const { token } = t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000, now });
  expect(t.verifyRunToken(token, now + 500).ok).toBe(true);
  expect(t.verifyRunToken(token, now + 1001).ok).toBe(false);
});

// 竄改 scope／專案是最直接的越權手法：把 project-7 改成 project-8 或 internal-audit
test.each([
  [(parts) => { parts[2] = 'project-8'; parts[3] = '8'; }],
  [(parts) => { parts[2] = 'internal-audit'; parts[3] = '0'; }],
  [(parts) => { parts[4] = String(Number(parts[4]) + 999999); }],
])('竄改任何欄位都驗不過', (mutate) => {
  const { token } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const parts = token.split('.');
  mutate(parts);
  expect(t.verifyRunToken(parts.join('.')).ok).toBe(false);
});

test('平台重啟（清單清空）後舊通行證全部失效', () => {
  const { token } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  t._resetRunsForTesting();
  expect(t.verifyRunToken(token).ok).toBe(false);
});

test('舊的全域通行碼不是合法的每次執行通行證', () => {
  const { aiToken } = require('../lib/ai-token');
  expect(t.verifyRunToken(aiToken()).ok).toBe(false);
  expect(t.verifyRunToken('').ok).toBe(false);
  expect(t.verifyRunToken(undefined).ok).toBe(false);
});

test('通行證不含 APP_SECRET，且與全域通行碼用不同金鑰', () => {
  const { token } = t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 60000 });
  expect(token).not.toContain(process.env.APP_SECRET);
  expect(t.RUN_TOKEN_LABEL).not.toBe('aidev:ai-endpoints:v1');
});

test('APP_SECRET 未設定時拒絕簽發（fail closed）', () => {
  const saved = process.env.APP_SECRET;
  delete process.env.APP_SECRET;
  try { expect(() => t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000 })).toThrow(/APP_SECRET/); }
  finally { process.env.APP_SECRET = saved; }
});

test('project scope 的 projectId 必須與 scope 一致，否則拒絕簽發', () => {
  expect(() => t.issueRunToken({ scope: 'project-7', projectId: 8, ttlMs: 1000 })).toThrow();
  expect(() => t.issueRunToken({ scope: 'internal-fix', projectId: 3, ttlMs: 1000 })).toThrow();
});

test('canRun 本期恆為 true（檢查點先留著）', async () => {
  await expect(t.canRun('project-1', 5)).resolves.toBe(true);
});

test('activeRunCount 反映簽發與作廢', () => {
  const a = t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000 });
  t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000 });
  expect(t.activeRunCount()).toBe(2);
  t.revokeRun(a.runId);
  expect(t.activeRunCount()).toBe(1);
});
