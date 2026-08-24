const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Agent 管理的 View 載入失敗時，路由元件會是 undefined，使用者只會被導回任務列表；
// 靜態字串測試驗得到路由存在，卻驗不出這種整支腳本無法執行的失效。
test('AdminAgents.js 語法有效，能註冊 Agent 管理 View', () => {
  const file = path.join(__dirname, '../../public/js/views/AdminAgents.js');
  const source = fs.readFileSync(file, 'utf8');
  expect(() => new vm.Script(source, { filename: 'AdminAgents.js' })).not.toThrow();
});

test('桌機設定區固定隨捲動，窄螢幕改回單欄正常流動', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../public/js/views/AdminAgents.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../public/css/app.css'), 'utf8');
  expect(view).toContain('class="aa-editor"');
  expect(css).toContain('.aa-editor { position:sticky;top:var(--space-4);align-self:start }');
  expect(css).toContain('.aa-editor { position:static; }');
});
