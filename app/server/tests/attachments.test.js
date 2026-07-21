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

test('sniffFile 依 magic bytes 認出常見檔型與 mimetype', () => {
  const { sniffFile } = attachments;
  expect(sniffFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toEqual({ ext: '.png', mime: 'image/png' });
  expect(sniffFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ext: '.jpg', mime: 'image/jpeg' });
  expect(sniffFile(Buffer.from('GIF89a'))).toEqual({ ext: '.gif', mime: 'image/gif' });
  expect(sniffFile(Buffer.from('%PDF-1.7'))).toEqual({ ext: '.pdf', mime: 'application/pdf' });
  // WEBP: RIFF....WEBP
  expect(sniffFile(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]))).toEqual({ ext: '.webp', mime: 'image/webp' });
});

test('sniffFile 分辨 Office OpenXML（zip 內含 xl/ word/ ppt/）', () => {
  const { sniffFile } = attachments;
  const zip = ext => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml...' + ext)]);
  expect(sniffFile(zip('xl/workbook.xml')).ext).toBe('.xlsx');
  expect(sniffFile(zip('word/document.xml')).ext).toBe('.docx');
  expect(sniffFile(zip('ppt/presentation.xml')).ext).toBe('.pptx');
  // 純 zip 無 Office 標記 → 一般 zip
  expect(sniffFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22]))).toEqual({ ext: '.zip', mime: 'application/zip' });
});

test('sniffFile 認不出時回 octet-stream、無副檔名', () => {
  const { sniffFile } = attachments;
  expect(sniffFile(Buffer.from('random-junk'))).toEqual({ ext: '', mime: 'application/octet-stream' });
  expect(sniffFile(Buffer.alloc(0))).toEqual({ ext: '', mime: 'application/octet-stream' });
});

// 意圖：刪任務必須連帶清磁碟上的 task_<id> 目錄，否則實體上傳檔變孤兒永不回收、磁碟只增不減。
test('deleteTaskDir 刪掉整個 task 上傳目錄（含檔案）；不存在時不丟錯', () => {
  const rel = attachments.saveAttachmentFile(555, 'a.png', Buffer.from('x'));
  const dir = path.join(tmpRoot, 'task_555');
  expect(fs.existsSync(path.join(tmpRoot, rel))).toBe(true); // 前提：檔在
  attachments.deleteTaskDir(555);
  expect(fs.existsSync(dir)).toBe(false);                    // 目錄與檔都被清
  expect(() => attachments.deleteTaskDir(555)).not.toThrow(); // 再刪一次（已不存在）不炸
});

test('attachmentSize 回實際位元組數；0-byte 檔回 0', () => {
  const rel = attachments.saveAttachmentFile(99, 'data.bin', Buffer.from('12345'));
  expect(attachments.attachmentSize(rel)).toBe(5);
  const empty = attachments.saveAttachmentFile(99, 'empty.bin', Buffer.alloc(0));
  expect(attachments.attachmentSize(empty)).toBe(0);
  // 讀不到的路徑 best-effort 回 0
  expect(attachments.attachmentSize('task_99/nope.bin')).toBe(0);
});
