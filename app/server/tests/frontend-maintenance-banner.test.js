const fs = require('fs');
const path = require('path');

const uiNextDir = path.join(__dirname, '..', '..', 'public', 'js', 'ui-next');
const pagesDir = path.join(uiNextDir, 'pages');
const readPage = (f) => fs.readFileSync(path.join(pagesDir, f), 'utf8');

// 這支原本守的是「維護中橫幅」在 TaskList.js／TaskDetail.js 各自硬寫的字面值不會漂移
// （兩處刻意不抽全域常數，controller ruling：為單一 UI 字串串全域常數要過 CDN 載入順序關）。
//
// 2026-09-05 使用者裁決「橫幅太不明顯，改成全站右上角一條斜緞帶」，兩頁的橫幅都移除、
// 顯示點收斂到 UiNextApp.js 的 .ui-next-ribbon 一處——**漂移的前提（同一句話寫兩份）
// 從根本消失了**，所以守衛換方向：改成擋住「有人又在個別頁面補一份自己的維護提示」。
// 那種倒退不會壞掉，只會讓同一件事在不同頁面有不同說法，而且沒有人負責同步。
describe('維護中提示只能有一個顯示處', () => {
  test('全站緞帶掛在 shell 上，且吃的是 maintenance 狀態', () => {
    const shell = fs.readFileSync(path.join(uiNextDir, 'UiNextApp.js'), 'utf8');
    expect(shell).toMatch(/class="ui-next-ribbon"/);
    // 只檢查 class 會讓「緞帶永遠顯示／永遠不顯示」也通過——條件本身要在
    expect(shell).toMatch(/v-if="maintenance"[^>]*class="ui-next-ribbon"/);
  });

  // ⚠ 掃整個 pages 目錄，不列死檔名：列死清單的守衛，之後新增的頁一律漏掃（rules/testing）。
  test('個別頁面不得再自己掛維護橫幅', () => {
    const offenders = fs.readdirSync(pagesDir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /ui-next-maintenance-banner/.test(readPage(f)));
    expect(offenders).toEqual([]);
  });
});
