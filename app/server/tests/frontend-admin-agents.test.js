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

// 意圖：左邊 32 個 agent 讓整頁 3100px 以上，往下捲去點下面的 agent 時，右邊的編輯區必須留在
// 畫面上。這靠 app.css 的 `.aa-editor { position:sticky }`——但那條在 ui-next 外殼下曾經**整條
// 失效**（實測 sticky 與 static 捲到底位置差 0px），因為 app.css 的 `.content{overflow-y:auto}`
// 夾在中間當了 sticky 的捲動祖先，而 ui-next 真正在捲的是 .ui-next-main。
// 所以這兩條規則是一組的，少任何一條功能就是死的——只驗 sticky 那條會在功能已經壞掉時全綠，
// 這正是這支測試上一版犯的錯。
test('Agent 管理右欄要跟著捲動留在畫面上：sticky 與它的捲動祖線解法必須成對存在', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../public/js/views/AdminAgents.js'), 'utf8');
  const next = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/AdminAgents.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../public/css/app.css'), 'utf8');
  const adminCss = fs.readFileSync(path.join(__dirname, '../../public/css/ui-next-pages/07-admin.css'), 'utf8');
  // 兩套外殼共用 app.css 的 .aa-editor，都要掛得到 class 才受規則影響。
  expect(view).toContain('class="aa-editor"');
  expect(next).toContain('class="aa-editor"');

  // 比對規則內容而非整行字面，換寫法（順序、拆條、加斷點）不該讓這支紅。
  const sticky = [...css.matchAll(/\.aa-editor\s*\{([^}]*)\}/g)]
    .filter(m => /position\s*:\s*sticky/.test(m[1]));
  expect(sticky.length).toBeGreaterThan(0);

  // ui-next 外殼要把 .content 的 overflow 讓開，否則上面那條 sticky 是死碼。
  expect(adminCss).toMatch(/\.content:has\(>\s*\.aa-layout\)\s*\{[^}]*overflow\s*:\s*visible/);
});
