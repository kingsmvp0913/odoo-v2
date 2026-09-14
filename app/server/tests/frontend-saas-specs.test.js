// 意圖：產品化規格頁是內部規劃文件，只能給平台管理員。
// 後端已擋 403（docs-routes.test.js），前端這裡釘住另外兩處（rules/frontend.md 38：nav／router／後端三處齊做），
// 以及 iframe 的隔離：規格頁會從外部 CDN 載入函式庫，若 iframe 與平台同源，那段外部程式就讀得到 localStorage 裡的登入 token。
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', '..', 'public');
const app = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
const shell = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'UiNextApp.js'), 'utf8');
const pageFile = path.join(pub, 'js', 'ui-next', 'pages', 'SaasSpecs.js');
const page = fs.existsSync(pageFile) ? fs.readFileSync(pageFile, 'utf8') : '';

test('更多工具裡的產品化規格入口只有管理員看得到', () => {
  const button = shell.match(/<button[^>]*go\('\/saas-specs'\)[^>]*>/);
  expect(button).not.toBeNull();
  expect(button[0]).toContain('v-if="isAdmin"');
});

test('/saas-specs 路由要求管理員', () => {
  const block = app.match(/path:\s*"\/saas-specs",[\s\S]*?\}/);
  expect(block).not.toBeNull();
  expect(block[0]).toContain('window.UiNextSaasSpecsView');
  expect(block[0]).toMatch(/meta:\s*\{[^}]*requiresAdmin:\s*true/);
});

test('規格頁放在隔離的 iframe：可以跑自己的程式，但與平台不同源', () => {
  const frame = page.match(/<iframe[^>]*>/);
  expect(frame).not.toBeNull();
  expect(frame[0]).toContain('sandbox="allow-scripts"');
  expect(frame[0]).not.toContain('allow-same-origin');
  // 內容要從帶登入 token 的 API 取，不能讓 iframe 直接 src 到 API（瀏覽器載 iframe 不會帶 Authorization）
  expect(page).toContain('Api.getBlob("docs/saas-specs")');
  expect(frame[0]).toContain(':srcdoc=');
});

test('規格頁走主要頁面的外殼，不是 Admin 子頁那一套', () => {
  expect(page).toContain('class="ui-next-page ui-next-specs-page"');
  expect(page).toContain('class="ui-next-page-head"');
  expect(page).not.toContain('class="topbar');
  expect(page).not.toContain('class="content"');
});

test('規格頁內的選單連結要留在 iframe 裡，不能把 iframe 導到平台網址', () => {
  // srcdoc iframe 的相對網址是用「平台頁面的網址」解析：規格頁選單是 <a href="#rollout">，
  // 沒有 base 時會變成 https://平台/#rollout，iframe 整個載入平台首頁；
  // 又因為沙箱不同源讀不到登入 token，畫面就是一片空白（09-14 使用者回報、playwright 重現）。
  expect(page).toContain('<base href="about:srcdoc">');
  const frame = page.match(/<iframe[^>]*>/);
  expect(frame[0]).toContain(':srcdoc="frameHtml"');
});
