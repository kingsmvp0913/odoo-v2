const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

// 守的契約：驅動「登入殼層 vs 登入頁」切換的登入狀態必須 reactive。
// 症狀（1.png）：Api.isLoggedIn() 讀 localStorage（非 reactive），App 的 isLoggedIn
// computed 卡在首次求值 false → 表單登入後 v-if 仍停在裸 <router-view>，sidebar/main
// 從未 render，TaskListView 的 topbar/content 掉進 #app 的橫排 flex → 版面塌掉，只能重整。
// 這是靜態守門（前端無 Vue mount 測試 infra），把回歸擋在 commit 前。
describe('登入狀態必須 reactive（表單登入後版面立即切殼層，免重整）', () => {
  const api = read('js/api.js');
  const app = read('js/app.js');

  test('api.js 以 reactive 旗標保存登入狀態', () => {
    expect(api).toMatch(/authState:\s*Vue\.reactive/);
  });

  test('setToken／clearToken 皆同步 authState.loggedIn（涵蓋登入、登出、401 清除）', () => {
    expect(api).toMatch(/setToken\([^)]*\)\s*{[^}]*authState\.loggedIn\s*=\s*true/);
    expect(api).toMatch(/clearToken\(\)\s*{[^}]*authState\.loggedIn\s*=\s*false/);
  });

  test('App 的 isLoggedIn computed 讀 reactive authState，而非非-reactive 的 Api.isLoggedIn()', () => {
    const m = app.match(/isLoggedIn\(\)\s*{\s*return\s+([^;]+);/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('authState');
    expect(m[1]).not.toContain('isLoggedIn()');
  });

  // 同一登入路徑家族：表單登入只走 afterEach（不經 mounted 已登入分支），
  // 漏同步 theme 會讓無痕登入永遠卡在預設淺色。此測守 afterEach 的 auth/me
  // handler 內必須套用 DB 的深色偏好。
  test('表單登入路徑（afterEach 的 auth/me）同步深色偏好', () => {
    // 引號與 arrow function 括號都放寬：prettier 會把 `me =>` 補成 `(me) =>`、單引號換雙引號，
    // 同步行為原封不動卻讓這條紅。要守的是「auth/me 的 then 裡有 syncFromServer」。
    expect(app).toMatch(
      /auth\/me['"]\)\s*\.then\(\s*\(?me\)?\s*=>\s*{[\s\S]*?ThemeManager\.syncFromServer\(me\.odoo_settings[\s\S]*?}\)/,
    );
  });
});
