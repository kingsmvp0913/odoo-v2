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
const { STABILIZE_CSS, shotPlan, manualCheckList } = require('./routes');
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
const FONT_ROOT = path.join(__dirname, '.fontroot');
if (fs.existsSync(path.join(FONT_ROOT, 'fonts'))) process.env.XDG_DATA_HOME = FONT_ROOT;

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
    try {
      await page.goto(resolveUrl(route, ids), { waitUntil: 'networkidle', timeout: 30000 });
      await page.addStyleTag({ content: STABILIZE_CSS });
      // networkidle 之後 Vue 仍可能在渲染；等版面靜下來再截。
      await page.waitForTimeout(1200);
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
