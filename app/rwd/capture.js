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
const { chromium } = require('playwright');
const { STABILIZE_CSS, shotPlan, manualCheckList } = require('./routes');
const { login, assertAdmin, sampleIds, resolveUrl } = require('./lib/session');

const args = process.argv.slice(2);
const IS_BASELINE = args.includes('--baseline');
const GATE_ONLY = args.includes('--gate-only');
const OUT_DIR = path.join(__dirname, IS_BASELINE ? 'baseline' : 'snapshots');

const TOKEN_KEY = 'aidev_token';   // api.js:1
const THEME_KEY = 'theme';         // theme.js

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

    const page = await context.newPage();
    try {
      await page.goto(resolveUrl(route, ids), { waitUntil: 'networkidle', timeout: 30000 });
      await page.addStyleTag({ content: STABILIZE_CSS });
      // networkidle 之後 Vue 仍可能在渲染；等版面靜下來再截。
      await page.waitForTimeout(600);
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
