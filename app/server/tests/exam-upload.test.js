const { sniffImage, decodeImage, isLocal, validateItem } = require('../lib/exam/upload');

const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

describe('sniffImage', () => {
  test('認得 jpg／png／webp', () => {
    expect(sniffImage(jpg)).toBe('jpg');
    expect(sniffImage(png)).toBe('png');
    expect(sniffImage(webp)).toBe('webp');
  });

  test('太短的一律不認', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  // RIFF 開頭不只 webp（wav 也是），要看第 8-11 byte
  test('RIFF 但不是 WEBP 的不認', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
    expect(sniffImage(wav)).toBeNull();
  });

  test('非 Buffer 不拋錯', () => {
    expect(sniffImage('not a buffer')).toBeNull();
    expect(sniffImage(null)).toBeNull();
  });
});

describe('decodeImage', () => {
  test('吃純 base64', () => {
    expect(decodeImage(jpg.toString('base64'))).toBeTruthy();
  });

  test('吃 data URI', () => {
    expect(decodeImage(`data:image/jpeg;base64,${jpg.toString('base64')}`)).toBeTruthy();
  });

  // 這是原專案實測踩過的坑：Buffer.from(s,'base64') 對非法字元不拋錯、默默跳過，
  // 一段中文字串也能「解碼成功」變成幾個 bytes 的垃圾。只檢查長度的話那題會被
  // 收下、排進佇列、燒一次 token，最後才由模型回一個讀不出來的空答案。
  test('中文字串不得被當成圖片收下', () => {
    expect(decodeImage('這是一段中文不是圖片')).toBeNull();
  });

  test('宣告成 image 但內容不是圖片的一律拒收', () => {
    const fake = Buffer.from('hello world this is not an image at all').toString('base64');
    expect(decodeImage(`data:image/png;base64,${fake}`)).toBeNull();
  });

  test('空值不拋錯', () => {
    expect(decodeImage('')).toBeNull();
    expect(decodeImage(null)).toBeNull();
    expect(decodeImage(undefined)).toBeNull();
  });
});

describe('isLocal', () => {
  // 判斷一律看 socket，**不可以看 header**——同網段誰都偽造得出來，
  // 等於把免驗證後門開放給整個網段
  test('loopback 算本機', () => {
    expect(isLocal({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
    expect(isLocal({ socket: { remoteAddress: '::1' } })).toBe(true);
    expect(isLocal({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true);
  });

  test('同網段的其他機器不算本機', () => {
    expect(isLocal({ socket: { remoteAddress: '10.0.0.5' } })).toBe(false);
    expect(isLocal({ socket: { remoteAddress: '192.168.1.20' } })).toBe(false);
  });

  test('偽造的 header 不影響判斷', () => {
    const req = {
      socket: { remoteAddress: '10.0.0.5' },
      headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
    };
    expect(isLocal(req)).toBe(false);
  });

  test('沒有 socket 不拋錯', () => {
    expect(isLocal({})).toBe(false);
    expect(isLocal(null)).toBe(false);
  });
});

describe('validateItem', () => {
  const good = { page: '3', answer: '第 1 題 B', image: jpg.toString('base64') };

  test('完整的項目通過', () => {
    expect(validateItem(good, 0)).toBeNull();
  });

  // 具名回報而非丟掉：同事一次丟 20 題，不該因為第 13 題漏填答案就整批重送
  test('缺 page 具名回報', () => {
    expect(validateItem({ ...good, page: '' }, 5)).toMatchObject({ index: 5, reason: expect.stringMatching(/page/) });
  });

  test('缺 answer 回報時帶上頁碼', () => {
    expect(validateItem({ ...good, answer: '' }, 2)).toMatchObject({ index: 2, page: '3' });
  });

  test('圖片壞掉具名回報', () => {
    expect(validateItem({ ...good, image: '不是圖片' }, 1))
      .toMatchObject({ index: 1, reason: expect.stringMatching(/圖片/) });
  });

  test('非物件不拋錯', () => {
    expect(validateItem(null, 0)).toMatchObject({ index: 0 });
  });
});
