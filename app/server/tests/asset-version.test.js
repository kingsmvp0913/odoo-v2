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
// ⚠ 這兩個路徑是本檔的鑑別力來源，不可換成 VERSIONED_ASSETS 那種「一定被算到」的檔。
// 原本整支測試只動 ui-next.css，而它剛好在寫死的清單裡 ⇒ 全綠，卻擋不住真正的洞：
// ui-next 早已拆成 pages/*.js 與 ui-next-pages/*.css，兩者都不在清單上，改了版本號不會變，
// 使用者永遠拿到快取的舊碼（2026-09-05 實際發生，症狀是「改了但畫面完全沒變」）。
const PAGE_JS = path.join(__dirname, '../../public/js/ui-next/pages/AdminHealthCheck.js');
const PAGE_CSS = path.join(__dirname, '../../public/css/ui-next-pages/07-admin.css');
let app;

const servedVersion = async () => ((await request(app).get('/')).text.match(/\?v=(\d+)/) || [])[1];

// ⚠ 設 mtime 一定要「比現在送出的版本號還新」，不能用 `Date.now() + 固定秒數`。
// 版本號取的是所有資產的 max，而測試把 mtime 設到未來之後**不會還原**——下一次跑（同一天
// 稍後、或全跑時排在後面）算出來的 now+60s 可能還小於上一輪留下的值，max 原地不動、版本號
// 不變，測試就紅在一個與程式碼完全無關的地方。實測就是這樣：單跑綠、全跑紅、值都一樣。
const bumpAbove = async (file) => {
  const cur = Number(await servedVersion());
  const next = new Date(cur + 60000);
  fs.utimesSync(file, next, next);
  return String(cur);
};

beforeAll(() => {
  const { newDb } = require('pg-mem');
  const db = newDb();
  jest.doMock('../db', () => ({ query: (...a) => db.public.query(a[0]), migrate: jest.fn().mockResolvedValue(undefined) }));
  app = require('../index').createApp();
});

// 把被推到未來的 mtime 收回現在：留著的話正式環境算出來的版本號是個未來時間戳，
// 而且會讓下一輪測試的起點越墊越高。
afterAll(() => {
  const now = new Date();
  for (const f of [CSS, PAGE_JS, PAGE_CSS]) {
    try { fs.utimesSync(f, now, now); } catch { /* 檔案不在就跳過 */ }
  }
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
  const before = await bumpAbove(CSS);
  expect(await servedVersion()).not.toBe(before);
});

// ui-next 轉正式後，使用者實際載到的每一支 View 都在 pages/ 底下。這一支若不綠，
// 症狀就是「改了 View 卻要使用者自己硬重整才看得到」。
test('改動 ui-next 的單一 View（pages/*.js）之後版本號會變', async () => {
  const before = await bumpAbove(PAGE_JS);
  expect(await servedVersion()).not.toBe(before);
});

test('改動拆分後的分頁 CSS（css/ui-next-pages/*.css）之後版本號會變', async () => {
  const before = await bumpAbove(PAGE_CSS);
  expect(await servedVersion()).not.toBe(before);
});

// 版本號寫在 index.html 裡：index.html 自己被瀏覽器直接吃快取的話，整套 cache-busting
// 等於被繞過——碼改了、版本號也算對了，使用者卻連請求都沒發，畫面照舊。
test('index.html 帶 Cache-Control: no-cache（否則版本號機制被自己的快取繞過）', async () => {
  const res = await request(app).get('/');
  expect(res.headers['cache-control']).toMatch(/no-cache/);
});

test('同一份資產不動時版本號穩定（不會每次請求都變，否則等於停用快取）', async () => {
  const a = ((await request(app).get('/')).text.match(/\?v=(\d+)/) || [])[1];
  const b = ((await request(app).get('/')).text.match(/\?v=(\d+)/) || [])[1];
  expect(a).toBe(b);
});
