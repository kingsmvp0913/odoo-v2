const fs = require('fs');
const path = require('path');

const pagesDir = path.join(__dirname, '..', '..', 'public', 'js', 'ui-next', 'pages');
const readPage = (f) => fs.readFileSync(path.join(pagesDir, f), 'utf8');

// 守的是「維護中橫幅」在 TaskList.js／TaskDetail.js 各自硬寫的字面值不會日後漂移。
// 兩處刻意不抽全域常數（controller ruling：為單一 UI 字串串全域常數要過 CDN 載入順序關，
// 成本高於風險）——防漂移改由本測試代勞：任一處改了文案、另一處沒跟著改，這裡就會紅。
describe('維護中橫幅文案不得在兩處漂移', () => {
  const bannerRe = /class="ui-next-maintenance-banner">([^<]*)<\/div>/;

  test('TaskList.js 與 TaskDetail.js 都含 ui-next-maintenance-banner class', () => {
    expect(readPage('TaskList.js')).toMatch(bannerRe);
    expect(readPage('TaskDetail.js')).toMatch(bannerRe);
  });

  test('兩處橫幅文字字面值完全相同', () => {
    const taskListText = readPage('TaskList.js').match(bannerRe)[1];
    const taskDetailText = readPage('TaskDetail.js').match(bannerRe)[1];
    expect(taskListText).toBe(taskDetailText);
  });
});
