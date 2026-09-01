// 深色模式管理：localStorage 即時套用（避免閃爍）+ 登入後同步個人設定
(function () {
  const KEY = 'theme';

  function current() { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; }

  function apply(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  function emit(theme) { window.dispatchEvent(new CustomEvent('themechange', { detail: theme })); }

  // 使用者主動切換：本機立即生效 + 寫回個人設定
  function set(theme) {
    theme = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem(KEY, theme);
    apply(theme);
    emit(theme);
    if (window.Api && Api.isLoggedIn && Api.isLoggedIn()) {
      Api.put('settings/theme', { theme }).catch(() => {});
    }
  }

  function toggle() { set(current() === 'dark' ? 'light' : 'dark'); }

  // 從後端個人設定同步。只在本機還沒有偏好時採用（換裝置、無痕、清過快取）。
  //
  // ⚠ 不可改成「一律以後端為準」：這支在 router.afterEach 每次導覽都會被呼叫，而 set()
  // 寫回後端是 fire-and-forget。切換深淺色之後馬上換頁，auth/me 會比那支 PUT 先回來，
  // 於是剛選好的偏好被舊值打回去——使用者看到的就是「操作到一半突然變回淺色」。
  // 本機是使用者剛剛按下去的結果，永遠比一次導覽讀到的後端快照新。
  function syncFromServer(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    if (localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, theme);
    apply(theme);
    emit(theme);
  }

  apply(current()); // 載入時立即套用
  window.ThemeManager = { current, apply, set, toggle, syncFromServer };
})();
