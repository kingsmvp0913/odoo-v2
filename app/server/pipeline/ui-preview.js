const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const { query } = require('../db');

/**
 * ui-preview.js — 截「改動前／改動後」畫面給 fix-review agent 審。
 *
 * ⚠ 絕不在 worktree 起完整的 server（`index.js:303` 的 startCron() 無條件執行、沒有 env 可以關；
 * 兩個 cron 共用同一個 DB 會讓同一任務被派兩次、兩支 claude 並行寫同一個工作區——
 * `index.js:285-292` 記著這起實際事故）。這裡只起**靜態檔案伺服器**，`/api/*`／`/socket.io/*`
 * 一律轉發給正在跑的平台本尊。
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'data', 'config.json');
const PLATFORM_PORT = process.env.PORT || 8771;
const VIEWPORT = { width: 1440, height: 900 };

// 換一版 Chromium，同一份 HTML 的文字描邊就有 subpixel 差；playwright 是在 require 時就依這個
// 變數決定去哪裡找執行檔的，必須在 require('playwright') 之前設定（比照 app/rwd/capture.js）。
const BROWSER_ROOT = path.join(REPO_ROOT, 'app', 'rwd', '.pw-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(BROWSER_ROOT)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSER_ROOT;
}
// 截圖機器不一定裝了中文字型，漏了中文全變豆腐框——而豆腐框寬度不等於中文字寬，
// 會讓 fix-review 誤判成「版面塌掉」而 reject 一份其實沒問題的修正。字型跟著 repo 走
// （比照 app/rwd/capture.js）。
//
// ⚠ 只檢查「目錄在不在」是不夠的：`.fontroot/` 在 .gitignore 內，換機／容器重建後目錄可能
// 還在、裡面卻空了。那時照樣 set env、中文照樣全變豆腐框，而且零訊號。所以比照 capture.js
// 多做一層：數 `.fontroot/fonts/` 裡有沒有真的字型檔。缺字型時 captureBeforeAfter 直接回 null
// ——**無截圖好過錯截圖**：無截圖只是少一份證據，錯截圖會製造出無辜的 reject。
const FONT_ROOT = path.join(REPO_ROOT, 'app', 'rwd', '.fontroot');
const FONT_DIR = path.join(FONT_ROOT, 'fonts');

function fontFiles() {
  try {
    return fs.readdirSync(FONT_DIR).filter(f => /\.(ttf|otf|ttc|otc|woff2?)$/i.test(f));
  } catch { return []; }
}
if (!process.env.XDG_DATA_HOME && fontFiles().length) {
  process.env.XDG_DATA_HOME = FONT_ROOT;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

async function buildToken() {
  const cfg = readConfig();
  const secret = cfg.JWT_SECRET;
  if (!secret) throw new Error('data/config.json 缺少 JWT_SECRET');
  const { rows } = await query('SELECT cli_push_user_id FROM teams_settings WHERE id=1');
  const userId = rows[0] && rows[0].cli_push_user_id;
  if (!userId) throw new Error('teams_settings.cli_push_user_id 未設定，無法簽發截圖用 token');
  return jwt.sign({ userId }, secret, { expiresIn: '10m' });
}

// 靜態檔案伺服器：吃 <root>/app/public，`/api/*` 與 `/socket.io/*` 轉發給正在跑的平台本尊，
// 其餘走簡單的靜態檔回應（沒有 mime 資料庫也夠用——這裡只是給 playwright 截圖看，非公開服務）。
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(publicDir, req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  let file = path.join(publicDir, rel);
  // 防目錄穿越：resolve 後必須仍在 publicDir 之下。尾綴分隔符不可省——沒有它，
  // `/app/public-secrets` 這種「同前綴的鄰居目錄」會被判成合法。
  if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA：找不到的路徑一律回 index.html，讓前端路由接手
      return fs.readFile(path.join(publicDir, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function proxyToApi(req, res) {
  const upstream = http.request(
    { host: '127.0.0.1', port: PLATFORM_PORT, path: req.url, method: req.method, headers: req.headers },
    up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }
  );
  upstream.on('error', err => {
    res.writeHead(502);
    res.end(`上游平台無回應：${err.message}`);
  });
  req.pipe(upstream);
}

function startStaticServer(publicDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io/')) return proxyToApi(req, res);
      return serveStatic(publicDir, req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise(resolve => { if (!server) return resolve(); server.close(() => resolve()); });
}

/**
 * 拍一張首屏。
 *
 * ⚠ **刻意不捲動**。原本先 `scrollTop = scrollHeight` 再截（不帶 fullPage）＝只拍最後 900px，
 * 有兩個問題：多數前端修正在頁面上半部，agent 根本看不到；而且 before／after 的 scrollHeight
 * 往往不同（修正本身就會改變內容高度），兩張圖會捲到不同位置，**差異來自捲動而不是修正**，
 * 直接餵出誤判。首屏至少保證兩張圖對齊同一個基準。
 *
 * 已知限制：**頁面下半部的修正這裡看不到**。fix-review 的判準 5（畫面有沒有壞掉）因此只覆蓋
 * 首屏；真要看下半部得另外決定捲多少、而且 before／after 要捲到「語意上同一處」才可比，
 * 那是另一個題目。
 */
async function shootOne(browser, baseUrl, route, token, outFile) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    await context.addInitScript(tk => { localStorage.setItem('aidev_token', tk); }, token);
    const page = await context.newPage();
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
    // networkidle 之後 Vue 仍可能在渲染；等版面靜下來再截。
    await page.waitForTimeout(1000);
    await page.screenshot({ path: outFile });
  } finally {
    await context.close();
  }
}

/**
 * captureBeforeAfter(worktree, route) -> { before, after, dir } | null
 *
 * route 為空、缺中文字型、或起不了伺服器／截不到圖時回 null（呼叫端走無截圖路徑）。
 * `dir` 是兩張圖所在的暫存目錄——**呼叫端用完必須自己刪掉**（見 fix-review.js 的 finally），
 * 否則夜間每跑一條就疊一份 PNG，沒有上限也沒人回收。
 *
 * ⚠ before 拍的是**主 clone 的 live checkout**（不是 HEAD 的乾淨副本）。夜間批次時這不成立
 * 為風險：`finding-fix.js` 的 applyFix 已要求主 clone 沒有未提交的變更，那條路上 live checkout
 * 就等於 HEAD。但**人工觸發時**主 clone 常有別股平行工作的未提交變更（finding-fix.js:217 的
 * 註解記著同一件事），此時 before 會混進不屬於這次修正的畫面差異——人工看圖時要自己知道。
 */
async function captureBeforeAfter(worktree, route) {
  if (!route || !String(route).trim()) return null;

  // 缺中文字型就不截：拿豆腐框的圖給 fix-review 看，會換來一個無辜的 reject（見檔頭 FONT_ROOT 註解）。
  if (!fontFiles().length) {
    console.error('[UI-PREVIEW] 找不到截圖字型（%s 內沒有任何字型檔），本輪不截圖——'
      + '中文會全變豆腐框，會讓 fix-review 誤判成版面壞掉。重抓方式見 app/rwd/README.md。', FONT_DIR);
    return null;
  }

  let beforeServer = null;
  let afterServer = null;
  let browser = null;
  let outDir = null;
  let browserMod = null;
  try {
    browserMod = require('playwright');
  } catch (err) {
    console.error('[UI-PREVIEW] playwright 載入失敗：', err.message);
    return null;
  }

  try {
    const token = await buildToken();
    beforeServer = await startStaticServer(path.join(REPO_ROOT, 'app', 'public'));
    afterServer = await startStaticServer(path.join(worktree, 'app', 'public'));

    const beforeUrl = `http://127.0.0.1:${beforeServer.address().port}`;
    const afterUrl = `http://127.0.0.1:${afterServer.address().port}`;

    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-preview-'));
    const beforeFile = path.join(outDir, 'before.png');
    const afterFile = path.join(outDir, 'after.png');

    // 一個 browser、兩個 context：兩張圖只差在吃哪一份 app/public，沒有理由各開一次瀏覽器
    // （chromium.launch 是這裡最慢的一步）。
    browser = await browserMod.chromium.launch();
    await shootOne(browser, beforeUrl, route, token, beforeFile);
    await shootOne(browser, afterUrl, route, token, afterFile);

    return { before: beforeFile, after: afterFile, dir: outDir };
  } catch (err) {
    console.error('[UI-PREVIEW] 截圖失敗：', err.message);
    // 失敗路徑上沒有人會拿到 dir，這裡就地收乾淨，不留半套的暫存目錄。
    if (outDir) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 清不掉不值得再拋 */ } }
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await closeServer(beforeServer);
    await closeServer(afterServer);
  }
}

module.exports = { captureBeforeAfter };
