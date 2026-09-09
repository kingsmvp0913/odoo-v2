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

// 意圖：客戶從舊 ERP 匯出的還是大量 .xls／.doc，兩者 OLE2 檔頭一模一樣，只能靠內部 stream 名稱分辨。
// 認錯的症狀是使用者被擋在「格式不支援」，而檔案本身完全正常。
test('sniffFile 分辨 OLE2 的 .xls 與 .doc（靠 UTF-16LE 的 stream 名稱）', () => {
  const { sniffFile } = attachments;
  const ole = (streamName) => Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
    Buffer.from(streamName, 'utf16le')
  ]);
  expect(sniffFile(ole('Workbook'))).toEqual({ ext: '.xls', mime: 'application/vnd.ms-excel' });
  expect(sniffFile(ole('Book'))).toEqual({ ext: '.xls', mime: 'application/vnd.ms-excel' });
  expect(sniffFile(ole('WordDocument'))).toEqual({ ext: '.doc', mime: 'application/msword' });
  // OLE2 但認不出是哪一種（例：.msg 郵件）→ 不放行
  expect(sniffFile(ole('PowerPoint Document')).mime).toBe('application/octet-stream');
});

// 意圖：純文字類完全沒有 magic bytes，是唯一必須信副檔名的一類。這幾條守的是「信到什麼程度」——
// 副檔名對但內容是二進位一律不收，否則副檔名就成了繞過整套嗅測的後門。
test('resolveChatFile：純文字類靠副檔名＋內容判定，二進位偽裝成 .csv 一律不收', () => {
  const { resolveChatFile } = attachments;
  expect(resolveChatFile(Buffer.from('a,b,c\n1,2,3\n'), 'export.csv')).toEqual({ ext: '.csv', mime: 'text/csv' });
  expect(resolveChatFile(Buffer.from('2026-09-09 ERROR boom'), 'odoo.log')).toEqual({ ext: '.log', mime: 'text/plain' });
  expect(resolveChatFile(Buffer.from('<odoo><record/></odoo>'), 'views.xml')).toEqual({ ext: '.xml', mime: 'application/xml' });
  // 內容有 NUL＝二進位，副檔名說是 csv 也不收
  expect(resolveChatFile(Buffer.from([0x41, 0x00, 0x42, 0x43]), 'evil.csv')).toBeNull();
  // 沒列進清單的副檔名不收（.exe 這種）
  expect(resolveChatFile(Buffer.from('plain text'), 'run.exe')).toBeNull();
});

// 意圖：Big5 是台灣客戶匯出 CSV 的常見編碼。用嚴格 UTF-8 解碼驗會把它們全擋掉，
// 而使用者只會看到「格式不支援」，完全對不上真因。
test('isTextBuffer 接受非 UTF-8 的文字（Big5 位元組），拒絕含 NUL 的二進位', () => {
  const { isTextBuffer } = attachments;
  // Big5 的「測試」：B4 FA B8 D5，在 UTF-8 下是無效序列
  expect(isTextBuffer(Buffer.from([0xb4, 0xfa, 0xb8, 0xd5, 0x0a]))).toBe(true);
  expect(isTextBuffer(Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
  expect(isTextBuffer(Buffer.alloc(0))).toBe(false);
});

test('resolveChatFile：圖片與二進位文件走 magic bytes，zip 這類未開放的檔型不收', () => {
  const { resolveChatFile } = attachments;
  expect(resolveChatFile(Buffer.from('%PDF-1.7'), 'a.pdf').ext).toBe('.pdf');
  expect(resolveChatFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'shot.png').mime).toBe('image/png');
  const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('...xl/workbook.xml')]);
  expect(resolveChatFile(xlsx, 'report.xlsm').ext).toBe('.xlsx');   // .xlsm 與 .xlsx 同樣的 magic bytes
  // 一般 zip 沒開放：副檔名叫 .csv 也騙不過（magic bytes 先判定成 zip）
  expect(resolveChatFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22]), 'pack.csv')).toBeNull();
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
