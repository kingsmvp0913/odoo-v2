/**
 * frontend-forbidden-view.test.js — 403 頁必須套得到樣式
 *
 * 2026-09-24 實機截圖發現：這一頁從 09-22 舊版前端退役那天起就是**完全沒有樣式的裸 HTML**
 * （瀏覽器預設 h1、藍色底線連結、貼齊左上角）。原因是它用的 .auth-container／.auth-card
 * 是舊版的 class，CSS 被一起刪掉了。
 *
 * **沒有任何測試會紅**——class 不存在不是語法錯誤，頁面照樣 render。而這是客戶亂點時
 * 最常撞到的一頁，等於客戶看到的第一個「這平台有點粗糙」的畫面。
 *
 * 所以這支守的是「它有沒有掛在活著的外殼上」，不是它長什麼樣。
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '../../public');
const appJs = fs.readFileSync(path.join(PUB, 'js/app.js'), 'utf8');
const forbidden = appJs.slice(appJs.indexOf('const ForbiddenView'), appJs.indexOf('const router'));

// 舊版前端 2026-09-22 整個退役，這兩個 class 的 CSS 已經不存在
const DEAD = ['auth-container', 'auth-card'];

test('403 頁掛在活著的頁面外殼上（.ui-next-page）', () => {
  expect(`ForbiddenView 切得到: ${forbidden.length > 100}`).toBe('ForbiddenView 切得到: true');
  expect(forbidden).toContain('class="ui-next-page"');
});

test.each(DEAD)('全站不得再引用已刪除的舊版 class：%s', (cls) => {
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { walk(full); continue; }
      if (!/\.(js|html)$/.test(f.name)) continue;
      // 只看「真的被當成 class 用」，不是「被提到」——說明為什麼不能再用它的註解
      // 本身就會含有這個字串（2026-09-24 第一版寫成 includes 就被自己的註解絆倒）。
      const src = fs.readFileSync(full, 'utf8');
      if (new RegExp(`class="[^"]*\\b${cls}\\b`).test(src)) hits.push(path.relative(PUB, full));
    }
  };
  walk(PUB);
  // 訊息帶檔名：只回 true/false 的話，紅了還要自己再 grep 一次
  expect(`${cls} 出現在: ${hits.join(', ') || '(無)'}`).toBe(`${cls} 出現在: (無)`);
});

// .btn 全站只用在 <button> 上，從來沒有清過 <a> 的底線——把它掛到 router-link 會得到
// 一顆「有底線的按鈕」（2026-09-24 實測）。要嘛補 CSS，要嘛用真的 button；這裡選後者。
test('返回首頁是真的 button，不是套了 .btn 的連結', () => {
  expect(forbidden).toContain('<button class="btn');
  expect(`有沒有把 .btn 掛到 router-link: ${/router-link[^>]*class="[^"]*\bbtn\b/.test(forbidden)}`)
    .toBe('有沒有把 .btn 掛到 router-link: false');
});
