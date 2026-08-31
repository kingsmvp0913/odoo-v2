// 截圖。預設輸出到 snapshots/；帶 --baseline 才覆寫 baseline/。
//
//   node rwd/capture.js              截當前狀態到 snapshots/
//   node rwd/capture.js --baseline   建立／更新基線（會覆寫，請確認當下是乾淨 HEAD）
//   node rwd/capture.js --gate-only  只截桌機 1440（回歸門禁那 46 張）
//
// 環境變數：
//   RWD_BASE_URL   預設 http://localhost:3939/
//   RWD_USER       截圖帳號（必須是 admin）
//   RWD_PASS       密碼
//   RWD_CHROMIUM   選用。指向既有的 chromium 執行檔，跳過 playwright 自帶的版本。
//                  用於瀏覽器已預裝、或 playwright 版本與預裝 build 對不上的機器
//                  （症狀：Executable doesn't exist at .../chromium_headless_shell-<build>）。

const fs = require('fs');
const path = require('path');

// 換一版 Chromium，同一份 HTML 的文字描邊就有 subpixel 差，42 張桌機基線會一次全紅
// （2026-08-07 實測：原本裝在 /opt 的那份隨容器重建消失，重裝後版本不同，門禁全滅）。
// 基線比的是像素，拍基線的瀏覽器必須跟著 repo 走。必須在 require('playwright') 之前設定
// ——playwright 是在載入時就依這個變數決定去哪裡找執行檔的。
const BROWSER_ROOT = path.join(__dirname, '.pw-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(BROWSER_ROOT)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSER_ROOT;
}

const { chromium } = require('playwright');
const { STABILIZE_CSS, shotPlan, manualCheckList, expectSelector, CONSOLE_ALLOWLIST } = require('./routes');
const { login, assertAdmin, sampleIds, resolveUrl } = require('./lib/session');

const args = process.argv.slice(2);
const IS_BASELINE = args.includes('--baseline');
const GATE_ONLY = args.includes('--gate-only');
const OUT_DIR = path.join(__dirname, IS_BASELINE ? 'baseline' : 'snapshots');

const TOKEN_KEY = 'aidev_token';   // api.js:1
const THEME_KEY = 'theme';         // theme.js

// 截圖機器不一定裝了中文字型（本專案的容器就沒有，中文會全變成豆腐框 □）。
// 方框寬度不等於中文字寬，拿那種圖判斷手機版會不會擠爆是量錯的。
// fonts.conf 有 <dir prefix="xdg">fonts</dir>，把 XDG_DATA_HOME 指到隨 repo 走的
// 字型目錄，字型就跟著工具走、不依賴機器狀態；沒放字型時保持原樣不動。
// 只檢查「目錄在不在」是不夠的：`.fontroot/` 在 .gitignore 內，換機／容器重建後目錄可能
// 還在、裡面卻空了。那時中文全變豆腐框，而**重拍基線就是拿豆腐比豆腐**——門禁照樣全綠，
// 只是它量的東西已經不是中文版面了。缺字型一律停下（Rule 12 Fail Loud）。
const FONT_ROOT = path.join(__dirname, '.fontroot');
const FONT_DIR = path.join(FONT_ROOT, 'fonts');
const fontFiles = fs.existsSync(FONT_DIR)
  ? fs.readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf|ttc|otc|woff2?)$/i.test(f))
  : [];
if (fontFiles.length) {
  process.env.XDG_DATA_HOME = FONT_ROOT;
} else if (!process.env.RWD_ALLOW_SYSTEM_FONTS) {
  console.error(
    `找不到截圖字型：${path.relative(process.cwd(), FONT_DIR)} 內沒有任何字型檔。\n` +
    '本專案的容器沒裝中文字型，中文會全部渲染成豆腐框 □，方框寬度不等於中文字寬——\n' +
    '拿那種圖判斷手機版會不會擠爆是量錯的，而且基線與別台不可比。\n' +
    '重抓方式見 rwd/README.md「字型為什麼隨 repo 走」。\n' +
    '確定要拿這台的系統字型拍（基線只在本機有效）→ 設 RWD_ALLOW_SYSTEM_FONTS=1。'
  );
  process.exit(1);
}

async function main() {
  const token = await login();
  const me = await assertAdmin(token);
  const ids = await sampleIds(token);
  console.log(`帳號 ${me.username || me.display_name || ''}（admin）｜樣本 task=${ids.taskId ?? '無'} project=${ids.projectId ?? '無'}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch(
    process.env.RWD_CHROMIUM ? { executablePath: process.env.RWD_CHROMIUM } : {}
  );
  const plan = shotPlan({ gateOnly: GATE_ONLY });
  const skipped = [];
  let done = 0;

  for (const shot of plan) {
    const { route, viewport, theme } = shot;

    // 需要樣本 id 但取不到 → 跳過並記錄。寧可少一張，也不要拿 404 當基線。
    if (route.needs && !ids[route.needs]) {
      skipped.push({ name: shot.name, why: `缺少樣本 ${route.needs}` });
      continue;
    }

    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1
    });

    // 登入態與主題在頁面載入前就位：theme.js 載入時立即 apply，注入晚了會截到閃爍中的畫面。
    const wantToken = route.auth === 'none' ? null : token;
    await context.addInitScript(([tk, tv, tokenKey, themeKey]) => {
      if (tk) localStorage.setItem(tokenKey, tk); else localStorage.removeItem(tokenKey);
      localStorage.setItem(themeKey, tv);
    }, [wantToken, theme, TOKEN_KEY, THEME_KEY]);

    // 主題「以後端為準」（theme.js syncFromServer，由 app.js:88／:144 帶 auth/me 的值呼叫），
    // 會把上面注入的 localStorage 蓋掉——不攔的話登入頁面的淺色基線拍出來全是帳號設定的深色。
    // 只改這支請求的回應，不動產品碼、也不動帳號的真實設定。
    await context.route('**/api/auth/me', async route => {
      const res = await route.fetch();
      const me = await res.json().catch(() => null);
      // odoo_settings 不存在時不補：syncFromServer 收到 undefined 會直接 return，
      // 注入值本來就不會被蓋；擅自補上反而可能改動畫面（有 view 以它的有無決定要不要提示）。
      if (me && me.odoo_settings) me.odoo_settings.theme = theme;
      await route.fulfill({ response: res, json: me });
    });

    const page = await context.newPage();
    // 未捕捉的例外只會讓 Vue 掛不上任何東西，畫面是全白的——而**白圖對白圖的 diff 恆為 0**。
    // 不收這些訊號的話，一整頁炸掉在門禁上看起來與「完全沒改」一模一樣。
    // pageerror 只收「拋到頂層而沒人接」的例外。Vue 的 render 錯誤與 component 內被 catch 起來的
    // 失敗走的是 console.error；被 .catch 漏掉的 Promise 走的是 unhandledrejection。三者都不收的話，
    // 「篩選一點就白屏」（NEXT-P0-002 那種 TypeError）在門禁上只是一張少了篩選面板的圖，diff 容易
    // 落在容差內而靜默放行。
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (CONSOLE_ALLOWLIST.some((re) => re.test(text))) return;
      pageErrors.push(`console.error: ${text}`);
    });
    await page.addInitScript(() => {
      window.addEventListener('unhandledrejection', (e) => {
        // 轉成 console.error 讓上面同一條管線收走，避免再開一條各自為政的通報路徑。
        console.error(`unhandledrejection: ${(e.reason && e.reason.message) || e.reason}`);
      });
    });
    try {
      await page.goto(resolveUrl(route, ids), { waitUntil: 'networkidle', timeout: 30000 });
      await page.addStyleTag({ content: STABILIZE_CSS });
      // networkidle 之後 Vue 仍可能在渲染；等版面靜下來再截。
      await page.waitForTimeout(1200);
      // 「這一頁真的渲染出來了」的最低證據。view 在 render 中拋例外時 router-view 什麼都不掛，
      // 連 .content／.page-body 都不會存在，所以這個等待就是空白頁的警報器。
      await page.waitForSelector(expectSelector(route), { state: 'attached', timeout: 5000 });
      if (pageErrors.length) throw new Error(`頁面有 runtime 錯誤：${pageErrors[0]}`);
      await page.screenshot({ path: path.join(OUT_DIR, `${shot.name}.png`), fullPage: true });
      done++;
    } catch (err) {
      skipped.push({ name: shot.name, why: err.message });
    } finally {
      await context.close();
    }
  }

  await browser.close();

  console.log(`\n完成 ${done}/${plan.length} 張 → ${path.relative(process.cwd(), OUT_DIR)}`);
  if (skipped.length) {
    console.log(`\n未產出 ${skipped.length} 張：`);
    for (const s of skipped) console.log(`  - ${s.name}：${s.why}`);
  }
  const manual = manualCheckList();
  if (manual.length) {
    console.log(`\n人工檢查清單（不進自動 diff）：`);
    for (const m of manual) console.log(`  - ${m.key}：${m.why}`);
  }
  // 有跳過就以非 0 結束，避免「少截了幾張」被當成全綠通過。
  process.exit(skipped.length ? 1 : 0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
