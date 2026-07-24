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
const publicDir = path.join(__dirname, '../../public');
const readPublic = (f) => fs.readFileSync(path.join(publicDir, f), 'utf8');

// 走訪 app/public 全樹取代寫死清單：寫死清單只會涵蓋「當初改到的那幾支檔案」，
// 之後任何人新增 view 檔（例如 ProjectChat.js 之外的下一支）都不會被掃到，防線形同虛設。
// vendor/ 是第三方 bundle、不歸我們管，排除。
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.name === 'vendor' ? [] :
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const allPublicFiles = walk(publicDir).map((f) => path.relative(publicDir, f));
const htmlFiles = allPublicFiles.filter((f) => f.endsWith('.html'));
const jsFiles = allPublicFiles.filter((f) => f.endsWith('.js'));

// 靜態守門：root-absolute 的資產路徑在本地（前綴 '/'）永遠正常，只有在子路徑部署時才會 404。
// 本機測不出來，所以用掃描把它擋在 commit 前。
describe('HTML 資產路徑不得為 root-absolute', () => {
  test.each(htmlFiles)('%s', (file) => {
    // 單雙引號皆須接受：現有 HTML 全用雙引號只是慣例，不是保證，regex 若只認雙引號就不是真掃描。
    const offenders = readPublic(file).match(/(?:src|href|action)=["']\/[^"']*["']/g) || [];
    expect(offenders).toEqual([]);
  });

  test('index.html 於所有其他 script 之前載入 base.js（斷言比對「第一個 <script src=」的 src 屬性本身，而非只挑 api.js 當代表——base.js 若排在 store.js 之後、api.js 之前，舊斷言照樣綠燈）', () => {
    const html = readPublic('index.html');
    const firstScriptSrc = html.match(/<script src="([^"]+)">/)[1];
    expect(firstScriptSrc).toBe('js/base.js');
  });
});

// socket.io client 的 path 選項只接受絕對路徑字串（無法用相對路徑），這是 BASE_PATH 必須以
// 全域變數存在、而不能只靠相對 URL 解析的主因。漏掉它的症狀是 websocket 握手 404 後靜默
// 退回 polling——功能看起來正常，只是即時通知變慢，不會有錯誤訊息。
describe('前端請求路徑接上 BASE_PATH', () => {
  test.each([...htmlFiles, ...jsFiles])('%s 不得有 root-absolute 的 /api 或 /socket.io', (file) => {
    // 邊界斷言取代強制尾斜線：原本的 `\/` 要求 api／socket.io 後面一定接斜線，
    // 沒有尾段的裸 `/api`（例如接 `?query` 或直接收尾在引號前）會被漏判。
    const offenders = readPublic(file).match(/['"`]\/(api|socket\.io)(?=[/'"`?])/g) || [];
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

// setup.html 是獨立頁面（不載入 SPA 的 js），但仍載入同一支 base.js，避免同一段推導邏輯
// 出現第二份。它的兩處 location.replace('/') 在子路徑下會把人踢到 web-test 的網站根目錄
// ——那是別的應用，不是平台首頁。
describe('setup.html', () => {
  test('載入 base.js', () => {
    expect(readPublic('setup.html')).toContain('<script src="js/base.js"></script>');
  });

  // index.html 所有 BASE_PATH 用法都包在函式內、runtime 才求值，此時 script 早已載完，順序不 load-bearing。
  // setup.html 相反：頂層 script block 的 fetch(`${BASE_PATH}...`) 在 <script> 執行當下就立即求值。
  // base.js 若排在它後面，第一行就 ReferenceError；setup() 因函式提升仍在，但按下按鈕會在另一處
  // 同樣炸掉，async rejection 無人接手——畫面停在「設定中...」、按鈕永久 disabled，沒有任何錯誤提示。
  test('base.js 必須先於頂層 script 內第一個 BASE_PATH 用法載入，否則初始設定頁會靜默卡死', () => {
    const html = readPublic('setup.html');
    expect(html.indexOf('js/base.js')).toBeLessThan(html.indexOf('${BASE_PATH}'));
  });

  test('兩處 fetch 皆接上 BASE_PATH', () => {
    const src = readPublic('setup.html');
    expect(src.match(/fetch\(`\$\{BASE_PATH\}api\//g)).toHaveLength(2);
    expect(src.match(/fetch\(['"]\/api\//g)).toBeNull();
  });

  test('完成設定後導回平台首頁而非網站根目錄', () => {
    const src = readPublic('setup.html');
    expect(src.match(/location\.replace\(BASE_PATH\)/g)).toHaveLength(2);
    expect(src.match(/location\.replace\(['"]\/['"]\)/g)).toBeNull();
  });
});
