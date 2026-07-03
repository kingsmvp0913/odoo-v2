// 瀏覽器桌面通知：使用者於個人設定主動開啟才請求權限；旗標存 localStorage（權限本就 per-browser）
(function () {
  const KEY = 'notifyEnabled';
  const supported = 'Notification' in window;

  function isOn() { return localStorage.getItem(KEY) === 'true'; }

  // 實際能發通知 = 使用者已開啟 + 瀏覽器支援 + 已授權
  function enabled() { return isOn() && supported && Notification.permission === 'granted'; }

  // 開啟：必要時請求權限。回傳 { ok, reason }
  async function enable() {
    if (!supported) return { ok: false, reason: 'unsupported' };
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm === 'granted') { localStorage.setItem(KEY, 'true'); return { ok: true }; }
    localStorage.setItem(KEY, 'false');
    return { ok: false, reason: 'denied' };
  }

  function disable() { localStorage.setItem(KEY, 'false'); }

  function show(title, body, tag, onClick) {
    if (!enabled()) return;
    try {
      const n = new Notification(title, { body, tag: tag != null ? String(tag) : undefined });
      n.onclick = () => { window.focus(); if (onClick) onClick(); n.close(); };
    } catch { /* 忽略 */ }
  }

  window.NotifyManager = { supported, isOn, enabled, enable, disable, show };
})();
