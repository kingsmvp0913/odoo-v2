// 意圖：任務停在客服關（cs_reply_pending／cs_data_needed）時，留言框被客服面板取代——面板就是
// 唯一的輸入口。2026-09-17 回報「客服的時候沒辦法上傳圖片」：兩個面板都沒有迴紋針、沒綁 @paste，
// 按 Ctrl+V 什麼都不會發生，沒有錯誤也沒有提示。後端 multipart 測試全綠照樣抓不到這件事。
//
// 守三件事：每個面板都有入口（貼上＋選檔）、貼完看得到縮圖、送出時真的帶著檔案走 multipart。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/TaskDetail.js'), 'utf8');

function panel(mode) {
  const start = src.indexOf(`<template v-else-if="timelineActionMode==='${mode}'">`);
  const end = src.indexOf('<template v-else', start + 1);
  return start >= 0 && end > start ? src.slice(start, end) : '';
}
function method(name) {
  const start = src.indexOf(`async ${name}()`);
  return start >= 0 ? src.slice(start, src.indexOf('\n      },', start)) : '';
}

describe.each([
  ['cs_reply', 'csFollowupFiles', 'csFollowupSubmit', 'cs-followup'],
  ['cs_data', 'csDataFiles', 'csDataSubmit', 'cs-data-submit']
])('客服面板 %s 可附圖', (mode, key, submit, endpoint) => {
  const html = panel(mode);
  const body = method(submit);

  test('解析得到面板與送出函式（改名時不得靜默通過）', () => {
    expect(html).not.toBe('');
    expect(body).not.toBe('');
  });

  test('貼上與選檔兩個入口都有', () => {
    expect(html).toContain(`onPasteFiles($event,'${key}')`);
    expect(html).toMatch(new RegExp(`ref="${key}Input"\\s+type="file"`));
  });

  test('貼完看得到縮圖、可以移除', () => {
    expect(html).toContain(`${key}Previews[index]`);
    expect(html).toContain(`removeFileAt('${key}',index)`);
  });

  // 入口存在但送出不帶檔案＝裝飾品；走 JSON 的話圖直接消失
  test('送出時帶檔案走 multipart，送完清空', () => {
    expect(body).toContain(`this.${key}.forEach(f => fd.append('files', f))`);
    expect(body).toMatch(new RegExp(`Api\\.postForm\\(\`tasks/\\$\\{this\\.task\\.id\\}/${endpoint}\``));
    expect(body).toContain(`this.${key} = []`);
    expect(body).toContain(`this.$refs.${key}Input.value = ''`);
  });
});
