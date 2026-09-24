const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

// 把 api.js 真的跑起來，而不是比對它的字。
//
// 為什麼改：這支原本斷言原始碼裡出現「authState.loggedIn = true」這幾個字。程式後來
// 改成 `= !!readToken()`（更嚴謹——setToken('') 不該算成已登入），行為完全正確，守衛
// 卻紅了。文字比對守得住「寫法」，守不住「意圖」，而紅燈久了就會被當成既有問題放過去。
//
// api.js 只需要 Vue.reactive、兩個 storage 與 window 就跑得起來（fetch 只在方法內用到），
// 所以不需要 Vue mount 那套 infra。
function loadApi() {
  const mkStorage = () => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  };
  const sandbox = {
    Vue: { reactive: (o) => o },   // 這支測的是「有沒有寫進去」，不是 Vue 的追蹤機制
    localStorage: mkStorage(),
    sessionStorage: mkStorage(),
    window: {},
    console,
  };
  vm.runInNewContext(read('js/api.js'), sandbox, { filename: 'api.js' });
  return sandbox.window.Api;
}

// 守的契約：驅動「登入殼層 vs 登入頁」切換的登入狀態必須 reactive。
// 症狀（1.png）：Api.isLoggedIn() 讀 localStorage（非 reactive），外殼的 isLoggedIn
// computed 卡在首次求值 false → 表單登入後 v-if 仍停在裸 <router-view>，sidebar/main
// 從未 render，任務列表的 topbar/content 掉進 #app 的橫排 flex → 版面塌掉，只能重整。
// 這是靜態守門（前端無 Vue mount 測試 infra），把回歸擋在 commit 前。
// 2026-09-22 舊版前端退役：外殼只剩 ui-next 那一套，isLoggedIn 跟著搬到 UiNextApp.js。
describe('登入狀態必須 reactive（表單登入後版面立即切殼層，免重整）', () => {
  const api = read('js/api.js');
  const app = read('js/app.js');
  const shell = read('js/ui-next/UiNextApp.js');

  test('api.js 以 reactive 旗標保存登入狀態', () => {
    expect(api).toMatch(/authState:\s*Vue\.reactive/);
  });

  test('setToken／clearToken 真的同步 authState.loggedIn（涵蓋登入、登出、401 清除）', () => {
    const Api = loadApi();
    expect(Api.authState.loggedIn).toBe(false);
    Api.setToken('jwt-abc');
    expect(Api.authState.loggedIn).toBe(true);
    Api.clearToken();
    expect(Api.authState.loggedIn).toBe(false);
    // 空字串不該算登入。這正是「寫死成 = true」會漏掉的那一格，也是程式現在寫
    // `= !!readToken()` 的理由——所以順手把它釘住，免得有人「修好」守衛時改回寫死。
    Api.setToken('');
    expect(Api.authState.loggedIn).toBe(false);
  });

  test('外殼的 isLoggedIn computed 讀 reactive authState，而非非-reactive 的 Api.isLoggedIn()', () => {
    const m = shell.match(/isLoggedIn\(\)\s*{\s*return\s+([^;]+);/);
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
