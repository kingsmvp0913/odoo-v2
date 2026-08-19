// 意圖：這個 repo 的前端沒有任何會跑起來的測試——後端 multipart 全綠、畫面卻沒有入口，
// 這種漏法半年都不會有人發現（clarify 閘門的附件入口就這樣漏過一次，見
// frontend-clarify-attachment.test.js）。這支用原始碼掃描守住對話上傳圖片在畫面上真的接得起來。
//
// 守的不是「有寫這幾行」，而是四件會靜默壞掉的事：
//   ① 送出路徑在有圖時必須改走 multipart（走 JSON 的話圖直接消失，後端只收到文字）
//   ② 縮圖必須走 objectURL（端點認證在 header，<img src="/api/..."> 只會拿到 401 破圖）
//   ③ 建出來的 objectURL 必須有人 revoke（不 revoke 就是每開一次對話漏一次記憶體）
//   ④ 送出按鈕的 disabled 條件必須認得「只有圖沒有字」（否則貼了圖卻按不下去）
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../public/js/views/ProjectChat.js'), 'utf8');

describe('對話上傳圖片：前端接線', () => {
  test('輸入列有檔案入口，且限定圖片', () => {
    expect(src).toMatch(/type="file"[^>]*accept="image\/\*"/);
    expect(src).toContain('onFilesSelected');
  });

  test('支援貼上截圖——這是對話裡傳圖最常走的路徑', () => {
    expect(src).toContain('@paste="onPaste"');
    expect(src).toMatch(/clipboardData/);
  });

  test('有圖時走 postForm，沒圖時維持既有 JSON 路徑', () => {
    const send = src.slice(src.indexOf('async send()'), src.indexOf('async toTask()'));
    expect(send).toContain('Api.postForm');
    expect(send).toContain('FormData');
    expect(send).toContain('Api.post(');   // 沒附圖的既有路徑沒有被換掉
  });

  test('送出條件認得「只有圖、沒有字」', () => {
    const send = src.slice(src.indexOf('async send()'), src.indexOf('async toTask()'));
    expect(send).toContain('pendingFiles.length');
    // 按鈕的 disabled 也要一起認，否則貼了圖按鈕仍是灰的
    expect(src).toMatch(/:disabled="sending \|\| \(!newInput\.trim\(\) && !pendingFiles\.length\)"/);
  });

  test('縮圖走 objectURL，不是把端點 URL 直接塞進 src', () => {
    expect(src).toContain('Api.getBlob');
    expect(src).toContain('URL.createObjectURL');
    // :src 一律綁到 objectURL（attachUrls / 預覽），不得出現直接組 api 路徑的 img
    expect(src).not.toMatch(/:src="[^"]*attachments\/[^"]*download/);
  });

  test('建出來的 objectURL 有回收，且元件卸載時會被呼叫', () => {
    expect(src).toContain('URL.revokeObjectURL');
    expect(src).toMatch(/beforeUnmount\(\)[^}]*revokeAllUrls\(\)/);
  });

  test('轉任務視窗可人工增減 AI 挑的圖，並把結果送給後端', () => {
    expect(src).toContain('taskDraft.attachments');
    expect(src).toContain('chat_attachment_ids');
    expect(src).toMatch(/type="checkbox" v-model="a\.chosen"/);
  });
});
