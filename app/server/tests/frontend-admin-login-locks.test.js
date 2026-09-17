// 意圖：登入鎖定要「看得到、解得掉」（2026-09-16 使用者要求）。後端行為在 login-guard.test.js；
// 這裡釘住前端三件事：使用者管理頁真的去讀鎖定清單、每個帳號看得到鎖定／封鎖狀態、而且解得開。
// 另外守配色硬規則：狀態標籤走既有 pill class，不得在 inline style 寫死淺色背景（深色模式會變隱形字）。
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'ui-next', 'pages', 'AdminUsers.js'), 'utf8'
);

test('頁面會去讀登入鎖定清單', () => {
  expect(page).toMatch(/Api\.get\(\s*['"]admin\/login-locks['"]\s*\)/);
});

test('每個帳號顯示被鎖定與被封鎖的來源數，且兩者分得出來', () => {
  expect(page).toMatch(/pill-warn/);
  expect(page).toMatch(/pill-danger/);
  expect(page).toMatch(/鎖定/);
  expect(page).toMatch(/封鎖/);
});

test('解除鎖定會帶 username 與 source（後端兩個都要）', () => {
  // 抓整個 unlock 方法體再斷言：用 /Api\.delete\([^)]*\)/ 會被 encodeURIComponent(...) 的
  // 右括號提早切斷，讓正確的實作被判成缺 source
  const m = page.match(/async unlock\(user\)[\s\S]*?\n      \},/);
  expect(m).not.toBeNull();
  expect(m[0]).toMatch(/Api\.delete/);
  expect(m[0]).toMatch(/login-locks/);
  expect(m[0]).toMatch(/username=/);
  expect(m[0]).toMatch(/source=/);
});

// 深色模式硬規則：寫死淺色背景又沒寫死文字色 → 文字吃 var(--text) 變白＝看不見
test('沒有在 inline style 寫死淺色背景', () => {
  const bad = page.match(/style="[^"]*background:\s*#(fff|f[0-9a-f]{2}|e[0-9a-f]{2})[^"]*"/gi) || [];
  expect(bad).toEqual([]);
});
