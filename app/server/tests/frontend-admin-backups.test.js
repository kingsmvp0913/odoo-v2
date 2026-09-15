// 意圖：備份管理只給平台管理員——後端 403 見 admin-backup-routes.test.js，這裡釘住前端另外兩處
// （rules/frontend.md 38：nav／router／後端三處齊做；設定頁本身整頁 requiresAdmin）。
// 下載一定要走帶登入 token 的 Api.getBlob：用 <a href> 直連 API，瀏覽器不會帶 Authorization，只會拿到 401。
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', '..', 'public');
const app = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'pages', 'AdminSettings.js'), 'utf8');

test('備份區塊放在管理員設定頁，而那一頁的路由要求管理員', () => {
  const block = app.match(/path:\s*"\/admin\/settings",[\s\S]*?\}/);
  expect(block).not.toBeNull();
  expect(block[0]).toContain('window.UiNextAdminSettingsView');
  expect(block[0]).toMatch(/requiresAdmin:\s*true/);
  expect(page).toMatch(/v-show="settingsTab==='adv'" class="setting-block">\s*<div class="setting-block-head">\s*<div class="setting-block-title">平台資料庫備份<\/div>/);
});

test('下載走 Api.getBlob（帶登入 token），不是直接連到 API 的連結', () => {
  expect(page).toContain('Api.getBlob(`admin/backups/${encodeURIComponent(name)}/download`)');
  expect(page).not.toMatch(/href="[^"]*admin\/backups/);
});

test('區塊要看得到失敗原因與「太久沒有新備份」的警告（這台沒設任何通知管道）', () => {
  expect(page).toContain('backups.lastFailure.reason');
  expect(page).toContain('backups.latestAgeDays > 1');
});
