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

  test('不得寫死顏色，一律走 app.css 變數', () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, '');
    // rgba(9,9,12,...) 這類遮罩黑是刻意的例外：遮罩不屬於任何語意色 token。
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex.filter(h => h.toLowerCase() !== '#fff' && h.toLowerCase() !== '#ffffff')).toEqual([]);
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
describe('data-tour 錨點與課程定義對得上', () => {
  const VIEW_FILES = [
    'js/app.js', 'js/views/Settings.js', 'js/views/TaskList.js',
    'js/views/TaskDetail.js', 'js/views/ProjectList.js', 'js/views/ProjectDetail.js',
    'js/views/WikiView.js', 'js/views/ProjectChat.js', 'js/views/ProjectDbQuery.js',
    'js/views/TokenReport.js', 'js/views/Admin.js'
  ];
  const anchors = new Set();
  for (const f of VIEW_FILES) {
    for (const m of read(f).matchAll(/data-tour="([^"]+)"/g)) anchors.add(m[1]);
  }
  // Wiki 樹是遞迴元件，錨點由 node_type 組出來（:data-tour="'wiki-node-' + node.node_type"），
  // 靜態掃不到字面值 → 在此列出後端 wiki 實際會產出的四種 node_type，並守住那段拼接還在。
  test('wiki 樹的動態錨點仍以 node_type 拼接', () => {
    expect(read('js/views/WikiView.js')).toContain(`:data-tour="'wiki-node-' + node.node_type"`);
  });
  ['notes', 'overview', 'module', 'troubleshooting'].forEach(t => anchors.add('wiki-node-' + t));

  const wanted = [...new Set(
    [...read('js/tour-courses.js').matchAll(/\[data-tour="([^"]+)"\]/g)].map(m => m[1])
  )];

  test('掃得到錨點與課程選字（regex 失效時不得靜默通過）', () => {
    expect(anchors.size).toBeGreaterThanOrEqual(25);
    expect(wanted.length).toBeGreaterThanOrEqual(25);
  });

  test.each(wanted)('課程用到的 %s 在 view 裡存在', (name) => {
    expect(anchors.has(name)).toBe(true);
  });
});

// 報表與管理員設定的路由有 requiresAdmin，教程帶一般使用者過去只會被導回首頁。
// （資料庫查詢已開放給所有登入者，故不在此清單內。）
describe('管理員限定課程不對一般使用者出現', () => {
  const courses = read('js/tour-courses.js');
  const ADMIN_ROUTES = ['/token-report', '/admin'];

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

  // 使用者明確指定按鈕位置在登出左邊；靠 DOM 先後順序守住。
  test('入口按鈕排在「登出」之前', () => {
    const src = appJs();
    expect(src.indexOf('tour-launch')).toBeLessThan(src.indexOf('>登出<'));
  });

  test('TourHost 有被註冊且掛進 template', () => {
    const src = appJs();
    expect(src).toContain("app.component('TourHost', window.TourHost)");
    expect(src).toContain('<tour-host />');
  });
});
