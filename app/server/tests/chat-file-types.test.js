// 意圖：對話可收的檔型有兩份清單——後端 lib/attachments.js（真正的把關）與前端
// public/js/chat-file-types.js（<input accept>、貼上、拖放的把關）。兩份漂移的症狀特別難查：
// 檔案挑得到、送出被後端打回，而畫面上只有一句泛用錯誤，完全指不出是格式不合；反過來
// 前端多列一個後端不收的，使用者就是傳一次失敗一次。
//
// 前端那份是給瀏覽器吃的 classic script（掛 window，沒有 module.exports），所以這裡用
// 假的 window 跑一次再取值——不能直接 require。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const server = require('../lib/attachments');

function loadFrontendTypes() {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/chat-file-types.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.CHAT_FILE_TYPES;
}

describe('對話附件檔型清單：前後端同步', () => {
  const front = loadFrontendTypes();

  test('副檔名清單兩邊完全一致', () => {
    expect([...front.exts].sort()).toEqual([...server.CHAT_ACCEPT_EXTS].sort());
  });

  test('accept 字串一致（前端 <input accept> 直接用它）', () => {
    expect(front.accept.split(',').sort()).toEqual(server.CHAT_ACCEPT.split(',').sort());
    expect(front.accept).toContain('image/*');
  });

  test('大小與張數上限一致', () => {
    expect(front.maxBytes).toBe(server.CHAT_FILE_MAX);
    expect(front.maxFiles).toBe(5);   // multer 的 limits.files 與 array('files', 5) 都寫死 5
  });

  // 這幾個是使用者實際會傳的：辦公室文件、ERP 匯出、除錯用的 log。少一個就是「傳不上來」。
  test('辦公室／ERP 常見格式都在清單內', () => {
    for (const ext of ['.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.txt', '.log', '.xml']) {
      expect(server.CHAT_ACCEPT_EXTS).toContain(ext);
    }
  });
});

describe('前端 allows()：與後端把關的判準一致', () => {
  const front = loadFrontendTypes();

  test('圖片看 MIME，其餘看副檔名（瀏覽器對 .log／.po 常回空字串的 type）', () => {
    expect(front.allows({ name: 'shot.png', type: 'image/png' })).toBe(true);
    expect(front.allows({ name: 'odoo.log', type: '' })).toBe(true);
    expect(front.allows({ name: '報表.XLSX', type: '' })).toBe(true);   // 副檔名大小寫不該影響
    expect(front.allows({ name: 'run.exe', type: 'application/x-msdownload' })).toBe(false);
    expect(front.allows(null)).toBe(false);
  });

  test('isImage 只認圖片——非圖片建 objectURL 是白佔記憶體，而且 <img> 會畫成破圖', () => {
    expect(front.isImage({ name: 'a.png', type: 'image/png' })).toBe(true);
    expect(front.isImage({ name: 'a.xlsx', type: 'application/vnd.ms-excel' })).toBe(false);
  });
});
