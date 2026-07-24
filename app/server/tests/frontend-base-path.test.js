const { basePathFrom } = require('../../public/js/base.js');

// 這支測試守的是「同一份前端在兩種前綴下都對」這個契約：本地跑在根路徑、伺服器掛在
// /odooAiDev/ 子路徑。前綴推導錯誤的症狀是資產 404 或 socket 連不上，且只在其中一邊出現。
describe('basePathFrom', () => {
  test('根路徑（Windows 本地 http://localhost:3939/）回傳 /', () => {
    expect(basePathFrom('http://localhost:3939/')).toBe('/');
  });

  test('子路徑（伺服器 /odooAiDev/）回傳含尾斜線的前綴', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/')).toBe('/odooAiDev/');
  });

  test('直接指到 index.html 時仍取得所屬目錄，不含檔名', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/index.html')).toBe('/odooAiDev/');
  });

  test('hash routing 的 fragment 不影響前綴（SPA 切畫面時前綴必須恆定）', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/#/task/5')).toBe('/odooAiDev/');
    expect(basePathFrom('http://localhost:3939/#/admin/users')).toBe('/');
  });

  test('setup.html 與 index.html 推出同一個前綴（兩頁共用同一支 base.js）', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/setup.html'))
      .toBe(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/'));
  });
});
