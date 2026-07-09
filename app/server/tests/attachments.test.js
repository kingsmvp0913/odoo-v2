const path = require('path');
const os = require('os');
const fs = require('fs');

let attachments;
let tmpRoot;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-upload-test-'));
  process.env.UPLOAD_DIR = tmpRoot;
  attachments = require('../lib/attachments');
});

afterAll(() => {
  delete process.env.UPLOAD_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('saveAttachmentFile 寫入磁碟並回傳相對路徑（含 task 子目錄）', () => {
  const relPath = attachments.saveAttachmentFile(42, 'hello.png', Buffer.from('fake-image-bytes'));
  expect(relPath).toMatch(/^task_42[\\/]/);
  expect(fs.existsSync(path.join(tmpRoot, relPath))).toBe(true);
});

test('saveAttachmentFile 清掉檔名中的危險字元', () => {
  const relPath = attachments.saveAttachmentFile(42, '../../etc/passwd', Buffer.from('x'));
  expect(relPath).not.toContain('..');
  expect(fs.existsSync(path.join(tmpRoot, relPath))).toBe(true);
});

test('readAttachmentFile 讀回 saveAttachmentFile 寫入的內容', () => {
  const relPath = attachments.saveAttachmentFile(7, 'note.txt', Buffer.from('內容測試'));
  const buf = attachments.readAttachmentFile(relPath);
  expect(buf.toString()).toBe('內容測試');
});

test('readAttachmentFile 拒絕逃逸 uploadRoot 的路徑', () => {
  expect(() => attachments.readAttachmentFile('../../../etc/passwd')).toThrow();
});

test('saveAttachmentFile 對惡意 taskId 也會清掉危險字元，不逃出 uploadRoot', () => {
  const relPath = attachments.saveAttachmentFile('../../evil', 'x.txt', Buffer.from('x'));
  expect(relPath).not.toContain('..');
  expect(fs.existsSync(path.join(tmpRoot, relPath))).toBe(true);
});
