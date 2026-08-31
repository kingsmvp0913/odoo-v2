const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../../public');
const readPublic = (f) => fs.readFileSync(path.join(publicDir, f), 'utf8');

// 走訪全樹而非寫死檔案清單：漏洞的成因就是「某一支 view 自己把不受信任的字串塞進 v-html」，
// 寫死清單只擋得住當初改到的那幾支，下一支新 view 照樣能複製一份進來，防線形同虛設。
// vendor/ 是第三方 bundle、不歸我們管，排除。
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.name === 'vendor' ? [] :
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const allPublicFiles = walk(publicDir).map((f) => path.relative(publicDir, f));

const MARKDOWN_JS = path.join('js', 'markdown.js');

// ---------------------------------------------------------------------------
// 行為測試：用真正 vendored 的 marked（v9.1.6）跑，不 mock。
// 這裡守的是「wiki 內容是不受信任的輸入」這件事——wiki 頁主要由 library agent 從客戶 repo 的
// 程式碼摘出來，客戶 repo 裡的一段 <img src=x onerror=...> 會原封不動變成平台使用者的 session
// 內執行的腳本，而 localStorage 裡有 admin JWT。攻擊者不需要平台帳號。
// ---------------------------------------------------------------------------
const marked = require('../../public/js/vendor/marked.min.js');
global.window = { marked };
const { renderMarkdown } = require('../../public/js/markdown.js');

describe('renderMarkdown 關掉原始 HTML 穿透', () => {
  // marked 自 v5 起移除 sanitize 選項，預設讓原始 HTML 原封不動輸出。
  // 每一則 payload 都必須「看得到原文、但不是可執行的標籤」。
  const payloads = {
    '區塊層級 img onerror': '<img src=x onerror=alert(1)>',
    '行內 img onerror': '一段說明 <img src=x onerror=alert(1)> 後續',
    'script 標籤': '<script>alert(1)</script>',
    'iframe': '<iframe src=javascript:alert(1)></iframe>',
    // 用成對標籤而非 <svg/onload=...>：後者 marked 本來就不當成 HTML token（會自己轉義），
    // 拿它當案例是零鑑別力的假綠——漏洞還在時它照樣通過。
    'svg onload': '<svg onload=alert(1)></svg>',
    '連結文字內的 HTML': '[<img src=x onerror=alert(1)>](https://example.com)',
    '表格儲存格內的 HTML': '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
  };

  test.each(Object.entries(payloads))('%s 被轉義而非執行', (_name, src) => {
    const html = renderMarkdown(src);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<svg/i);
    // 不能單純比對 onerror／onload 字串：轉義後的原文「本來就」含這些字（&lt;svg/onload=…&gt;），
    // 那是正確輸出。要問的是「有沒有一個真的標籤帶著事件處理屬性」。
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
  });

  test('轉義後原文仍看得見（不是整段被吃掉——那是壞掉不是安全）', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toContain('&lt;img');
  });
});

describe('renderMarkdown 擋掉會執行腳本的 URL scheme', () => {
  const badUrls = {
    'javascript: 連結': '[c](javascript:alert(1))',
    'javascript: 大小寫混用': '[c](JaVaScRiPt:alert(1))',
    // 實體編碼是最容易漏的一手：href 屬性內的 &#115; 由瀏覽器解碼，只比對原字串的 scheme 檢查會放行。
    'javascript: 實體編碼': '[c](java&#115;cript:alert(1))',
    'vbscript: 連結': '[c](vbscript:msgbox(1))',
    'data:text/html 連結': '[c](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    'javascript: 圖片': '![x](javascript:alert(1))',
  };

  // 斷言的是「屬性值本身變成空字串」，不是「輸出裡找不到 javascript 這個字」。後者對實體編碼那筆
  // 會假綠：原漏洞下輸出是 href="java&#115;cript:alert(1)"，不含 javascript 字樣，比對照樣通過，
  // 瀏覽器卻會解碼後執行。
  test.each(Object.entries(badUrls))('%s 的 href 被清空', (_name, src) => {
    const html = renderMarkdown(src);
    const attrs = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    expect(attrs.length).toBeGreaterThan(0); // 沒解析成連結／圖片的話這條測試等於沒測到東西
    expect(attrs).toEqual(attrs.map(() => ''));
  });
});

// 這一組是「不可以為了安全把正常 markdown 弄壞」的護欄。wiki 的頁面（含 notes 之外的人工編輯頁）
// 可能刻意寫了表格、程式碼區塊、清單，消毒過頭把它們一起吃掉同樣是 regression。
describe('renderMarkdown 不得破壞正常 markdown', () => {
  const expectations = [
    ['標題', '## 標題', /<h2>標題<\/h2>/],
    ['粗體', 'a **粗** b', /<strong>粗<\/strong>/],
    ['行內程式碼', '用 `<div>` 標籤', /<code>&lt;div&gt;<\/code>/],
    ['圍欄程式碼區塊', '```python\nif a < b:\n    pass\n```', /<pre><code class="language-python">if a &lt; b:/],
    ['表格', '| a | b |\n|---|---|\n| 1 | 2 |', /<table>[\s\S]*<td>1<\/td>/],
    ['清單', '- one\n- two', /<ul>[\s\S]*<li>one<\/li>/],
    ['引用', '> quoted', /<blockquote>/],
    ['一般 https 連結', '[go](https://a.b/c?d=1)', /<a href="https:\/\/a\.b\/c\?d=1">go<\/a>/],
    ['mailto 連結', '[m](mailto:a@b.c)', /<a href="mailto:a@b\.c">/],
    ['相對路徑連結', '[r](./docs/a.md)', /<a href="\.\/docs\/a\.md">/],
    ['錨點連結', '[a](#sec)', /<a href="#sec">/],
    ['一般圖片', '![i](https://a.b/i.png)', /<img src="https:\/\/a\.b\/i\.png"/],
    ['自動連結', 'https://x.y/z', /<a href="https:\/\/x\.y\/z">/],
  ];

  test.each(expectations)('%s', (_name, src, expected) => {
    expect(renderMarkdown(src)).toMatch(expected);
  });
});

// fallback 是原漏洞更糟的一半：marked 沒載到時把原文原封不動塞進 v-html，等於完全沒有 markdown
// 解析、卻保留了全部的 HTML 執行能力。此時唯一正確的行為是當純文字處理。
describe('marked 未載入時的 fallback', () => {
  let saved;
  beforeEach(() => { saved = global.window.marked; global.window.marked = undefined; });
  afterEach(() => { global.window.marked = saved; });

  test('原文不得原封不動輸出，必須轉義', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img');
  });

  test('null／undefined 不得變成字串 "null"', () => {
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 靜態守衛：擋「下次有人繞過 renderMarkdown 直接用 marked」與「新 view 又塞一個 v-html」。
// ---------------------------------------------------------------------------
describe('markdown 轉 HTML 只有一個入口', () => {
  const jsFiles = allPublicFiles.filter((f) => f.endsWith('.js') && f !== MARKDOWN_JS);

  test.each(jsFiles)('%s 不得直接碰 marked（一律走 renderMarkdown）', (file) => {
    // 直接呼叫 marked.parse 就繞過了消毒設定，而且不會有任何錯誤——輸出看起來完全正常。
    const offenders = readPublic(file).match(/\bmarked\b/g) || [];
    expect(offenders).toEqual([]);
  });

  test('markdown.js 確實設定了 marked 的消毒（否則上一條只是把漏洞搬家）', () => {
    const src = readPublic(MARKDOWN_JS);
    expect(src).toMatch(/marked\.use\(/);
  });

  test('index.html 載入 markdown.js，且排在 marked 與 WikiView 之間', () => {
    const html = readPublic('index.html');
    expect(html).toContain('<script src="js/markdown.js"></script>');
    expect(html.indexOf('js/vendor/marked.min.js')).toBeLessThan(html.indexOf('js/markdown.js'));
    expect(html.indexOf('js/markdown.js')).toBeLessThan(html.indexOf('js/views/WikiView.js'));
  });
});

describe('v-html 綁定白名單', () => {
  // v-html 是全站唯一能把字串當 HTML 執行的出口，因此把它當作需要逐一審過的清單來管：
  // 新增一個沒審過的 v-html 就讓測試紅，逼人來想「這個字串從哪來、消毒了沒」。
  const VETTED = new Set([
    'renderedContent',      // WikiView：走 renderMarkdown，見本檔上方行為測試
    'renderMd(m.content)',  // ProjectChat：renderMd 只是 renderMarkdown 的薄封裝（同一消毒入口）
    'ansiToHtml(ev.content)', // TaskDetail：函式內自行 escape 後才組 HTML（TaskDetail.js 的 esc()）
    // Next UI 是同樣這兩個綁定的重寫，消毒入口相同、只有 v-for 變數名不同：
    // UiNextPages.js 的 renderMd() 直接轉呼 renderMarkdown()；ansiToHtml() 內含自己的 esc()。
    // 白名單比對的是表達式「字面值」，所以改個變數名就落到清單外——那是刻意的，
    // 逼人重新確認新綁定的字串來源，不是可以隨手照抄補進來的形式差異。
    'renderMd(message.content)',  // UiNextProjectChatView：同 renderMd(m.content)
    'ansiToHtml(event.content)',  // UiNextTaskDetailView：同 ansiToHtml(ev.content)
    // tour.js：step.text 的字串來源全部是 tour-courses.js 裡硬編的靜態字面值；
    // 教程刻意不打任何 API（tour-isolation.test.js 守「不得出現 fetch/Api. 呼叫」），
    // 進度只存 localStorage，沒有 DB 資料、API 回應或使用者輸入會流進這個綁定。
    // ⚠️ 日後若有人把動態資料（API 回應、DB 內容、使用者輸入）接進 text，
    // 這筆白名單就失效了，必須改走跳脫。
    'step.text',            // tour.js：見上方理由
  ]);

  const found = [];
  for (const file of allPublicFiles.filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
    for (const m of readPublic(file).matchAll(/v-html\s*=\s*"([^"]*)"/g)) found.push([file, m[1]]);
  }

  test('掃得到 v-html（regex 失效時測試不得靜默通過）', () => {
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  test.each(found)('%s 的 v-html="%s" 已在白名單內', (_file, expr) => {
    expect(VETTED.has(expr.trim())).toBe(true);
  });
});
