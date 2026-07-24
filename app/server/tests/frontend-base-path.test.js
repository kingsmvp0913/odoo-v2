const { basePathFrom } = require('../../public/js/base.js');

// 這支測試守的是「同一份前端在兩種前綴下都對」這個契約：本地跑在根路徑、伺服器掛在
// /odooAiDev/ 子路徑。前綴推導錯誤的症狀是資產 404 或 socket 連不上，且只在其中一邊出現。
describe('basePathFrom', () => {
  test('根路徑（Windows 本地 http://localhost:3939/）回傳 /', () => {
    expect(basePathFrom('http://localhost:3939/')).toBe('/');
  });

  test('子路徑（伺服器 /odooAiDev/）回傳含尾斜線的前綴', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/')).toBe('/odooAiDev/');
  });

  test('直接指到 index.html 時仍取得所屬目錄，不含檔名', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/index.html')).toBe('/odooAiDev/');
  });

  test('hash routing 的 fragment 不影響前綴（SPA 切畫面時前綴必須恆定）', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/#/task/5')).toBe('/odooAiDev/');
    expect(basePathFrom('http://localhost:3939/#/admin/users')).toBe('/');
  });

  test('setup.html 與 index.html 推出同一個前綴（兩頁共用同一支 base.js）', () => {
    expect(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/setup.html'))
      .toBe(basePathFrom('https://web-test.ideaxpress.biz/odooAiDev/'));
  });
});

const fs = require('fs');
const path = require('path');
const readPublic = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

// 靜態守門：root-absolute 的資產路徑在本地（前綴 '/'）永遠正常，只有在子路徑部署時才會 404。
// 本機測不出來，所以用掃描把它擋在 commit 前。
describe('HTML 資產路徑不得為 root-absolute', () => {
  test.each(['index.html', 'styleguide.html'])('%s', (file) => {
    const offenders = readPublic(file).match(/(?:src|href|action)="\/[^"]*"/g) || [];
    expect(offenders).toEqual([]);
  });

  test('index.html 於所有其他 script 之前載入 base.js', () => {
    const html = readPublic('index.html');
    expect(html).toContain('<script src="js/base.js"></script>');
    expect(html.indexOf('js/base.js')).toBeLessThan(html.indexOf('js/api.js'));
  });
});

// socket.io client 的 path 選項只接受絕對路徑字串（無法用相對路徑），這是 BASE_PATH 必須以
// 全域變數存在、而不能只靠相對 URL 解析的主因。漏掉它的症狀是 websocket 握手 404 後靜默
// 退回 polling——功能看起來正常，只是即時通知變慢，不會有錯誤訊息。
describe('前端請求路徑接上 BASE_PATH', () => {
  test.each([
    ['js/api.js'],
    ['js/socket.js'],
    ['js/views/TaskDetail.js'],
  ])('%s 不得有 root-absolute 的 /api 或 /socket.io', (file) => {
    const offenders = readPublic(file).match(/['"`]\/(api|socket\.io)\//g) || [];
    expect(offenders).toEqual([]);
  });

  test('api.js 兩處 fetch 皆以 BASE_PATH 開頭', () => {
    const src = readPublic('js/api.js');
    expect(src.match(/fetch\(`\$\{BASE_PATH\}api\//g)).toHaveLength(2);
  });

  test('socket.js 明示 path 選項（否則 socket.io 會用預設的 /socket.io）', () => {
    expect(readPublic('js/socket.js')).toContain("path: BASE_PATH + 'socket.io'");
  });
});
