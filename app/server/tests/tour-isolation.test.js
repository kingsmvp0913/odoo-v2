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
  const ADMIN_ROUTES = ['/token-report', '/admin', '/admin/settings'];

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
describe('示範資料的接線都有守衛', () => {
  test.each([
    'js/views/TaskList.js', 'js/views/TaskDetail.js',
    'js/views/ProjectList.js', 'js/views/ProjectDetail.js',
    'js/views/WikiView.js', 'js/views/ProjectChat.js', 'js/views/ProjectDbQuery.js'
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
  // 這條反向守著——留一顆點下去只會看到全部對不準的教學的鈕，比拿掉更糟。
  test('舊介面側欄不再有教學入口', () => {
    const src = appJs();
    expect(src).not.toContain('tour-launch');
    expect(src).not.toContain('TourManager.open()');
  });

  test('TourHost 有被註冊且掛進 template', () => {
    const src = appJs();
    // 比對放寬到引號風格不敏感：app.js 走過 prettier 後字面值從單引號變雙引號，
    // 註冊行原封不動卻讓這條紅——那是格式假紅，會誘人以為 TourHost 真的被拔掉。
    expect(src).toMatch(/app\.component\(\s*['"]TourHost['"]\s*,\s*window\.TourHost\s*\)/);
    expect(src).toContain('<tour-host />');
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
