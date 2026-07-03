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

  // 從後端個人設定同步（登入/換裝置時，以後端為準）
  function syncFromServer(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    if (theme === current()) return;
    localStorage.setItem(KEY, theme);
    apply(theme);
    emit(theme);
  }

  apply(current()); // 載入時立即套用
  window.ThemeManager = { current, apply, set, toggle, syncFromServer };
})();
