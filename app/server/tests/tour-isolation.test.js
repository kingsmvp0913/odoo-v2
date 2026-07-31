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
  test.each(['js/tour.js', 'js/tour-courses.js'])('%s 不含 fetch/Api 呼叫', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bApi\.(get|post|patch|delete|postForm|getBlob)\s*\(/);
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
    expect(at('js/base.js')).toBeLessThan(at('js/tour-courses.js'));
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
