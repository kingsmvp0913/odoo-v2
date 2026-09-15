// 意圖：AI 產出的檔案靠「掛到 AI 那則回覆的 attachments」就出現下載按鈕，前端完全沒為此改碼。
// 這支守住那個前提——訊息列的附件區塊必須不分 role 都畫；哪天有人把它包進「只有使用者的訊息才畫」，
// 後端照樣全綠、檔案照樣收進 DB，畫面上 AI 做的檔卻一個按鈕都不見。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/ProjectChat.js'), 'utf8');

describe('UI Next 對話：AI 回覆的附件', () => {
  const start = src.indexOf('<article v-else :class="row.message.role">');
  const block = src.slice(start, src.indexOf('</article>', start));

  test('訊息列的附件區塊不以 role 過濾（AI 回覆帶附件也畫得出來）', () => {
    expect(start).toBeGreaterThan(-1);
    const filesDiv = block.slice(block.indexOf('ui-next-message-files') - 200, block.indexOf('ui-next-message-files'));
    expect(filesDiv).toContain('row.message.attachments');
    expect(filesDiv).not.toMatch(/role\s*[!=]==/);
  });

  test('非圖片畫下載按鈕、圖片畫縮圖', () => {
    expect(block).toContain('downloadAttachment(attachment.id,attachment.filename)');
    expect(block).toContain('isImageAttachment(attachment)');
  });

  // 附件是 AI 訊息寫進 DB「之後」才掛上的：輪詢可能先抓到沒附件的那則。後端靠 reply_pending 收完貨才清
  // 讓輪詢繼續；前端則必須把附件算進「訊息有沒有變」，否則下一 tick 內容相同就不更新，按鈕永遠不出現。
  test('輪詢會重載訊息，且「有沒有變」的比對含附件 id', () => {
    const poll = src.slice(src.indexOf('async pollReply()'), src.indexOf('async stopReply()'));
    expect(poll).toContain('loadMessages(');
    const load = src.slice(src.indexOf('async loadMessages('), src.indexOf('startReplyPolling() {'));
    expect(load).toMatch(/signature[\s\S]*message\.attachments[\s\S]*attachment\.id/);
  });
});
