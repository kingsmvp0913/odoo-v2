// 意圖：深色模式偏好存在 users.odoo_settings.theme（ThemeManager 切換時走 PUT /api/settings/theme
// 做 read-modify-write 寫進去）。但個人設定頁的「儲存」走的是 PUT /api/settings，那支是「整包覆寫」
// odoo_settings（COALESCE 只擋 null，給了物件就整個換掉）。save() 組 payload 時若只帶畫面上的
// teams_user_id + creds，theme 就被這次儲存從後端抹掉。本機 localStorage 還留著所以當下完全看不出來，
// 要換一台裝置或開無痕視窗（localStorage 空、只能向後端要偏好）才會發現永遠回淺色。
//
// 這裡是真的把 save() 叫起來看送出什麼，而不是比對原始碼字串：字串比對會被本檔自己的註解騙過，
// 也擋不住「有寫 theme 但實際取到 undefined」這種假通過。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/views/Settings.js');

// Settings.js 是瀏覽器腳本（掛全域、無 module.exports），以 stub 過的全域把它的 options 物件載出來。
// Vue.defineComponent 在載入當下就會被呼叫，故必須 stub；data()／template 不會執行。
function loadComponent(globals) {
  const src = fs.readFileSync(SRC, 'utf8');
  const win = {};
  Object.assign(win, globals.window || {});
  const factory = new Function(
    'Vue', 'window', 'Api', 'showToast', 'confirmDialog', 'ThemeManager', 'NotifyManager',
    `${src}\nreturn window.SettingsView;`
  );
  return factory(
    { defineComponent: (o) => o },
    win,
    globals.Api,
    globals.showToast || (() => {}),
    globals.confirmDialog || (() => {}),
    win.ThemeManager,
    globals.NotifyManager
  );
}

function makeApi(storedSettings = {}) {
  const puts = [];
  return {
    puts,
    api: {
      get: (p) => {
        if (p === 'auth/me') return Promise.resolve({ username: 'u', display_name: 'U' });
        if (p === 'settings') return Promise.resolve({ odoo_settings: storedSettings });
        if (p === 'settings/github-pat') return Promise.resolve({ configured: false });
        return Promise.resolve({});
      },
      put: (p, body) => { puts.push({ p, body }); return Promise.resolve({}); }
    }
  };
}

const baseCtx = () => ({
  saving: false,
  loading: false,
  savedSettings: {},
  teamsUserId: 'tid',
  creds: {
    odoo_username: 'ou', odoo_password: 'op', odoo_user_id: '7',
    service_username: 'su', service_password: 'sp', service_user_id: '8'
  },
  me: { username: 'u', display_name: 'U' },
  githubPat: { input: '', configured: false, login: '', saving: false }
});

const settingsPayload = (puts) => puts.find((x) => x.p === 'settings').body.odoo_settings;

describe('個人設定「儲存」不得抹掉不在這張表單上的偏好', () => {
  test('payload 帶著 theme（PUT /api/settings 是整包覆寫，沒帶＝從後端刪掉）', async () => {
    const { puts, api } = makeApi();
    const comp = loadComponent({ Api: api, window: { ThemeManager: { current: () => 'dark' } } });
    const ctx = { ...baseCtx(), savedSettings: { theme: 'dark' } };
    await comp.methods.save.call(ctx);
    expect(settingsPayload(puts).theme).toBe('dark');
  });

  // 使用者可能在同一頁按了深色模式開關（那顆已即時寫回後端）之後才按「儲存」。payload 若沿用
  // 載入當下的舊 theme，這次儲存等於把剛切好的偏好倒回去。
  test('theme 取當下值而非載入當下的值', async () => {
    const { puts, api } = makeApi();
    const comp = loadComponent({ Api: api, window: { ThemeManager: { current: () => 'dark' } } });
    const ctx = { ...baseCtx(), savedSettings: { theme: 'light' } };
    await comp.methods.save.call(ctx);
    expect(settingsPayload(puts).theme).toBe('dark');
  });

  // 根因是「整包覆寫」而不只是 theme 這一個 key——任何別處寫進 odoo_settings 的偏好都會被沖掉。
  // load() 必須把原本的整包記下來，save() 才有東西可帶回去。
  test('load() 讀到的其他偏好在 save() 後仍在（整包覆寫的根因）', async () => {
    const { puts, api } = makeApi({ theme: 'dark', teams_user_id: 'old', some_future_pref: 'keep-me' });
    const comp = loadComponent({ Api: api, window: { ThemeManager: { current: () => 'dark' } } });
    const ctx = baseCtx();
    await comp.methods.load.call(ctx);
    ctx.teamsUserId = 'edited-by-user'; // 使用者接著改了畫面上的欄位
    await comp.methods.save.call(ctx);
    const payload = settingsPayload(puts);
    expect(payload.some_future_pref).toBe('keep-me');
    // 鋪回舊整包不得反過來蓋掉表單現值
    expect(payload.teams_user_id).toBe('edited-by-user');
  });
});

// 意圖：syncFromServer 在 router.afterEach 每次導覽都會被叫到，而 set() 寫回後端是
// fire-and-forget。若這支「一律以後端為準」，切換深淺色後馬上換頁就會被舊快照打回去
// ——實測：切成 light、連續換三個頁面，畫面又變回 dark。
// 這裡把 theme.js 真的載進來跑，而不是比對原始碼字串。
describe('ThemeManager.syncFromServer 不得覆蓋本機剛選好的偏好', () => {
  const THEME_SRC = require('path').join(__dirname, '../../public/js/theme.js');

  function loadThemeManager(stored) {
    const store = { ...stored };
    const win = {
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      },
      dispatchEvent() {},
      CustomEvent: function () {},
      document: { documentElement: { setAttribute() {}, removeAttribute() {} } },
    };
    win.window = win;
    const code = require('fs').readFileSync(THEME_SRC, 'utf8');
    new Function('window', 'document', 'localStorage', `${code}`)(win, win.document, win.localStorage);
    return { tm: win.ThemeManager, store };
  }

  test('本機已有偏好時，後端值不覆蓋（切換後換頁不會被打回）', () => {
    const { tm, store } = loadThemeManager({ theme: 'light' });
    tm.syncFromServer('dark');            // 後端還是切換前的舊值
    expect(tm.current()).toBe('light');   // 使用者剛選的 light 必須留著
    expect(store.theme).toBe('light');
  });

  test('本機沒有偏好時才採用後端（換裝置／無痕）', () => {
    const { tm, store } = loadThemeManager({});
    tm.syncFromServer('dark');
    expect(tm.current()).toBe('dark');
    expect(store.theme).toBe('dark');
  });

  test('後端沒存或值不合法時不動本機', () => {
    const { tm } = loadThemeManager({ theme: 'dark' });
    tm.syncFromServer(undefined);
    tm.syncFromServer('purple');
    expect(tm.current()).toBe('dark');
  });
});
