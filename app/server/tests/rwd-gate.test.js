// 意圖：截圖門禁的三個「靜默全綠」入口。
//
// 這支測試守的不是畫面，是**門禁本身還有沒有在驗東西**。截圖門禁最壞的失效方式不是紅燈，
// 是全綠：字型沒裝就是豆腐比豆腐、view 炸掉就是白圖比白圖、捲動容器沒解除就是只比第一屏。
// 三種都會讓 `npm run rwd:gate` 回 exit 0，而它宣稱「桌機 diff = 0」。
//
// 只 require routes.js（純資料）。capture.js 在載入時就 require('playwright') 並可能
// process.exit，所以那一支改用原始碼比對。
const fs = require('fs');
const path = require('path');
const { STABILIZE_CSS, ROUTES, activeRoutes, expectSelector, DEFAULT_EXPECT } = require('../../rwd/routes');

const captureSrc = fs.readFileSync(path.join(__dirname, '../../rwd/capture.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../public/css/app.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('fullPage 解除清單涵蓋所有頁面級捲動容器', () => {
  // app-shell 是「一屏高、內部捲動」的版型，Playwright 的 fullPage 看的是 document 的捲動
  // 高度，對內部捲動無效——沒解除的容器，那幾頁的基線就只有一個視窗高，捲動線以下從來沒進
  // 過門禁，而且**沒有任何訊號**。.page-body 就這樣漏掉五頁（Admin／Settings／AdminPortPool／
  // AdminEnterprise／PipelineFlow），其中 pipeline-flow 是 802173d 才剛納入門禁的頁。
  // 判準取 app.css 裡「flex:1 且 overflow-y:auto」的單一 class 規則＝頁面級捲動容器。
  const scrollers = [...css.matchAll(/^\.([a-z-]+)\s*\{([^}]*)\}/gm)]
    .filter((m) => /flex:\s*1/.test(m[2]) && /overflow-y:\s*auto/.test(m[2]))
    .map((m) => m[1]);

  test('解析到合理數量的容器（正則失效時不得靜默通過）', () => {
    expect(scrollers.length).toBeGreaterThan(1);
    expect(scrollers).toContain('content');
  });

  test('每個都在 STABILIZE_CSS 的解除規則內', () => {
    expect(scrollers.filter((c) => !STABILIZE_CSS.includes(`.${c}`))).toEqual([]);
  });
});

describe('每張截圖都要有「頁面真的渲染出來了」的斷言', () => {
  // view 在 render 中拋例外時 router-view 什麼都不掛，畫面全白——而空白對空白的 diff 恆為 0。
  // 沒有這道斷言，一整頁炸掉在門禁上與「完全沒改」完全一樣。
  test('每個進門禁的路由都拿得到期待選擇器', () => {
    expect(activeRoutes().length).toBeGreaterThan(10);
    expect(activeRoutes().filter((r) => !expectSelector(r))).toEqual([]);
  });

  test('預設值用的是 view 自己提供的容器，不是 app.js 的外框', () => {
    // .app-shell 由 app.js 直接渲染，view 炸掉它照樣在——拿它當證據等於沒驗。
    expect(DEFAULT_EXPECT).not.toContain('app-shell');
    expect(DEFAULT_EXPECT).toContain('.content');
  });

  test('未登入頁與獨立 HTML 頁各自指定（它們沒有 .content／.page-body）', () => {
    for (const key of ['login', 'styleguide']) {
      const route = ROUTES.find((r) => r.key === key);
      expect(route.expect).toBeTruthy();
      expect(route.expect).not.toBe(DEFAULT_EXPECT);
    }
  });

  test('capture.js 真的等了那個選擇器、也收了未捕捉的例外', () => {
    expect(captureSrc).toContain('expectSelector(route)');
    expect(captureSrc).toContain("page.on('pageerror'");
    // 收集了卻不看＝白收。要在截圖前判掉。
    expect(captureSrc.indexOf('pageErrors.length')).toBeLessThan(captureSrc.indexOf('page.screenshot'));
  });
});

// 新增一條 route 到 app.js 卻忘了加進截圖清單，是「門禁靜默縮水」最常見的一種：
// 測試全綠、gate 也全綠，只是那一頁從此沒人拍過。2026-08-31 實際盤點時 rwd 清單漏了 7 條，
// 其中 '#/tasks' 是 Next 的任務列表——那一輪剛大改完的頁面，一張圖都沒有。
//
// 特別容易漏的是「同一個 path 在兩個介面下是不同的頁」：'#/' 在 Legacy 是 TaskListView，
// 在 Next 是問答首頁，只拍 '#/' 會讓 Next 的任務列表整頁不進門禁。
describe('app.js 的每條路由都在截圖清單裡', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

  // catch-all 不是一個真的頁面，沒有東西可拍。
  const NOT_A_PAGE = ['/:pathMatch(.*)*'];

  const appPaths = [...appJs.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)]
    .map((m) => m[1])
    .filter((p) => !NOT_A_PAGE.includes(p));

  // rwd 清單用 :taskId／:projectId，app.js 用 :id／:chatId／:slug——只比較「有幾段、
  // 哪幾段是參數」，不比參數名字。
  const shape = (p) => p.replace(/^#/, '').replace(/:[A-Za-z]\w*/g, ':x');

  test('解析得到路由（寫法變動時不得靜默略過）', () => {
    expect(appPaths.length).toBeGreaterThanOrEqual(25);
    expect(ROUTES.filter((r) => r.hash).length).toBeGreaterThanOrEqual(25);
  });

  test.each(appPaths)('%s 有對應的截圖路由（或明確標為不涵蓋）', (p) => {
    const hit = ROUTES.some((r) => r.hash && shape(r.hash) === shape(p));
    expect(`${p}: ${hit}`).toBe(`${p}: true`);
  });

  test('標為不涵蓋的都寫了理由', () => {
    const noWhy = ROUTES.filter((r) => !r.covered && !r.why).map((r) => r.key);
    expect(noWhy).toEqual([]);
  });
});

describe('缺中文字型時要停下，不能默默拿系統字型拍', () => {
  // `.fontroot/` 在 .gitignore 內：換機／容器重建後目錄常在、裡面空了。此時中文全變豆腐框 □，
  // 而重拍基線就是拿豆腐比豆腐——門禁照樣全綠，只是量的已經不是中文版面。
  test('檢查的是字型檔而不是只有目錄存在', () => {
    expect(captureSrc).toMatch(/readdirSync\(FONT_DIR\)/);
    expect(captureSrc).toMatch(/\\\.\(ttf\|otf\|ttc/);
  });

  test('沒有字型檔就以非 0 結束（fallback 分支不得零輸出）', () => {
    const fallback = captureSrc.slice(captureSrc.indexOf('RWD_ALLOW_SYSTEM_FONTS'));
    expect(fallback).toContain('console.error');
    expect(fallback).toContain('process.exit(1)');
  });
});
