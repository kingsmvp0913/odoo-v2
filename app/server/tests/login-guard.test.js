// 意圖：登入端點原本完全沒有次數限制（查 DB＋比對密碼就結束）。2026-09-16 M6 實測發現 AI 容器
// 連得到平台 8771，等於可以無限猜密碼——猜中任一管理員就拿回全平台。這支守的是「猜不動」。
//
// 鎖定對象是 (帳號, 來源) 這一對，不是帳號本身：只鎖帳號的話，被注入的 AI 可以故意對 9 個管理員
// 帳號各打錯 10 次，把所有人永久封鎖、沒有人解得開（把機密性問題換成整個平台停擺）。
// 真人經 nginx 進來、容器直連 8771，兩者來源不同，所以鎖了容器不會影響真人。
process.env.APP_SECRET = 'test-login-guard';
const { newDb } = require('pg-mem');
const g = require('../lib/login-guard');

let dbModule;
const AT = '2026-09-16T10:00:00.000Z';
const at = ms => new Date(Date.parse(AT) + ms);

beforeAll(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => dbModule.query('DELETE FROM login_attempts'));

const fail = (n, user = 'bob', src = '10.0.28.3', now = () => at(0)) =>
  Promise.all([]).then(async () => { for (let i = 0; i < n; i++) await g.recordFailure({ username: user, source: src, now }); });

test('門檻是 5 次鎖 10 分鐘、累計 10 次永久封鎖', () => {
  expect(g.LOCK_THRESHOLD).toBe(5);
  expect(g.LOCK_MINUTES).toBe(10);
  expect(g.BLOCK_THRESHOLD).toBe(10);
});

test('沒失敗過 → 放行', async () => {
  expect(await g.checkLogin({ username: 'bob', source: '10.0.28.3' })).toEqual({ allowed: true });
});

test('錯 4 次還能試；第 5 次鎖 10 分鐘', async () => {
  await fail(4);
  expect((await g.checkLogin({ username: 'bob', source: '10.0.28.3', now: () => at(0) })).allowed).toBe(true);
  await fail(1);
  const r = await g.checkLogin({ username: 'bob', source: '10.0.28.3', now: () => at(0) });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe('locked');
  expect(new Date(r.until).getTime()).toBe(at(10 * 60 * 1000).getTime());
});

test('鎖 10 分鐘過了就能再試（沒有永久化）', async () => {
  await fail(5);
  expect((await g.checkLogin({ username: 'bob', source: '10.0.28.3', now: () => at(10 * 60 * 1000 + 1) })).allowed).toBe(true);
});

test('累計第 10 次 → 永久封鎖，過多久都不放行', async () => {
  await fail(10);
  const r = await g.checkLogin({ username: 'bob', source: '10.0.28.3', now: () => at(99 * 24 * 3600 * 1000) });
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe('blocked');
});

// 這條是選「帳號＋來源」的理由，壞掉就等於退回「只鎖帳號」
test('鎖的是那一對：同帳號從別的來源完全不受影響', async () => {
  await fail(10, 'bob', '10.0.28.3');
  expect((await g.checkLogin({ username: 'bob', source: '172.18.0.9', now: () => at(0) })).allowed).toBe(true);
  expect((await g.checkLogin({ username: 'alice', source: '10.0.28.3', now: () => at(0) })).allowed).toBe(true);
});

test('登入成功 → 該對的紀錄清掉，重新從 0 算', async () => {
  await fail(4);
  await g.recordSuccess({ username: 'bob', source: '10.0.28.3' });
  await fail(4);
  expect((await g.checkLogin({ username: 'bob', source: '10.0.28.3', now: () => at(0) })).allowed).toBe(true);
});

describe('給管理員看與解鎖', () => {
  test('listLocks 只列出還鎖著或已封鎖的，並帶帳號、來源、次數', async () => {
    await fail(5, 'bob', '10.0.28.3');
    await fail(10, 'carol', '10.0.28.4');
    await fail(2, 'dave', '10.0.28.5');            // 沒到門檻，不該出現
    const rows = await g.listLocks({ now: () => at(0) });
    expect(rows.map(r => r.username).sort()).toEqual(['bob', 'carol']);
    const carol = rows.find(r => r.username === 'carol');
    expect(carol).toMatchObject({ source: '10.0.28.4', fail_count: 10, blocked: true });
  });

  test('鎖已自然過期的不再列出', async () => {
    await fail(5, 'bob', '10.0.28.3');
    expect(await g.listLocks({ now: () => at(10 * 60 * 1000 + 1) })).toEqual([]);
  });

  test('clearLock 解掉一對；封鎖的也解得掉（否則管理員救不回來）', async () => {
    await fail(10, 'bob', '10.0.28.3');
    await g.clearLock('bob', '10.0.28.3');
    expect((await g.checkLogin({ username: 'bob', source: '10.0.28.3', now: () => at(0) })).allowed).toBe(true);
    expect(await g.listLocks({ now: () => at(0) })).toEqual([]);
  });

  test('lockSummary 給使用者管理頁：每個帳號目前被鎖／被封鎖的來源數', async () => {
    await fail(5, 'bob', '10.0.28.3');
    await fail(10, 'bob', '10.0.28.4');
    await fail(1, 'bob', '10.0.28.5');
    const s = await g.lockSummary({ now: () => at(0) });
    expect(s.bob).toEqual({ locked: 1, blocked: 1 });
    expect(s.alice).toBeUndefined();
  });
});

// 意圖（最終審查 IMPORTANT-2，裁決 R16）：網頁使用者全經 nginx 進來，remoteAddress 都是 nginx 那一個位址——
// 用它當來源，網路上任何人打錯管理員密碼 10 次就能讓所有人都登不進去。只有「直接連線的對方是設定裡信任的
// proxy」時才採用 X-Real-IP；其他人（例如直連 8771 的 AI 容器）自己帶的 X-Real-IP 一律不理。
describe('clientSource：認出真實來源', () => {
  const req = (peer, realIp) => ({ socket: { remoteAddress: peer }, headers: realIp === undefined ? {} : { 'x-real-ip': realIp } });
  const PROXY = '10.0.10.6';

  test('信任的 proxy 帶 X-Real-IP → 用 header 的位址', () => {
    expect(g.clientSource(req(PROXY, '203.0.113.7'), PROXY)).toBe('203.0.113.7');
    expect(g.clientSource(req(PROXY, '2001:db8::1'), `127.0.0.1, ${PROXY}`)).toBe('2001:db8::1');
  });

  test('不在信任清單的對方自己帶 X-Real-IP → 不理，用對方位址（AI 容器偽造無效）', () => {
    expect(g.clientSource(req('10.0.28.3', '10.0.10.99'), PROXY)).toBe('10.0.28.3');
  });

  test('信任的 proxy 但 header 缺或不是合法 IP → 用 proxy 位址', () => {
    expect(g.clientSource(req(PROXY), PROXY)).toBe(PROXY);
    expect(g.clientSource(req(PROXY, 'evil; drop'), PROXY)).toBe(PROXY);
    expect(g.clientSource(req(PROXY, '1.2.3.4, 5.6.7.8'), PROXY)).toBe(PROXY);
  });

  test('IPv4-mapped IPv6 的對方位址會正規化後再比對信任清單', () => {
    expect(g.clientSource(req(`::ffff:${PROXY}`, '203.0.113.7'), PROXY)).toBe('203.0.113.7');
    expect(g.clientSource(req('::ffff:10.0.28.3', '203.0.113.7'), PROXY)).toBe('10.0.28.3');
  });

  test('沒設信任清單 → 跟以前一模一樣：用 remoteAddress 原值，header 不理', () => {
    expect(g.clientSource(req(PROXY, '203.0.113.7'), undefined)).toBe(PROXY);
    expect(g.clientSource(req('::ffff:10.0.28.3', '203.0.113.7'), '')).toBe('::ffff:10.0.28.3');
    expect(g.clientSource({ headers: {} }, undefined)).toBe('unknown');
  });

  test('預設讀 process.env.TRUSTED_PROXY_IPS', () => {
    const old = process.env.TRUSTED_PROXY_IPS;
    try {
      process.env.TRUSTED_PROXY_IPS = PROXY;
      expect(g.clientSource(req(PROXY, '203.0.113.7'))).toBe('203.0.113.7');
    } finally { if (old === undefined) delete process.env.TRUSTED_PROXY_IPS; else process.env.TRUSTED_PROXY_IPS = old; }
  });
});
