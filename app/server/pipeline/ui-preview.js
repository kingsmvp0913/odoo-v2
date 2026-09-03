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
// 會讓 fix-review 誤判成版面壞掉。字型跟著 repo 走（同上，比照 capture.js）。
const FONT_ROOT = path.join(REPO_ROOT, 'app', 'rwd', '.fontroot');
if (!process.env.XDG_DATA_HOME && fs.existsSync(FONT_ROOT)) {
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
  // 防目錄穿越：resolve 後必須仍在 publicDir 之下
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
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

async function shootOne(chromium, baseUrl, route, token, outFile) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.addInitScript(tk => { localStorage.setItem('aidev_token', tk); }, token);
    const page = await context.newPage();
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);
    // fullPage:true 截不到捲動內容——真正在捲的是 .ui-next-main，截圖前先捲到底。
    await page.evaluate(() => {
      const el = document.querySelector('.ui-next-main');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.screenshot({ path: outFile });
  } finally {
    await browser.close();
  }
}

/**
 * captureBeforeAfter(worktree, route) -> { before, after } | null
 *
 * route 為空、或起不了伺服器／截不到圖時回 null（呼叫端走無截圖路徑）。
 */
async function captureBeforeAfter(worktree, route) {
  if (!route || !String(route).trim()) return null;

  let beforeServer = null;
  let afterServer = null;
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

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-preview-'));
    const beforeFile = path.join(outDir, 'before.png');
    const afterFile = path.join(outDir, 'after.png');

    await shootOne(browserMod.chromium, beforeUrl, route, token, beforeFile);
    await shootOne(browserMod.chromium, afterUrl, route, token, afterFile);

    return { before: beforeFile, after: afterFile };
  } catch (err) {
    console.error('[UI-PREVIEW] 截圖失敗：', err.message);
    return null;
  } finally {
    await closeServer(beforeServer);
    await closeServer(afterServer);
  }
}

module.exports = { captureBeforeAfter };
