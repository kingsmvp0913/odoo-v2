// 全站唯一把 markdown 轉成 HTML 的地方。
// wiki 頁的內容主要由 library agent 從客戶 repo 的程式碼摘出來——那是不受信任的外部輸入，
// 而渲染結果直接進 v-html。marked 自 v5 起移除 sanitize 選項，預設就讓原始 HTML 原封不動穿透，
// 所以「不消毒」是它的預設行為、不是設定失誤，必須在這裡自己關掉。
(function () {
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 只放行這幾種 scheme；javascript:、vbscript:、data:text/html 放進 href 都能執行腳本。
  const SAFE_SCHEMES = ['http', 'https', 'mailto'];

  const safeUrl = (href, isImage) => {
    // 先還原瀏覽器自己會解的實體編碼與控制字元：java&#115;cript: 與 java<tab>script: 這類寫法
    // 在原字串上看不出 scheme，只比對原字串會直接放行，瀏覽器卻照樣執行。
    const decoded = String(href == null ? '' : href)
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&colon;/gi, ':')
      .split('').filter((c) => c.charCodeAt(0) > 32).join('')  // 去掉空白與控制字元
      .toLowerCase();
    const m = decoded.match(/^([a-z0-9+.\-]*):/);
    if (!m) return href;                                   // 沒有 scheme＝相對路徑或錨點
    if (SAFE_SCHEMES.indexOf(m[1]) >= 0) return href;
    // 圖片另放行內嵌的 data:image/，但排除 svg——SVG 可夾帶腳本。
    if (isImage && decoded.indexOf('data:image/') === 0 && decoded.indexOf('data:image/svg') !== 0) return href;
    return '';
  };

  let configured = false;
  const configure = (marked) => {
    if (configured) return;
    marked.use({
      // 原始 HTML 一律當文字：轉義而非丟棄——wiki 內文常直接寫標籤名，整段吃掉等於弄壞頁面。
      renderer: { html: (html) => escapeHtml(html) },
      walkTokens: (token) => {
        if (token.type === 'link' || token.type === 'image') {
          token.href = safeUrl(token.href, token.type === 'image');
        }
      }
    });
    configured = true;
  };

  const renderMarkdown = (src) => {
    const text = String(src == null ? '' : src);
    // marked 沒載到（資產 404、被擋）時只能當純文字。原本的 fallback 是把原文直接交給 v-html，
    // 等於零 markdown 解析卻保留了全部的 HTML 執行能力，比有 marked 的情況更糟。
    if (typeof window === 'undefined' || !window.marked) return escapeHtml(text);
    configure(window.marked);
    return window.marked.parse(text);
  };

  if (typeof window !== 'undefined') window.renderMarkdown = renderMarkdown;
  if (typeof module !== 'undefined') module.exports = { renderMarkdown };
})();
