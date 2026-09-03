const fs = require('fs');
const os = require('os');
const path = require('path');

describe('feedback 附件存檔', () => {
  let root, att;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-att-'));
    process.env.UPLOAD_DIR = root;
    jest.resetModules();
    att = require('../lib/attachments');
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.UPLOAD_DIR; });

  test('存進 feedback_<id>/ 並回傳相對路徑', () => {
    const rel = att.saveFeedbackAttachmentFile(7, 'shot.png', Buffer.from('x'));
    expect(rel.startsWith('feedback_7' + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(root, rel))).toBe(true);
  });

  test('deleteFeedbackDir 收掉整個目錄', () => {
    att.saveFeedbackAttachmentFile(8, 'a.png', Buffer.from('x'));
    att.deleteFeedbackDir(8);
    expect(fs.existsSync(path.join(root, 'feedback_8'))).toBe(false);
  });
});
