// 意圖：index.html 的資產版本號原本寫死（?v=20260910）。改了 CSS／JS 卻沒改那串數字，
// 瀏覽器就繼續用快取的舊檔——實測對外網址載到的是舊版面，硬重整才會變。
// 「改了但畫面沒變」沒有任何錯誤訊息，是最難察覺的一種壞法，所以這裡守住它。
const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn().mockResolvedValue(''), stopProjectVpns: jest.fn().mockResolvedValue(undefined) }));

process.env.JWT_SECRET = 'test-asset-version';

const CSS = path.join(__dirname, '../../public/css/ui-next.css');
let app;

beforeAll(() => {
  const { newDb } = require('pg-mem');
  const db = newDb();
  jest.doMock('../db', () => ({ query: (...a) => db.public.query(a[0]), migrate: jest.fn().mockResolvedValue(undefined) }));
  app = require('../index').createApp();
});

test('index.html 的 ?v= 不是寫死的日期，而是跟著資產走', async () => {
  const raw = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const served = (await request(app).get('/')).text;
  const rawVer = (raw.match(/\?v=(\d+)/) || [])[1];
  const servedVer = (served.match(/\?v=(\d+)/) || [])[1];
  expect(servedVer).toBeTruthy();
  // 送出的版本號來自檔案 mtime（毫秒級），一定比原始碼裡那串日期長
  expect(servedVer).not.toBe(rawVer);
  expect(Number(servedVer)).toBeGreaterThan(Number(rawVer));
});

test('改動 CSS 之後版本號會變（否則快取永遠不失效）', async () => {
  const before = ((await request(app).get('/')).text.match(/\?v=(\d+)/) || [])[1];
  const now = new Date();
  fs.utimesSync(CSS, now, new Date(now.getTime() + 60000));
  const after = ((await request(app).get('/')).text.match(/\?v=(\d+)/) || [])[1];
  expect(after).not.toBe(before);
});

test('同一份資產不動時版本號穩定（不會每次請求都變，否則等於停用快取）', async () => {
  const a = ((await request(app).get('/')).text.match(/\?v=(\d+)/) || [])[1];
  const b = ((await request(app).get('/')).text.match(/\?v=(\d+)/) || [])[1];
  expect(a).toBe(b);
});
