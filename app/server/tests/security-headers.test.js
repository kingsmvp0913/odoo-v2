const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }), resetLoopCounter: jest.fn() }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn(), stopProjectVpns: jest.fn() }));

process.env.JWT_SECRET = 'test-security-headers';

const { createApp, sameOriginSocketRequest } = require('../index');
const app = createApp();

test('正式頁面拒絕 inline script／frame，並帶齊瀏覽器安全 header', async () => {
  const res = await request(app).get('/');
  const csp = res.headers['content-security-policy'];
  expect(csp).toMatch(/script-src 'self' 'unsafe-eval' 'nonce-[A-Za-z0-9+/=]+'/);
  expect(csp.match(/script-src[^;]*/)[0]).not.toContain("'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});

test('HTTPS 反代回應包含 HSTS，HTTP 直連不錯誤釘死開發網址', async () => {
  expect((await request(app).get('/')).headers['strict-transport-security']).toBeUndefined();
  expect((await request(app).get('/').set('X-Forwarded-Proto', 'https'))
    .headers['strict-transport-security']).toMatch(/max-age=31536000/);
});

test('正式 index 的 inline loader 都帶當次 nonce；setup 沒有 inline script／event handler', async () => {
  const response = await request(app).get('/');
  const nonce = response.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
  const inlineScripts = [...response.text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].map(m => m[0]);
  expect(inlineScripts).toHaveLength(2);
  for (const tag of inlineScripts) expect(tag).toContain(`nonce="${nonce}"`);

  const setup = fs.readFileSync(path.join(__dirname, '../../public/setup.html'), 'utf8');
  expect(setup).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(setup).not.toMatch(/\son[a-z]+\s*=/i);
});

test('JWT 只保存在 sessionStorage；localStorage 僅供一次性舊資料搬移', () => {
  const api = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8');
  const setup = fs.readFileSync(path.join(__dirname, '../../public/js/setup.js'), 'utf8');
  expect(api).toContain('sessionStorage.setItem(TOKEN_KEY');
  expect(api).toContain('localStorage.removeItem(TOKEN_KEY)');
  expect(api).not.toMatch(/localStorage\.setItem\(TOKEN_KEY/);
  expect(setup).toContain("sessionStorage.setItem('aidev_token'");
  expect(setup).not.toContain("localStorage.setItem('aidev_token'");
});

test('Socket.IO 瀏覽器連線只接受與 HTTP Host 相同的 Origin', async () => {
  const allowed = (headers) => new Promise(resolve =>
    sameOriginSocketRequest({ headers }, (_err, ok) => resolve(ok)));
  await expect(allowed({ host: 'aidev.example.com', origin: 'https://aidev.example.com' })).resolves.toBe(true);
  await expect(allowed({ host: 'aidev.example.com', origin: 'https://evil.example' })).resolves.toBe(false);
  await expect(allowed({ host: 'aidev.example.com' })).resolves.toBe(true);
});
