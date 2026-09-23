const fs = require('fs');
const path = require('path');
const publicDir = path.join(__dirname, '../../public');
const read = (f) => fs.readFileSync(path.join(publicDir, f), 'utf8');

// 教程的賣點是「刪掉就乾淨消失、既有畫面一個像素都沒動」。
// 這性質只要有人圖方便沿用一次平台的 class 就壞掉，且壞掉不會有任何訊號
// （畫面照跑、測試照綠），所以用靜態掃描擋在 commit 前。
describe('tour.css 與既有樣式完全隔離', () => {
  const css = () => read('css/tour.css');

  test('每一條選擇器都以 .tour- 開頭', () => {
    const src = css()
      .replace(/\/\*[\s\S]*?\*\//g, '')        // 去註解
      .replace(/@media[^{]*\{/g, '')            // @media 包裝層不是選擇器
      .replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, ''); // keyframes 內是百分比不是選擇器
    const selectors = (src.match(/(^|\})\s*([^{}@]+)\{/g) || [])
      .map(s => s.replace(/^[\})\s]*/, '').replace(/\s*\{$/, '').trim())
      .filter(Boolean);
    const offenders = selectors.filter(sel =>
      sel.split(',').some(part => !part.trim().startsWith('.tour-')));
    expect(offenders).toEqual([]);
  });

  test('不得出現裸 element selector（會濺到全站）', () => {
    const offenders = css().match(/(^|\})\s*(button|div|input|a|p|ul|ol|li|span|label|h[1-6])\s*[,{]/gm) || [];
    expect(offenders).toEqual([]);
  });

  // 遮罩黑（#000）是唯一放行的寫死顏色：它不屬於任何語意色 token，
  // 且數值要跟 ui-next 的 .ui-next-task-modal-backdrop 對齊，走變數反而對不上。
  // 白名單只有這一個——多放一個顏色就等於多一處深色模式看不出來的破口。
  const HEX_ALLOWED = new Set(['#000']);
  test('不得寫死顏色，一律走變數', () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex.filter(h => !HEX_ALLOWED.has(h.toLowerCase()))).toEqual([]);
  });

  // #fff 曾經在白名單裡，是因為主要按鈕與 badge 的文字寫死白色。
  // ui-next 深色模式的主色是亮藍 #93C5FD，白字壓上去對比不足 ⇒ 已改成 var(--bg)。
  // 這條守住它不被改回去（改回去畫面不會壞，只會在深色模式下變得難讀）。
  test('主色按鈕與 badge 的文字色不寫死白色', () => {
    expect(css()).not.toMatch(/color:\s*#fff/i);
  });
});

describe('tour js 不打 API', () => {
  test.each(['js/tour.js', 'js/tour-courses.js', 'js/tour-demo.js'])('%s 不含 fetch/Api 呼叫', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bApi\.(get|post|patch|delete|postForm|getBlob)\s*\(/);
  });
});

// 教程改成在真實畫面上打光後，靠 view 裡的 data-tour 錨點定位。
// 錨點被改名或刪掉時教程只會在 console 警告後退成置中，畫面不會紅——所以在這裡對帳。
//
// ⚠ 這裡原本寫死一份**舊介面**的檔案清單，於是 UI Next 上線後掃不到 js/ui-next/：
// 53 個步驟裡有 38 步指向不存在的元素，這份測試照樣全綠，撐了整整一個改版週期沒人發現。
// 改成遞迴掃目錄——新增的 View 檔會自動納入，不會再有「漏列一個檔＝那個檔不設防」。
describe('data-tour 錨點與課程定義對得上', () => {
  // 教學已改成 UI Next 專用（2026-09-07 使用者裁決），舊介面不再維護 ⇒ 只掃 ui-next。
  const NEXT_DIR = path.join(publicDir, 'js/ui-next');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });
  const nextFiles = walk(NEXT_DIR);
  const anchors = new Set();
  for (const f of nextFiles) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/data-tour="([^"]+)"/g)) anchors.add(m[1]);
  }

  test('掃得到 ui-next 的檔（目錄搬家時不得靜默變成掃 0 個檔）', () => {
    expect(nextFiles.length).toBeGreaterThanOrEqual(25);
  });

  // Wiki 樹是遞迴元件，錨點由 node_type 組出來（:data-tour="'wiki-node-' + node.node_type"），
  // 靜態掃不到字面值 → 在此列出後端 wiki 實際會產出的四種 node_type，並守住那段拼接還在。
  test('wiki 樹的動態錨點仍以 node_type 拼接', () => {
    expect(read('js/ui-next/UiNextShared.js'))
      .toContain(`:data-tour="'wiki-node-' + node.node_type"`);
  });
  ['notes', 'overview', 'module', 'troubleshooting'].forEach(t => anchors.add('wiki-node-' + t));

  // 分頁列同理：UI Next 把個人設定、用量報表、管理員設定、專案頁都拆成分頁，
  // 教學要先點分頁才指得到裡面的東西，所以每個分頁鈕都掛了一個拼接出來的錨點。
  // key 清單**從原始碼撈**而不是寫死——寫死的話新增／改名一個分頁就會腐爛成假事實。
  const DYNAMIC_TABS = [
    { prefix: 'set-tab-', file: 'js/ui-next/pages/Settings.js', decl: 'SETTINGS_TABS', bind: `:data-tour="'set-tab-' + item.key"`, min: 3 },
    { prefix: 'tr-tab-', file: 'js/ui-next/pages/TokenReport.js', decl: 'TABS', bind: `:data-tour="'tr-tab-' + item.key"`, min: 4 },
    { prefix: 'admin-tab-', file: 'js/ui-next/pages/AdminSettings.js', decl: 'settingsTabs', bind: `:data-tour="'admin-tab-' + tab[0]"`, min: 4 },
    { prefix: 'pd-tab-', file: 'js/ui-next/pages/ProjectDetail.js', decl: 'tabs', bind: `:data-tour="'pd-tab-' + tab[0]"`, min: 6 },
  ];
  const tabKeys = (spec) => {
    const src = read(spec.file);
    const at = src.indexOf(spec.decl);
    // 巢狀陣列（[["conn","連線"],…]）要切到 ]] 才是整份；只找第一個 ] 會停在第一組裡面，
    // 於是永遠只撈到一個 key——而那看起來像「撈到了」，不像失敗。
    const open = src.indexOf('[', at);
    const nested = /^\s*\[/.test(src.slice(open + 1));
    const close = nested ? src.indexOf(']]', open) + 2 : src.indexOf(']', open);
    const body = src.slice(open, close);
    // 兩種寫法都吃：{ key: "x", ... } 與 ["x", "標籤"]
    return [...body.matchAll(/(?:key:\s*"([a-z]+)"|\[\s*"([a-z]+)"\s*,)/g)].map(m => m[1] || m[2]);
  };
  DYNAMIC_TABS.forEach((spec) => {
    // eslint-disable-next-line jest/valid-title
    test(`${spec.prefix}* 的拼接還在，且撈得到 key`, () => {
      expect(read(spec.file)).toContain(spec.bind);
      expect(tabKeys(spec).length).toBeGreaterThanOrEqual(spec.min);
    });
    tabKeys(spec).forEach(k => anchors.add(spec.prefix + k));
  });

  const wanted = [...new Set(
    [...read('js/tour-courses.js').matchAll(/\[data-tour="([^"]+)"\]/g)].map(m => m[1])
  )];

  test('掃得到錨點與課程選字（regex 失效時不得靜默通過）', () => {
    expect(anchors.size).toBeGreaterThanOrEqual(25);
    expect(wanted.length).toBeGreaterThanOrEqual(25);
  });

  test.each(wanted)('課程用到的 %s 在 ui-next 裡存在', (name) => {
    expect(anchors.has(name)).toBe(true);
  });
});

// step.text 走 v-html，step.warn 走 {{ }} 文字插值——兩者長得很像，很容易在 warn 裡順手寫 <strong>，
// 結果畫面上直接印出標籤原文。這不會紅、不會噴錯，只有肉眼看得出來，所以在這裡守住。
describe('warn 是純文字，不得含 HTML 標籤', () => {
  test('tour.js 的 warn 仍以文字插值渲染（改成 v-html 就要改本測試）', () => {
    expect(read('js/tour.js')).toContain('{{ step.warn }}');
  });

  const warns = [...read('js/tour-courses.js').matchAll(/warn: '([^']*)'/g)].map(m => m[1]);

  test('掃得到 warn（regex 失效時不得靜默通過）', () => {
    expect(warns.length).toBeGreaterThanOrEqual(8);
  });

  test.each(warns)('「%s」不含標籤', (w) => {
    expect(w).not.toMatch(/<[a-z/]/i);
  });
});

// 報表與管理員設定的路由有 requiresAdmin，教程帶一般使用者過去只會被導回首頁。
// （資料庫查詢已開放給所有登入者，故不在此清單內。）
describe('管理員限定課程不對一般使用者出現', () => {
  const courses = read('js/tour-courses.js');
  // /admin/settings 是 UI Next 才有的拆分（舊版三個錨點都在 /admin 一頁上）。
  // 漏列它的症狀是「一般使用者看得到那堂課、點下去被導回首頁」。
  // /pipeline-flow 與 /admin/pipelines：3b Task 8b 補列——多租戶案把前者收斂成
  // requiresAdmin 後，「進度與通知」課整課走不通（後者本就是 requiresAdmin），
  // 這份清單當時沒跟著補，同一顆地雷才會踩兩次。
  const ADMIN_ROUTES = ['/token-report', '/admin', '/admin/settings', '/pipeline-flow', '/admin/pipelines'];

  test('引擎依 UserStore.role 過濾 adminOnly', () => {
    const src = read('js/tour.js');
    expect(src).toMatch(/adminOnly/);
    expect(src).toMatch(/UserStore\s*&&\s*window\.UserStore\.role === 'admin'/);
  });

  test.each(ADMIN_ROUTES)('走到 %s 的課程都標了 adminOnly', (route) => {
    // 課程物件以 `id:` 起頭；把檔案切成一課一段後，含該路由的那幾段必須也含 adminOnly
    const blocks = courses.split(/\n  \{\n/).filter(b => b.includes(`route: '${route}'`));
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach(b => expect(b).toContain('adminOnly: true'));
  });
});

// 示範資料只在教程開著、且看的正好是示範 id 時才接管；漏掉任一個守衛就會把真任務蓋掉。
// 2026-09-22 舊版前端退役：清單從 js/views/* 換成現在真正在跑的 ui-next 頁面。
// 檔名寫死是刻意的——這幾頁是「教程會走到、且會被示範資料接管」的那幾頁，不是全部頁面。
describe('示範資料的接線都有守衛', () => {
  test.each([
    'js/ui-next/pages/TaskList.js', 'js/ui-next/pages/TaskDetail.js',
    'js/ui-next/pages/ProjectList.js', 'js/ui-next/pages/ProjectDetail.js',
    'js/ui-next/pages/Wiki.js', 'js/ui-next/pages/ProjectChat.js', 'js/ui-next/pages/Db.js'
  ])('%s 只透過 window.TourDemo 取用（可整支刪除）', (f) => {
    const src = read(f);
    const uses = src.match(/TourDemo/g) || [];
    expect(uses.length).toBeGreaterThan(0);
    // 一律以 window. 前綴或 isTourDemo computed 存取 → tour-demo.js 不載入時不會 ReferenceError
    expect(src).not.toMatch(/(?<!window\.)\bTourDemo\./);
  });
});

describe('教程接線', () => {
  const html = () => read('index.html');
  const appJs = () => read('js/app.js');

  // base.js 必須恆為第一支：frontend-base-path.test.js 也守這條，
  // 這裡再寫一次是因為本 task 就是在動 script 清單，容易插錯位置。
  test('tour 的 script 都排在 base.js 之後、app.js 之前', () => {
    const src = html();
    const at = (f) => src.indexOf(f);
    expect(at('js/base.js')).toBeLessThan(at('js/tour-demo.js'));
    expect(at('js/tour-demo.js')).toBeLessThan(at('js/tour-courses.js'));
    expect(at('js/tour-courses.js')).toBeLessThan(at('js/tour.js'));
    expect(at('js/tour.js')).toBeLessThan(at('js/app.js'));
  });

  test('index.html 載入 tour.css', () => {
    expect(html()).toContain('href="css/tour.css"');
  });

  // 教學改成 UI Next 專用（2026-09-07 使用者裁決）：舊介面的側欄入口已移除。
  // 2026-09-22 舊介面整個退役後，這條剩下的意義是「app.js 不得再長出第二個教學入口」——
  // 教學的入口單一來源在 ui-next 外殼，app.js 只負責路由。
  test('app.js 不得自己掛教學入口', () => {
    const src = appJs();
    expect(src).not.toContain('tour-launch');
    expect(src).not.toContain('TourManager.open()');
  });

  test('TourHost 有被註冊且掛進 template', () => {
    const src = appJs();
    // 比對放寬到引號風格不敏感：app.js 走過 prettier 後字面值從單引號變雙引號，
    // 註冊行原封不動卻讓這條紅——那是格式假紅，會誘人以為 TourHost 真的被拔掉。
    expect(src).toMatch(/app\.component\(\s*['"]TourHost['"]\s*,\s*window\.TourHost\s*\)/);
    // 2026-09-22 舊版前端退役：唯一的外殼 template 在 UiNextApp.js，掛載點跟著搬過去。
    // 註冊在 app.js、掛載在外殼，兩邊都要有——少任一邊教學都是不會出現的（且不報錯）。
    expect(read('js/ui-next/UiNextApp.js')).toContain('<tour-host />');
  });
});

// 教學說明框 `.tour-pop` 吃事件（pointer-events:auto），而 UiNextApp 在 document 上掛的
// pointerdown 監聽會把「點到 .ui-next-tools-wrap／.ui-next-account-wrap／.ui-next-row-menu 以外」
// 一律當成點到外面而關掉選單。兩者相加＝使用者按「下一步」那一下，就把教學正在教的選單關掉。
// 症狀是教學靜默失效（退成置中說明框），畫面不報錯、其他測試也不會紅，只有人眼看得出來。
describe('教學覆蓋層不被當成「點到選單外面」', () => {
  const src = read('js/ui-next/UiNextApp.js');

  test('外部點擊監聽對 .tour-layer 整層放行', () => {
    expect(src).toMatch(/closest\(["']\.tour-layer["']\)/);
  });

  test('放行發生在關閉選單之前（掃得到那段，改寫時不得靜默失效）', () => {
    const guard = src.indexOf('.tour-layer');
    const closePopovers = src.indexOf('this.closePopovers()', guard);
    const closeSidebar = src.indexOf('this.closeSidebarMenus()', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(closePopovers).toBeGreaterThan(guard);
    expect(closeSidebar).toBeGreaterThan(guard);
  });
});

// ui-next 的色票是 scoped 在 [data-ui="next"] 子樹（ui-next.css 第 8–11 行）。
// 這三個 overlay 刻意掛在 .ui-next-shell 外面（登入頁與未登入狀態也要有它們），
// 所以必須自己帶一層 data-ui="next"，否則整組退回 app.css 的舊色票：
// 主色變靛藍 #6366f1、卡片底變 #202020，跟旁邊的 .ui-next-task-modal 不是同一套。
// 破法無聲：畫面照跑、其他測試照綠，只有把它們跟平台的卡片擺在一起看才發現。
describe('全域 overlay 吃得到 ui-next 色票', () => {
  const src = read('js/ui-next/UiNextApp.js');
  const wrapper = src.indexOf('class="ui-next-overlays"');

  test('三個 overlay 都被 data-ui="next" 的 wrapper 包住', () => {
    expect(wrapper).toBeGreaterThan(-1);
    expect(src.slice(wrapper - 40, wrapper)).toContain('data-ui="next"');
    const tail = src.slice(wrapper);
    ['toast-container', '<confirm-dialog-host />', '<tour-host />'].forEach((frag) => {
      const at = tail.indexOf(frag);
      expect(at).toBeGreaterThan(-1);
      // 必須落在 wrapper 收尾之前，否則等於掛在外面
      expect(at).toBeLessThan(tail.indexOf('</div>\n    `'));
    });
  });

  test('wrapper 不產生 box（display:contents）', () => {
    const css = fs.readFileSync(
      path.join(publicDir, 'css/ui-next-pages/01-base.css'), 'utf8');
    expect(css).toMatch(/\.ui-next-overlays\s*\{[^}]*display:\s*contents/);
  });
});

// 入口掉過一次：UI Next 上線後 openTour() 一直都在，但沒有任何 UI 呼叫它——
// 功能還在、叫不出來，grep 函式名也找不到問題（要反查呼叫端才看得見）。
// 這條守住「有一顆按得到的鈕」，不然下次改選單時它會再無聲消失一次。
describe('新手教學在「更多工具」選單裡叫得出來', () => {
  const src = read('js/ui-next/UiNextApp.js');

  test('選單有一顆 menuitem 呼叫 openTour', () => {
    expect(src).toMatch(/role="menuitem"[^>]*@click="openTour"/);
  });

  test('badge 的未完成數走 TourManager，不是寫死的字', () => {
    expect(src).toMatch(/tourRemaining\(\)\s*\{[^}]*TourManager[^}]*remainingCount\(\)/s);
    // Vue computed 呼叫端不得加括號（加了直接 TypeError 白畫面，rules/frontend.md #34）
    expect(src).toContain('{{ tourRemaining }}');
    expect(src).not.toContain('{{ tourRemaining() }}');
  });

  test('openTour 會先收掉選單再開教學', () => {
    // 不收的話選單浮在教學遮罩上，第一步就被自己的選單擋住
    expect(src).toMatch(/openTour\(\)\s*\{\s*this\.toolsOpen\s*=\s*false;\s*window\.TourManager\.open\(\);/);
  });
});

// toast 與確認視窗跟教學是同一個成因：三者一起掛在 shell 外面、一起吃不到 ui-next 色票。
// dialog.js 與 app.js 的 class 名新舊共用不能改，所以只覆寫外觀——這幾條掉了就會
// 悄悄退回 app.css 的 8px 圓角與飽和色塊，而畫面照跑、沒有任何測試會叫。
describe('toast 與確認視窗吃 ui-next 的外觀', () => {
  const css = fs.readFileSync(
    path.join(publicDir, 'css/ui-next-pages/01-base.css'), 'utf8');

  test('覆寫都限定在 [data-ui="next"] 範圍內（不得濺到舊介面）', () => {
    ['.toast', '.toast-close', '.modal-overlay', '.modal'].forEach((sel) => {
      const re = new RegExp('(^|[},])\\s*\\[data-ui="next"\\] \\' + sel + '[\\s.{,]', 'm');
      expect(css).toMatch(re);
    });
  });

  test('toast 不再整塊塗語意色（深色模式白字讀不到）', () => {
    const block = css.slice(css.indexOf('[data-ui="next"] .toast {'));
    expect(block).toMatch(/background:\s*var\(--surface\)/);
    expect(block).toMatch(/border-left:\s*3px solid/);
    // 四個級別各自只換左側那條的顏色，級別仍分得出來
    ['info', 'success', 'warn', 'error'].forEach((level) => {
      expect(css).toContain(`[data-ui="next"] .toast.${level} { border-left-color:`);
    });
  });
});

// 步驟層 adminOnly（2026-09-22）：多租戶案把「新增專案」「Repo」「同步來源對應」「執行歷程」
// 這些控制項對一般使用者藏了起來。教程指過去時，引擎找不到 target 只會 console.warn 後退成
// 「置中的說明框指著空氣」——不報錯、不紅燈，唯一的症狀是新人以為產品壞了。
//
// 本段刻意**載入引擎本體**來驗，而不是在測試裡重寫一份過濾邏輯：重寫的那份在 tour.js 被改壞時
// 不會變紅，等於白寫。tour.js 是 IIFE，頂層只碰 window 與 Vue.reactive（document／localStorage
// 都在方法裡才用到），所以 node 環境下給這兩個假物件就載得起來。
describe('步驟層 adminOnly：一般使用者看到的步驟與編號', () => {
  const loadEngine = (role) => {
    jest.resetModules();
    const win = { UserStore: { role } };
    global.window = win;
    global.Vue = { reactive: (o) => o };
    require(path.join(publicDir, 'js/tour-courses.js'));
    require(path.join(publicDir, 'js/tour.js'));
    return win;
  };
  afterAll(() => { delete global.window; delete global.Vue; });

  // TourHost 的 courses／course／step／lastIdx 是 Vue computed，彼此以 this 互相引用。
  // 用 getter 兜一個假 this 直接呼叫它們＝驗的是使用者真的會看到的那條計算路徑，
  // 不是測試自己算的另一套。
  const hostCtx = (win, courseId, stepIdx) => {
    // tour.js 的 IIFE 在**呼叫當下**才解析 window（讀 UserStore.role），所以要驗哪一個角色，
    // 就得先把 global.window 換成那一份；少了這行，兩個角色會共用最後載入的那個 window，
    // 而「兩邊算出來一樣」看起來像過濾沒生效，不像測試自己搭錯棚。
    global.window = win;
    const c = win.TourHost.computed;
    const ctx = { state: { courseId, stepIdx } };
    ['courses', 'course', 'step', 'lastIdx'].forEach((k) => {
      // getter 是惰性的，求值時 global.window 可能已被另一個角色的 ctx 換掉 → 每次都重綁
      Object.defineProperty(ctx, k, { get: () => { global.window = win; return c[k].call(ctx); } });
    });
    return ctx;
  };

  const ADMIN = loadEngine('admin');
  const USER = loadEngine('user');
  const authored = ADMIN.TOUR_COURSES;

  test('載得到引擎與課程（載入失敗時不得靜默通過）', () => {
    expect(typeof ADMIN.TourHost).toBe('object');
    expect(authored.length).toBeGreaterThanOrEqual(8);
    const totalSteps = authored.reduce((n, c) => n + c.steps.length, 0);
    expect(totalSteps).toBeGreaterThanOrEqual(50);
  });

  test('確實有步驟被標記（全部沒標時等於本機制沒上線，不得靜默通過）', () => {
    const marked = authored.flatMap(c => c.steps.filter(s => s.adminOnly).map(s => `${c.id}/${s.title}`));
    expect(marked.length).toBeGreaterThanOrEqual(3);
  });

  test('一般使用者拿到的課程裡，一步 adminOnly 都不剩', () => {
    const offenders = hostCtx(USER, null, 0).courses
      .flatMap(c => c.steps.filter(s => s.adminOnly).map(s => `${c.id}/${s.title}`));
    expect(offenders).toEqual([]);
  });

  test('過濾不得改動原始課程定義（重算一次就少一步的話，教程會越上越短）', () => {
    const before = authored.find(c => c.id === 'project').steps.length;
    hostCtx(USER, null, 0).courses;   // 再算一次
    hostCtx(USER, null, 0).courses;
    expect(ADMIN.TOUR_COURSES.find(c => c.id === 'project').steps.length).toBe(before);
  });

  // ── 編號：濾掉步驟會改變「第幾步是哪一步」。說明框印的是
  // 「{{ state.stepIdx + 1 }} / {{ course.steps.length }}」，而 course 來自 visibleCourses()，
  // 所以分子分母與 step 取值必須出自同一個過濾後的陣列，否則就是無聲的 off-by-one。
  test('說明框的分子分母與進度條都讀同一個 course.steps（改成讀原始課程就要紅）', () => {
    const src = read('js/tour.js');
    expect(src).toContain('{{ state.stepIdx + 1 }} / {{ course.steps.length }}');
    expect(src).toContain('(state.stepIdx + 1) / course.steps.length * 100');
    expect(src).toContain('courses() { return visibleCourses(); }');
    expect(src).toContain('this.course.steps[this.state.stepIdx]');
    expect(src).toContain('this.course.steps.length - 1');
  });

  test('「專案」課：管理員 6 步，一般使用者 3 步且沒有空洞', () => {
    const admin = hostCtx(ADMIN, 'project', 0);
    expect(admin.course.steps.length).toBe(6);
    expect(admin.lastIdx).toBe(5);

    const user = hostCtx(USER, 'project', 0);
    const targets = user.course.steps.map(s => s.target);
    expect(targets).toEqual([
      '[data-tour="nav-projects"]',
      '[data-tour="pd-env"]',
      '[data-tour="pd-tools"]'
    ]);
    expect(user.lastIdx).toBe(2);
    // 逐格取值：第 n 步顯示的內容必須就是過濾後的第 n 個，不能跳號
    targets.forEach((target, i) => {
      expect(hostCtx(USER, 'project', i).step.target).toBe(target);
    });
    // 最後一步的下一格必須是空的——否則「完成」鈕會出現在還有內容的地方
    expect(hostCtx(USER, 'project', 3).step).toBeUndefined();
  });

  test('「實際流程」第⑤步保留給一般使用者，但不點管理員才看得到的執行歷程', () => {
    const admin = hostCtx(ADMIN, 'flow', 4).step;
    const user = hostCtx(USER, 'flow', 4).step;
    expect(admin.click).toBe('[data-tour="td-events-open"]');
    expect(admin.target).toBe('[data-tour="td-events"]');
    expect(user.title).toBe(admin.title);
    expect(user.click).toBeFalsy();
    expect(user.target).toBe('[data-tour="td-action"]');
    expect(user.text).not.toContain('即時歷程');
  });

  test('每一門可見課程從第 1 步走到 lastIdx 都取得到步驟（任一格空掉＝編號錯位）', () => {
    const courses = hostCtx(USER, null, 0).courses;
    expect(courses.length).toBeGreaterThanOrEqual(6);
    courses.forEach((c) => {
      const ctx0 = hostCtx(USER, c.id, 0);
      expect(`${c.id}:${ctx0.lastIdx}`).toBe(`${c.id}:${c.steps.length - 1}`);
      for (let i = 0; i <= ctx0.lastIdx; i += 1) {
        const step = hostCtx(USER, c.id, i).step;
        expect(step ? `${c.id}#${i + 1}` : `${c.id}#${i + 1} 取不到步驟`).toBe(`${c.id}#${i + 1}`);
      }
    });
  });

  test('步驟全被濾掉的課程不出現在選單（空課點進去是一個沒有內容的說明框）', () => {
    const win = loadEngine('user');
    win.TOUR_COURSES.push({
      id: 'all-admin-probe', name: '探針', desc: '全部步驟都是管理員限定',
      steps: [{ adminOnly: true, route: '/', target: '[data-tour="x"]', title: 'x' }]
    });
    expect(hostCtx(win, null, 0).courses.map(c => c.id)).not.toContain('all-admin-probe');
    expect(win.TourManager.remainingCount()).toBe(hostCtx(win, null, 0).courses.length);
  });

  // ── 對帳：哪些錨點在原始碼裡就掛著 isAdmin。自動掃出來而不是寫死清單——
  // 寫死的清單會在下一個功能被藏起來時腐爛成假事實（本檔開頭那份檔案清單就是前車之鑑）。
  describe('掛著 isAdmin 的錨點，不能出現在一般使用者看到的步驟', () => {
    const NEXT_DIR = path.join(publicDir, 'js/ui-next');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
    });
    // 同一個標籤上同時有 v-if="isAdmin…" 與 data-tour="…"（順序不拘）
    const gated = new Set();
    for (const f of walk(NEXT_DIR)) {
      const src = fs.readFileSync(f, 'utf8');
      for (const tag of src.match(/<[a-zA-Z][^>]*>/g) || []) {
        if (!/v-if="isAdmin/.test(tag)) continue;
        const m = tag.match(/data-tour="([^"]+)"/);
        if (m) gated.add(m[1]);
      }
    }

    test('掃得到掛 isAdmin 的錨點（regex 失效時不得靜默通過）', () => {
      expect([...gated].sort()).toEqual(['proj-add', 'td-events-open']);
    });

    test.each([...gated])('一般使用者不會被導向 %s', (anchor) => {
      const sel = `[data-tour="${anchor}"]`;
      expect(authored.some(c => c.steps.some(s => s.target === sel || s.click === sel))).toBe(true);
      const offenders = hostCtx(USER, null, 0).courses.flatMap(c => c.steps
        .filter(s => s.target === sel || s.click === sel)
        .map(s => `${c.id}/${s.title}`));
      expect(offenders).toEqual([]);
    });
  });

  // pd-repos／pd-mapping 的 isAdmin 掛在祖先（分頁列 tabs() 與整塊 section）上，上面那段掃不到，
  // 所以把「這兩個分頁是管理員限定」這個事實單獨釘住——分頁改成全開時這裡會紅，提醒回來鬆綁。
  describe('ProjectDetail 的管理員限定分頁與對應步驟', () => {
    const src = () => read('js/ui-next/pages/ProjectDetail.js');

    test('tabs() 仍以 isAdmin() 濾掉 repos／db／settings', () => {
      expect(src()).toContain('if (key === "repos" || key === "db" || key === "settings") return this.isAdmin();');
    });

    test.each([
      ['pd-repos', 'repos'],
      ['pd-mapping', 'settings']
    ])('%s（%s 分頁）那一步標了 adminOnly', (anchor) => {
      const sel = `[data-tour="${anchor}"]`;
      const hits = authored.flatMap(c => c.steps.filter(s => s.target === sel).map(s => ({ where: `${c.id}/${s.title}`, ok: !!s.adminOnly })));
      expect(hits.length).toBe(1);
      expect(hits.filter(h => !h.ok).map(h => h.where)).toEqual([]);
    });
  });
});
